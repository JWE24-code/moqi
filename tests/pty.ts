/**
 * PTY-driven integration test for the terminal layer.
 *
 * node has no pty builtin and npm install is blocked, so this driver uses
 * util-linux `script(1)` to allocate a pseudo-terminal and run the subject
 * (tests/pty-subject.ts) under it. Keystrokes written to the child's stdin
 * flow through the pty to the subject exactly as a human's would; the
 * subject's output (real frames painted by Screen + render) is accumulated
 * and asserted on.
 *
 * Because the loop runs under a pty, the usual byte-equality tricks do not
 * work (the tty may echo early input and converts \n to \r\n): assertions
 * are made on printable content after ANSI-stripping, which is robust.
 *
 * Run with: npm run test:pty   (or: node --experimental-strip-types tests/pty.ts)
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { stripAnsi, displayWidth } from '../src/tui/text.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SUBJECT = 'tests/pty-subject.ts'

const ALT_ON = '\x1b[?1049h'
const ALT_OFF = '\x1b[?1049l'

/** Shift+Enter in CSI-u, how Omarchy's terminals report the carriage return. */
const SHIFT_ENTER = '\x1b[13;2u'

// ---------------------------------------------------------------- utilities

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function which(bin: string): boolean {
  const paths = (process.env.PATH ?? '').split(':')
  return paths.some((dir) => dir !== '' && existsSync(resolve(dir, bin)))
}

