/**
 * Install what push-to-talk dictation needs: a recorder, a whisper.cpp front
 * end, and a model.
 *
 * Voice is the one feature that cannot ship self-contained. The binary is
 * native and the weights are a 140MB download, so neither belongs in an npm
 * dependency — but telling somebody "install whisper.cpp" and leaving them to
 * work out which package, which binary name, which model file and which
 * directory is not an install story either. This script is that story.
 *
 * It is safe to run repeatedly: every step checks first and skips work that is
 * already done. The package step is the only one that needs root, and it runs
 * the package manager interactively rather than trying to be clever about it.
 *
 * Run with: npm run setup-voice  [-- --print-only] [--model <name>]
 */

import { spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/** Binary names whisper.cpp has shipped its front end under, newest first. */
const BINARIES = ['whisper-cli', 'whisper-cpp', 'whisper.cpp', 'whisper', 'main']

/** Recorders the app knows how to drive. */
const RECORDERS = ['arecord', 'sox', 'rec']

/**
 * Where the app looks for weights first, so that is where they go.
 *
 * Keeping this in step with `MODEL_DIRECTORIES` in `src/voice.ts` matters: a
 * model downloaded somewhere the app does not look is a model that does not
 * exist as far as the feature is concerned.
 */
const MODEL_DIR = join(homedir(), '.cache', 'whisper')

/**
 * The default weights.
 *
 * `base.en` is the smallest model that transcribes a sentence of dictated
 * English reliably, and dictation is a few seconds of one speaker close to the
 * microphone — the accuracy of a larger model is not worth the wait.
 */
const DEFAULT_MODEL = 'ggml-base.en.bin'
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

/** A model smaller than this is a captured error page, not weights. */
const MIN_MODEL_BYTES = 20 * 1024 * 1024

const argv = process.argv.slice(2)
const printOnly = argv.includes('--print-only')
const modelIndex = argv.indexOf('--model')
const modelFile = modelIndex === -1 ? DEFAULT_MODEL : (argv[modelIndex + 1] ?? DEFAULT_MODEL)

/**
 * Whether a command exists on PATH.
 *
 * Walked directly rather than shelled out to `command -v`: spawning a shell to
 * answer this passes a name straight to a command line, and Node now warns
 * about exactly that. A PATH walk has no such hole and needs no subprocess.
 */
function has(command) {
  if (command.includes('/')) return existsSync(command)
  const entries = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry !== '')
  return entries.some((entry) => {
    try {
      accessSync(join(entry, command), fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

function found(list) {
  return list.find((name) => has(name))
}

/**
 * How this system installs a recorder.
 *
 * ALSA's `arecord` is the one that is already there on most Linux desktops, so
 * it is the cheapest thing to ask for; macOS has no ALSA, and `sox` is the
 * portable answer there.
 */
function recorderPlan() {
  if (has('pacman')) return { manager: 'pacman', argv: ['pacman', '-S', '--needed', 'alsa-utils'], needsRoot: true }
  if (has('apt-get')) return { manager: 'apt', argv: ['apt-get', 'install', '-y', 'alsa-utils'], needsRoot: true }
  if (has('brew')) return { manager: 'brew', argv: ['brew', 'install', 'sox'], needsRoot: false }
  return { manager: undefined, argv: undefined, needsRoot: false }
}

/** The package manager this system uses, and how it installs whisper.cpp. */
function packagePlan() {
  if (has('pacman')) {
    // In the official Arch repos; the binary it ships is whisper-cpp.
    return { manager: 'pacman', argv: ['pacman', '-S', '--needed', 'whisper-cpp'], needsRoot: true }
  }
  if (has('brew')) {
    return { manager: 'brew', argv: ['brew', 'install', 'whisper-cpp'], needsRoot: false }
  }
  if (has('apt-get')) {
    // Debian and Ubuntu package the Python implementation, not whisper.cpp, so
    // there is nothing honest to install here. Say so rather than guess.
    return { manager: 'apt', argv: undefined, needsRoot: false }
  }
  return { manager: undefined, argv: undefined, needsRoot: false }
}

/**
 * Carry out one install plan.
 *
 * The package manager runs attached to this terminal: it may need a password
 * and it may have questions, and swallowing either would turn a solvable
 * prompt into a silent hang.
 */
function runPlan(plan, what) {
  if (plan.argv === undefined) {
    report('fail', `no way to install ${what} automatically here — install it with your package manager`)
    return false
  }
  const command = plan.needsRoot ? ['sudo', ...plan.argv] : plan.argv
  if (printOnly) {
    report('skip', `${what} missing — run: ${command.join(' ')}`)
    return false
  }
  console.log(`    installing ${what} with ${plan.manager}: ${command.join(' ')}`)
  if (plan.needsRoot) console.log('    (this needs your password)')
  const run = spawnSync(command[0], command.slice(1), { stdio: 'inherit' })
  if (run.status === 0) return true
  report('fail', `${plan.manager} exited ${String(run.status ?? 'unknown')} — run it yourself: ${command.join(' ')}`)
  return false
}

function report(state, text) {
  let mark = '✗'
  if (state === 'ok') mark = '✓'
  else if (state === 'skip') mark = '·'
  console.log(`  ${mark} ${text}`)
}

async function downloadModel(target) {
  const temporary = `${target}.partial`
  const url = `${MODEL_BASE_URL}/${modelFile}`
  console.log(`    fetching ${modelFile} (about 140MB) from huggingface.co…`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) {
    throw new Error(`download failed: HTTP ${String(response.status)}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary))
  const size = statSync(temporary).size
  if (size < MIN_MODEL_BYTES) {
    unlinkSync(temporary)
    throw new Error(`downloaded file is only ${String(size)} bytes — not a model`)
  }
  // Rename last, so an interrupted download never looks like a usable model.
  renameSync(temporary, target)
  return size
}

console.log('\nsetup-voice: what push-to-talk needs\n')

// ---- 1. a recorder
let recorder = found(RECORDERS)
if (recorder !== undefined) {
  report('ok', `recorder: ${recorder}`)
} else if (runPlan(recorderPlan(), 'a recorder')) {
  recorder = found(RECORDERS)
  report(recorder === undefined ? 'fail' : 'ok', recorder === undefined
    ? 'package installed but no recorder is on PATH'
    : `recorder: ${recorder}`)
}

// ---- 2. the whisper front end
let binary = found(BINARIES)
if (binary !== undefined) {
  report('ok', `whisper binary: ${binary}`)
} else {
  const plan = packagePlan()
  if (plan.argv === undefined && plan.manager === 'apt') {
    // Debian and Ubuntu package the Python implementation, not whisper.cpp.
    report('fail', 'no whisper binary — Debian/Ubuntu ship the Python whisper; build whisper.cpp from github.com/ggerganov/whisper.cpp')
  } else if (runPlan(plan, 'whisper.cpp')) {
    binary = found(BINARIES)
    report(binary === undefined ? 'fail' : 'ok', binary === undefined
      ? 'package installed but no known binary name is on PATH'
      : `whisper binary: ${binary}`)
  }
}

// ---- 3. the model
const modelPath = join(MODEL_DIR, modelFile)
if (existsSync(modelPath)) {
  report('ok', `model: ${modelPath}`)
} else if (printOnly) {
  report('skip', `model missing — would download ${modelFile} to ${MODEL_DIR}`)
} else {
  try {
    mkdirSync(MODEL_DIR, { recursive: true })
    const size = await downloadModel(modelPath)
    report('ok', `model: ${modelPath} (${String(Math.round(size / 1024 / 1024))}MB)`)
  } catch (error) {
    report('fail', `model download failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---- what the app will make of it
const ready = found(RECORDERS) !== undefined && found(BINARIES) !== undefined && existsSync(modelPath)
console.log('')
if (ready) {
  console.log('  press ctrl+v in the app to dictate.\n')
} else {
  console.log('  voice is not ready yet; the app will say which piece is missing.\n')
}
process.exit(ready ? 0 : 1)
