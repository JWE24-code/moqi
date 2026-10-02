/**
 * Complete functionality test: the whole interactive surface, driven the way
 * a user drives it.
 *
 * This is the pty integration walk (see pty.ts for the transport) taken to
 * every seam the subject exposes: the composer's editing keys, submitting,
 * the @-file completion, every command the subject answers (/clear, /ask,
 * /question, /lang, /theme), the trust-surface panels (approval and
 * question, each of their outcomes), the picker (paint, navigate, choose,
 * dismiss), the notice/status channel, and the two-step quit with a clean
 * terminal restore.
 *
 * Keystrokes go to a real pseudo-terminal; assertions are on printable,
 * ANSI-stripped painted frames, so what passes here is what a person sees.
 *
 * Run with: node --experimental-strip-types tests/functional.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { stripAnsi, displayWidth } from '../src/tui/text.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SUBJECT = 'tests/pty-subject.ts'

const ALT_ON = '\x1b[?1049h'
const ALT_OFF = '\x1b[?1049l'
const SHIFT_ENTER = '\x1b[13;2u'
const PAINTED_ROW = /\x1b\[\d+;1H\x1b\[K/

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function which(bin: string): boolean {
  const paths = (process.env.PATH ?? '').split(':')
  return paths.some((dir) => dir !== '' && existsSync(resolve(dir, bin)))
}

function paintedWidths(output: string): number[] {
  return output
    .split(PAINTED_ROW)
    .map((segment) => displayWidth(stripAnsi(segment).replace(/[\r\n]/g, '')))
}

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
  const { stdout, stderr } = child
  if (stdout === null || stderr === null) throw new Error('script(1) did not expose piped stdio')
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
  const watchdog = setTimeout(() => {
    child.kill('SIGKILL')
  }, 30_000)

  function write(input: string): void {
    child.stdin?.write(input)
  }
  async function until(ready: (text: string) => boolean, ms = 5_000): Promise<boolean> {
    if (ready(output)) return true
    if (exitCode !== null || ms <= 0) return ready(output)
    await sleep(25)
    return until(ready, ms - 25)
  }
  const alive = (): boolean => exitCode === null
  /** The painted, printable screen content so far. */
  const seen = (): string => stripAnsi(output)
  async function sees(text: string, ms?: number): Promise<boolean> {
    return until((t) => stripAnsi(t).includes(text), ms)
  }
  /**
   * Painted output after `mark`. The buffer only ever grows, so any
   * "it is gone now" assertion must look at the frames painted since.
   */
  const since = (mark: number): string => stripAnsi(output.slice(mark))

  /** Type a draft and submit it. */
  async function submit(line: string): Promise<void> {
    write(line)
    await sleep(120)
    write('\r')
    await sleep(150)
  }

  try {
    // ------------------------------------------------------------ boot
    check('alternate screen is entered', await until((t) => t.includes(ALT_ON)))
    const paintedFrom = output.indexOf(ALT_ON)
    check('the frame paints the host line', await sees('local harness'))
    check('the model name is on screen', await sees('deepseek-chat'))
    check('the footer hints at the composer', await sees('/ for commands'))

    // ------------------------------------------------------- composing
    write('hello world')
    check('typed text is painted', await sees('hello world'))
    const beforeClear = output.length
    write('\x15') // ctrl+u clears the line
    await sleep(150)
    check('ctrl+u clears the draft', !since(beforeClear).includes('hello world'))

    write('second draft')
    await sleep(120)
    write('\x01') // ctrl+a -> home
    write('X')
    await sleep(120)
    check('ctrl+a then a character edits at the start', await sees('Xsecond draft'))
    write('\x05') // ctrl+e -> end
    await sleep(80)
    const beforeWord = output.length
    write('\x17') // ctrl+w -> delete word back
    await sleep(150)
    check('ctrl+w deletes the last word', !since(beforeWord).includes('Xsecond'))

    // --------------------------------------------------------- newlines
    write('\x1b[13;2u') // shift+enter (CSI-u) inserts a newline
    await sleep(100)
    write('and more')
    await sleep(120)
    check('shift+enter keeps the draft open', alive() && !seen().includes('SUBJECT-DONE'))

    // -------------------------------------------------------- @-files
    write(' ')
    await sleep(80)
    write('@stat')
    await sleep(250)
    check('the @ menu offers a matching file', await sees('state.ts'))
    const beforeTab = output.length
    write('\t')
    await sleep(250)
    check('tab accepts the completion', since(beforeTab).includes('src/tui/state.ts') && !since(beforeTab).includes('@stat'))

    // ------------------------------------------------------- submitting
    write('\r')
    check('the draft lands as a user turn', await sees('and more'))
    check('the accepted path rides along in the turn', seen().includes('src/tui/state.ts'))
    await submit('plain text prompt')
    check('a plain enter submits the prompt', await sees('plain text prompt'))
    check(
      'painted lines never exceed 80 columns',
      paintedWidths(output).every((width) => width <= 80),
    )

    // -------------------------------------------------------- commands
    await submit('/nope')
    check('an unknown command is reported', await sees('unknown command'))

    const beforeClear2 = output.length
    await submit('/clear')
    check('/clear empties the transcript', !since(beforeClear2).includes('plain text prompt'))

    await submit('/lang')
    check('/lang reports the interface language', await sees('language zh-CN'))

    // ---------------------------------------------------- approval flow
    await submit('/ask')
    check('the approval panel paints its title (localized)', await sees('允许'))
    check('the approval panel names the command', await sees('rm -rf build'))
    write('1')
    check('allow-once answers the ask', await sees('allowed'))

    await submit('/ask')
    check('the approval panel returns for a second ask', await sees('允许'))
    write('2')
    await sleep(300)
    // The screen paints diffs, so a repaint of an otherwise identical footer
    // carries only the cells that changed: assert on the word that changed.
    check('deny answers the ask', await sees('denied'))

    await submit('/ask')
    write('\x1b') // esc denies — fail closed
    await sleep(80) // the decoder holds a lone escape for 50ms; let it settle
    check('esc denies the ask', await sees('denied'))

    // ---------------------------------------------------- question flow
    await submit('/question')
    check('the question panel paints', await sees('Which tests?'))
    write(' ') // toggle the cursor row on
    await sleep(150)
    write('\x1b[B') // down to the next option
    await sleep(150)
    write(' ') // and toggle that one on too
    await sleep(150)
    const beforeAnswer = output.length
    write('\r')
    await sleep(300)
    check('the multi-select answer arrives', await sees('answered'))

    await submit('/question')
    check('the question panel reopens', await sees('Which tests?'))
    write('\x1b')
    check('esc cancels the question', await sees('cancelled the question'))

    // ----------------------------------------------------- picker flow
    await submit('/theme')
    check('the picker paints its title', await sees('Themes'))
    check('the picker lists its rows', await sees('Dark') && seen().includes('Light'))
    write('\x1b[B') // down
    await sleep(150)
    write('\r')
    check('enter chooses the highlighted row', await sees('theme → light'))

    await submit('/theme')
    check('the picker reopens', await sees('Themes'))
    write('\x1b')
    check('esc dismisses the picker', await sees('closed the picker'))

    // --------------------------------------------------------- the exit
    write('\x03') // ctrl+c arms the quit
    await sleep(150)
    check('the first ctrl+c only arms', alive())
    write('\x03')
    check('the second ctrl+c quits', await until(() => !alive() || seen().includes('SUBJECT-DONE'), 5_000))
    check('the subject leaves the alt screen', await until((t) => t.includes(ALT_OFF), 5_000))
    check('the process exits', await until(() => exitCode !== null, 5_000))
    check('the exit is clean', exitCode === 0)
    // Diffed repaints write partial rows (a few changed cells without a
    // clear-to-eol), and those leftovers concatenate across frames — so the
    // honest width check is per full-row repaint: each segment that begins
    // right after a row clear is one line of one frame.
    const painted = output.slice(0, output.lastIndexOf(ALT_OFF))
    const rows = painted
      .split(/\x1b\[\d+;1H/)
      .filter((segment) => segment.startsWith('\x1b[K'))
      .map((segment) => displayWidth(stripAnsi(segment).replace(/[\r\n]/g, '')))
    const tooWide = rows.filter((width) => width > 80)
    check(
      'painted lines stayed inside 80 columns for the whole run',
      rows.every((width) => width <= 80),
    )
  } finally {
    clearTimeout(watchdog)
    if (exitCode === null) child.kill('SIGKILL')
  }

  console.log(`ok - ${String(checks)} functional checks passed`)
}

main().catch((error: unknown) => {
  console.error(String(error))
  process.exit(1)
})