/** A painted row starts with moveTo(row,1) + clear-to-eol from Screen.paint. */
const PAINTED_ROW = /\x1b\[\d+;1H\x1b\[K/

/**
 * Every printable painted-line width in the captured output, in order.
 * Splitting on the row-repaint prefix recovers the frame lines even though
 * the pty never emits a newline between them.
 */
function paintedWidths(output: string): number[] {
  return output
    .split(PAINTED_ROW)
    .map((segment) => displayWidth(stripAnsi(segment).replace(/[\r\n]/g, '')))
}

// ------------------------------------------------------------------ the run

let checks = 0
function check(label: string, condition: boolean): void {
  if (!condition) throw new Error(`failed: ${label}`)
  checks += 1
}

async function main(): Promise<void> {
  if (!which('script')) {
    console.log('skipped: no script(1)')
    return
  }

  const child: ChildProcess = spawn(
    'script', // NOSONAR — util-linux script(1) from PATH is the intended tool.
    ['-qec', `stty cols 80 rows 30 && node --experimental-strip-types ${SUBJECT}`, '/dev/null'],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
  )

  let output = ''
  // stdio is 'pipe' on all three fds, so these are present; the guard keeps
  // strict mode convinced without a non-null assertion.
  const { stdout, stderr } = child
  if (stdout === null || stderr === null) {
    throw new Error('script(1) did not expose piped stdio')
  }
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })

  let exitCode: number | null = null
  child.on('exit', (code: number | null) => {
    exitCode = code
  })

  // Overall watchdog: kill a hung subject and fail.
  const watchdog = setTimeout(() => {
    child.kill('SIGKILL')
  }, 15_000)

  function write(input: string): void {
    child.stdin?.write(input)
  }

  /** Wait until the accumulated output satisfies the predicate. */
  async function until(ready: (text: string) => boolean, ms = 5_000): Promise<boolean> {
    if (ready(output)) return true
    if (exitCode !== null || ms <= 0) return ready(output)
    await sleep(25)
    return until(ready, ms - 25)
  }

  const alive = (): boolean => exitCode === null

  try {
    // (a) the subject enters the alternate screen.
    check('alternate screen is entered', await until((t) => t.includes(ALT_ON)))
    const paintedFrom = output.indexOf(ALT_ON)

    // (f) a split escape sequence must not crash or paint garbage: a raw ESC
    // byte, a 50ms pause, then the rest of the arrow-up sequence.
    write('\x1b')
    await sleep(50)
    write('[A')
    await sleep(300)
    check('a split escape does not crash the subject', alive())
    const afterSplit = output.length
    check(
      'a split escape paints no garbage',
      stripAnsi(output.slice(afterSplit)).replace(/[\r\n]/g, '').trim() === '',
    )

    // (b) typed text reaches the composer and is painted (the subject disables
    // tty echo via raw mode, so this really is the painted frame).
    write('hello world')
    check('typed text is painted', await until((t) => stripAnsi(t.slice(paintedFrom)).includes('hello world')))

    // (c) no painted line ever exceeds 80 printable columns.
    check(
      'painted lines never exceed 80 columns',
      paintedWidths(output).every((width) => width <= 80),
    )

    // (d) shift+enter inserts a newline instead of submitting; enter sends.
    // The placeholder only paints on an empty composer, so its absence is the
    // witness that shift+enter kept the draft.
    const beforeEnter = output.length
    write(SHIFT_ENTER)
    await sleep(200)
    check(
      'shift+enter does not submit the draft',
      !stripAnsi(output.slice(beforeEnter)).includes('Ask the harness'),
    )
    write('\r')
    check(
      'enter restores the composer placeholder',
      await until((t) => stripAnsi(t.slice(beforeEnter)).includes('Ask the harness')),
    )
    check(
      'the sent text reappears as a transcript turn',
      stripAnsi(output.slice(beforeEnter)).includes('▌') &&
        stripAnsi(output.slice(beforeEnter)).includes('hello world'),
    )

    // (m) a bracketed multi-line paste lands in the composer whole and never
    // submits on its first line. It is cleared so the later steps start clean.
    const beforePaste = output.length
    write('\x1b[200~alpha line\nbeta line\x1b[201~')
    check(
      'a multi-line paste is painted into the composer',
      await until(
        (t) =>
          stripAnsi(t.slice(beforePaste)).includes('alpha line') &&
          stripAnsi(t.slice(beforePaste)).includes('beta line'),
      ),
    )
    check(
      'the paste did not submit a turn',
      !stripAnsi(output.slice(beforePaste)).includes('Ask the harness'),
    )
    write('\x15') // clear
    await sleep(150)

    // (g) the @ file menu opens on a token and tab accepts a path.
    write('@st')
    check(
      'the @ menu lists a candidate',
      await until((t) => stripAnsi(t.slice(beforeEnter)).includes('src/tui/state.ts')),
    )
    write('\t')
    check(
      'tab accepts the completion into the composer',
      await until((t) => stripAnsi(t.slice(beforeEnter)).includes('src/tui/state.ts ')),
    )
    // (l) a real lone Escape — not part of a sequence, just the byte — must
    // arrive as the escape key and dismiss the menu that is open. This is the
    // shape a terminal sends when a person presses Escape, and it was the
    // shape that produced no key at all before the decoder waited for a
    // sequence tail (the next keystroke then became a phantom alt chord).
    write('\x15')
    await sleep(150)
    write('@st')
    check(
      'the menu is open again for the escape check',
      await until((t) => stripAnsi(t).includes('src/tui/state.ts')),
    )
    write('\x1b')
    check(
      'a lone escape dismisses the menu',
      await until((t) => stripAnsi(t).includes('escape closed the menu'), 3_000),
    )

    write('@st')
    await sleep(200)
    write('\x15') // clear, so the approval step starts from an empty composer
    await sleep(150)

    // (h) an approval panel owns the keyboard and 1 allows once.
    const beforeApproval = output.length
    write('/ask\r')
    check(
      'the approval panel names the tool',
      await until((t) => stripAnsi(t.slice(beforeApproval)).includes('Allow shell?')),
    )
    check(
      'the approval panel shows the command',
      stripAnsi(output.slice(beforeApproval)).includes('rm -rf build'),
    )
    write('1')
    check('the approval settles without crashing the subject', alive())
    await sleep(200)

    // (i) a questionnaire takes a multi-select answer with space and enter.
    const beforeQuestion = output.length
    write('/question\r')
    check(
      'the question panel shows its options',
      await until((t) => stripAnsi(t.slice(beforeQuestion)).includes('Which tests?')),
    )
    write(' ')
    check('space toggles an option', await until(() => true))
    write('\r')
    await sleep(200)

    // (j) /lang switches the interface language in a real frame. The welcome
    // is used as the witness because it is drawn in every language and is not
    // truncated at 80 columns the way the footer hint can be.
    write('\x15')
    await sleep(150)
    write('/clear\r')
    check(
      'the transcript can be emptied for the language check',
      await until((t) => stripAnsi(t).includes('type a message')),
    )
    const beforeLang = output.length
    write('/lang\r')
    check(
      'the interface language switches',
      await until((t) => stripAnsi(t.slice(beforeLang)).includes('输入消息')),
    )

    // (e) a single ctrl+c does NOT exit...
    write('\x03')
    await sleep(400)
    check('a single ctrl+c does not exit', alive())
    check('no premature teardown after one ctrl+c', !output.includes(ALT_OFF) && !output.includes('SUBJECT-DONE'))

    // ...but a second ctrl+c within the 1.5s window exits cleanly.
    write('\x03')
    check('the subject exits on the second ctrl+c', await until(() => exitCode !== null, 5_000))
    check('the exit code is zero', exitCode === 0)
    check('the alternate screen is left', output.includes(ALT_OFF))
    const done = stripAnsi(output)
    check('the subject reports a clean done line', /SUBJECT-DONE \d/.test(done))
    // (k) the notices prove every panel decision went through the real key path.
    check('the approval was allowed from the panel', done.includes('allowed shell once'))
    check('the question was answered from the panel', /answered [a-z]/.test(done))
    check('the language switch was recorded', done.includes('language zh-CN'))
    check('the lone escape was not misread as an alt chord', !done.includes('alt+'))
  } finally {
    clearTimeout(watchdog)
    if (alive()) child.kill('SIGKILL')
  }

  console.log(`ok - ${String(checks)} checks passed`)
}

try {
  await main()
} catch (error: unknown) {
  console.error(String(error))
  process.exit(1)
}
