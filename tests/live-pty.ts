/**
 * Live end-to-end test: a real agent turn driven through the real TUI.
 *
 * This boots `dsh --profile tui` under a pseudo-terminal, types a prompt, and
 * waits for the model's answer to appear in a painted frame — the one thing
 * the offline suites cannot prove, because they never touch a provider.
 *
 * It needs working credentials and costs a model call, so it is NOT part of
 * `npm test`; run it deliberately:
 *
 *   MOQI_LIVE=1 npm run test:live
 *
 * Any failure still exits non-zero, so it can gate a release rather than only
 * print.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { stripAnsi } from '../src/tui/text.ts'

const ROOT = resolve(import.meta.dirname, '..')
const PROFILE = process.env['MOQI_LIVE_PROFILE'] ?? 'tui'
/**
 * The marker must not be derivable from the prompt.
 *
 * `output` is the raw pty stream, and every character typed into the composer
 * echoes into it — so a marker quoted in the prompt ("reply with exactly:
 * READY") is already present in the stream before the model has answered
 * anything. That is not a hypothetical: it let a blank-prompt bug pass this
 * suite, where the composer was cleared before the draft was read, the
 * transcript committed an empty turn, and the model was asked nothing at all.
 * Asking for a word the prompt never spells means the marker can only have
 * come back from the model, which in turn proves the prompt reached it.
 */
const PROMPT =
  process.env['MOQI_LIVE_PROMPT'] ?? 'reply with exactly one word: the number after three, spelled out in capitals'
const MARKER = process.env['MOQI_LIVE_EXPECT'] ?? 'FOUR'
const TIMEOUT_MS = Number.parseInt(process.env['MOQI_LIVE_TIMEOUT_MS'] ?? '180000', 10)

let checks = 0
function check(label: string, condition: boolean): void {
  if (!condition) throw new Error(`failed: ${label}`)
  checks += 1
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function which(bin: string): boolean {
  return (process.env.PATH ?? '')
    .split(':')
    .some((dir) => dir !== '' && existsSync(resolve(dir, bin)))
}

async function main(): Promise<void> {
  if (process.env['MOQI_LIVE'] !== '1') {
    console.log('skipped: set MOQI_LIVE=1 to run the live model round trip')
    return
  }
  if (!which('script')) {
    console.log('skipped: no script(1)')
    return
  }

  const child: ChildProcess = spawn(
    'script', // NOSONAR — util-linux script(1) from PATH is the intended tool.
    ['-qec', `stty cols 110 rows 34 && dsh --profile ${PROFILE}`, '/dev/null'],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
  )

  let output = ''
  let exitCode: number | null = null
  const { stdout, stderr } = child
  if (stdout === null || stderr === null) throw new Error('script(1) exposed no stdio')
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  child.on('exit', (code: number | null) => {
    exitCode = code
  })

  const watchdog = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS + 30_000)

  async function until(ready: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (ready()) return true
      await sleep(100)
    }
    return ready()
  }

  try {
    check('the app enters the alternate screen', await until(() => output.includes('\x1b[?1049h'), 30_000))
    check('the app settles on a frame', await until(() => stripAnsi(output).includes('Ask the harness'), 30_000))

    // Type the prompt and send it. A real turn begins here.
    child.stdin?.write(PROMPT)
    await sleep(300)
    child.stdin?.write('\r')

    const answered = await until(
      () => stripAnsi(output).includes(MARKER),
      TIMEOUT_MS,
    )
    if (!answered) {
      const tail = stripAnsi(output).slice(-2000)
      console.error('--- last output before giving up ---')
      console.error(tail)
    }
    // Because the marker is a word the prompt never spells, this is also the
    // proof that the draft survived the composer being cleared and reached the
    // model — an empty turn comes back as a generic greeting, never `FOUR`.
    check(`the model's answer reaches a painted frame (${MARKER})`, answered)
    check('the turn left the composer ready for the next prompt', stripAnsi(output).includes('Ask the harness'))

    // Command surfaces, exercised against the real booted app rather than a
    // stub: each overlay has to appear with its own content, and esc has to
    // close it again before the next one opens.
    const probes: { command: string; expect: string }[] = [
      { command: '/usage', expect: 'Usage' },
      { command: '/jobs', expect: 'Background jobs' },
      { command: '/mcp', expect: 'MCP servers' },
      { command: '/tree', expect: 'Session tree' },
      { command: '/help', expect: 'Commands' },
    ]
    for (const probe of probes) {
      const before = output.length
      child.stdin?.write(`${probe.command}\r`)
      const shown = await until(() => stripAnsi(output.slice(before)).includes(probe.expect), 20_000)
      if (!shown) {
        console.error(`--- ${probe.command} did not show ${probe.expect} ---`)
        console.error(stripAnsi(output.slice(before)).slice(-600))
      }
      check(`${probe.command} opens its surface`, shown)
      child.stdin?.write('\x1b')
      await sleep(250)
    }
    check('the app is still alive after the command walk', exitCode === null)

    // Quit cleanly the way a person does.
    child.stdin?.write('\x03')
    await sleep(400)
    child.stdin?.write('\x03')
    check('the app exits on the second ctrl+c', await until(() => exitCode !== null, 15_000))
    check('the exit code is zero', exitCode === 0)
    check('the alternate screen is left', output.includes('\x1b[?1049l'))
  } finally {
    clearTimeout(watchdog)
    if (exitCode === null) child.kill('SIGKILL')
  }

  console.log(`ok - ${String(checks)} live checks passed against ${PROFILE}`)
}

main().catch((error: unknown) => {
  console.error(String(error))
  process.exit(1)
})
