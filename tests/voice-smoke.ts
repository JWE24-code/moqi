/**
 * Voice smoke: the decisions push-to-talk makes before it touches hardware.
 *
 * None of this suite records anything, spawns anything, or needs whisper.cpp
 * installed — which is the point. `src/voice.ts` keeps the choosing, the path
 * resolution, the output parsing and the wording of every failure in pure
 * functions precisely so they can be proven on a machine with no microphone,
 * and so CI can prove them too. What is left unproven here is the one thing a
 * test cannot fake: that a real recorder and a real model produce audio
 * whisper agrees with.
 *
 * The missing-dependency messages are asserted verbatim. They are the only
 * thing a person sees when the feature does not work, so a vague or truncated
 * one is a real regression, not a cosmetic one.
 *
 * Run with: node --experimental-strip-types tests/voice-smoke.ts
 */

import assert from 'node:assert/strict'
import { homedir } from 'node:os'

import {
  MODEL_DIRECTORIES,
  MODEL_FILES,
  RECORDERS,
  WHISPER_COMMANDS,
  fileExists,
  hasCommand,
  insertionFor,
  parseWhisperText,
  resolveModel,
  resolveVoiceSetup,
  systemProbe,
  transcribeError,
  voiceGapMessage,
  voiceOptionsFromEnv,
  whisperArgs,
  type VoiceProbe,
  type VoiceSetup,
} from '../src/voice.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

function equal(label: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, `${label}: got ${JSON.stringify(actual)}`)
  checks += 1
}

/** A probe answering from two explicit sets, so a case states its own world. */
function probe(commands: readonly string[], files: readonly string[] = [], home = '/home/tester'): VoiceProbe {
  return {
    hasCommand: (command) => commands.includes(command),
    exists: (path) => files.includes(path),
    home,
  }
}

const EVERYTHING = probe(
  ['arecord', 'whisper-cli'],
  ['/home/tester/.cache/whisper/ggml-base.en.bin'],
)

// ------------------------------------------------------------- recorder choice

{
  const resolved = resolveVoiceSetup({}, EVERYTHING)
  check('a complete system resolves', resolved.ok)
  if (resolved.ok) {
    equal('arecord is chosen when present', resolved.setup.recorder.command, 'arecord')
    equal(
      'arecord is asked for 16 kHz mono 16-bit wav',
      resolved.setup.recorder.args('/home/tester/a.wav'),
      ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', '/home/tester/a.wav'],
    )
  }
}

{
  // sox's two front ends are not interchangeable: `rec` defaults to the input
  // device, `sox` has to be handed `-d`, and swapping the two records silence.
  const soxOnly = resolveVoiceSetup(
    { model: '/m.bin' },
    probe(['sox', 'whisper-cli'], ['/m.bin']),
  )
  check('sox alone is enough to record', soxOnly.ok)
  if (soxOnly.ok) {
    equal('sox is told to open the default device', soxOnly.setup.recorder.args('/home/tester/a.wav'), [
      '-q',
      '-d',
      '-r',
      '16000',
      '-c',
      '1',
      '-b',
      '16',
      '/home/tester/a.wav',
    ])
  }
}

{
  const both = resolveVoiceSetup({ model: '/m.bin' }, probe(['rec', 'sox', 'whisper-cli'], ['/m.bin']))
  check('rec is preferred over sox', both.ok && both.setup.recorder.command === 'rec')
  equal(
    'rec is not handed the -d that sox needs',
    both.ok ? both.setup.recorder.args('/home/tester/a.wav').includes('-d') : true,
    false,
  )
}

{
  const none = resolveVoiceSetup({}, probe(['whisper-cli'], ['/home/tester/.cache/whisper/ggml-base.en.bin']))
  check('no recorder is a gap', !none.ok)
  if (!none.ok) {
    equal('the recorder gap is reported first', none.gap.kind, 'recorder')
    equal(
      'the recorder gap names both packages',
      voiceGapMessage(none.gap),
      'no recorder — run: npm run setup-voice, or install alsa-utils or sox',
    )
  }
}

check('every recorder produces 16 kHz mono', RECORDERS.every((recorder) => {
  const args = recorder.args('/home/tester/a.wav')
  return args.includes('16000') && args.includes('1') && args.includes('/home/tester/a.wav')
}))

// --------------------------------------------------------------- binary choice

{
  const ordered = ['whisper-cli', 'whisper-cpp', 'whisper.cpp', 'whisper', 'main']
  equal('the whisper names are searched in a fixed order', [...WHISPER_COMMANDS], ordered)
  check('bare `main` is searched last, being the most generic', WHISPER_COMMANDS.at(-1) === 'main')
}

{
  const packaged = resolveVoiceSetup({ model: '/m.bin' }, probe(['arecord', 'whisper-cpp', 'main'], ['/m.bin']))
  check('the distribution name wins over bare main', packaged.ok && packaged.setup.binary === 'whisper-cpp')
}

{
  const noBinary = resolveVoiceSetup({ model: '/m.bin' }, probe(['arecord'], ['/m.bin']))
  check('no whisper is a gap', !noBinary.ok)
  if (!noBinary.ok) {
    equal('the binary gap is reported after the recorder', noBinary.gap.kind, 'binary')
    equal(
      'the binary gap names the install and the override',
      voiceGapMessage(noBinary.gap),
      'no whisper binary — run: npm run setup-voice, or set MOQI_WHISPER_BIN',
    )
  }
}

{
  const explicit = resolveVoiceSetup(
    { binary: '/opt/whisper.cpp/build/bin/whisper-cli', model: '/m.bin' },
    probe(['arecord'], ['/opt/whisper.cpp/build/bin/whisper-cli', '/m.bin']),
  )
  check('an explicit binary path bypasses the PATH search', explicit.ok)
  if (explicit.ok) {
    equal('the explicit binary is used verbatim', explicit.setup.binary, '/opt/whisper.cpp/build/bin/whisper-cli')
  }
}

{
  const wrong = resolveVoiceSetup(
    { binary: '/nope/whisper-cli', model: '/m.bin' },
    probe(['arecord', 'whisper-cli'], ['/m.bin']),
  )
  check('an explicit binary that is absent is an error, not a fallback', !wrong.ok)
  if (!wrong.ok) {
    equal(
      'the bad binary path names the flag that set it',
      voiceGapMessage(wrong.gap),
      'no whisper binary at /nope/whisper-cli — fix --voice-bin',
    )
  }
}

{
  const fromEnv = resolveVoiceSetup(
    { envBinary: '/nope/whisper-cli', model: '/m.bin' },
    probe(['arecord'], ['/m.bin']),
  )
  check('the environment can set the binary too', !fromEnv.ok)
  if (!fromEnv.ok) {
    equal(
      'a bad binary from the environment names the variable',
      voiceGapMessage(fromEnv.gap),
      'no whisper binary at /nope/whisper-cli — fix MOQI_WHISPER_BIN',
    )
  }
}

{
  const both = resolveVoiceSetup(
    { binary: 'flag-whisper', envBinary: 'env-whisper', model: '/m.bin' },
    probe(['arecord', 'flag-whisper', 'env-whisper'], ['/m.bin']),
  )
  check('the flag beats the environment for the binary', both.ok && both.setup.binary === 'flag-whisper')
}

// ---------------------------------------------------------------- model paths

{
  const found = resolveModel({}, EVERYTHING)
  check('the default search finds a model in ~/.cache/whisper', found.ok)
  if (found.ok) equal('and returns its expanded path', found.path, '/home/tester/.cache/whisper/ggml-base.en.bin')
}

{
  const packaged = resolveModel({}, probe([], ['/usr/share/whisper.cpp/ggml-small.bin']))
  check('a packaged model is found too', packaged.ok)
  if (packaged.ok) equal('at its system path', packaged.path, '/usr/share/whisper.cpp/ggml-small.bin')
}

{
  // Directory order beats file order: a hand-downloaded tiny model in the home
  // directory is the one the person put there on purpose.
  const both = resolveModel(
    {},
    probe([], ['/home/tester/.cache/whisper/ggml-tiny.bin', '/usr/share/whisper.cpp/ggml-base.en.bin']),
  )
  check('the home directory is searched before the system one', both.ok)
  if (both.ok) equal('so the home model wins', both.path, '/home/tester/.cache/whisper/ggml-tiny.bin')
}

{
  const sized = resolveModel(
    {},
    probe([], [
      '/home/tester/.cache/whisper/ggml-tiny.bin',
      '/home/tester/.cache/whisper/ggml-base.en.bin',
    ]),
  )
  check('within one directory the better model wins', sized.ok)
  if (sized.ok) equal('base.en over tiny', sized.path, '/home/tester/.cache/whisper/ggml-base.en.bin')
}

{
  const flagged = resolveModel({ model: '/models/ggml-large-v3.bin' }, probe([], ['/models/ggml-large-v3.bin']))
  check('--voice-model is taken verbatim', flagged.ok)
  if (flagged.ok) equal('at the path given', flagged.path, '/models/ggml-large-v3.bin')
}

{
  const tilde = resolveModel({ envModel: '~/models/ggml-base.bin' }, probe([], ['/home/tester/models/ggml-base.bin']))
  check('a leading ~ is expanded in a configured path', tilde.ok)
  if (tilde.ok) equal('against the home directory', tilde.path, '/home/tester/models/ggml-base.bin')
}

{
  const flagWins = resolveModel(
    { model: '/a.bin', envModel: '/b.bin' },
    probe([], ['/a.bin', '/b.bin']),
  )
  check('the flag beats the environment for the model', flagWins.ok)
  if (flagWins.ok) equal('flag path chosen', flagWins.path, '/a.bin')
}

{
  const blank = resolveModel({ model: '   ', envModel: '/b.bin' }, probe([], ['/b.bin']))
  check('a blank flag falls through to the environment', blank.ok)
  if (blank.ok) equal('environment path chosen', blank.path, '/b.bin')
}

{
  const missing = resolveModel({ model: '/models/gone.bin' }, probe([], []))
  check('a configured model that is absent is an error', !missing.ok)
  if (!missing.ok) {
    equal(
      'and the message names the path and the flag',
      voiceGapMessage(missing.gap),
      'no model at /models/gone.bin — fix --voice-model',
    )
  }
}

{
  const missingEnv = resolveModel({ envModel: '/models/gone.bin' }, probe([], []))
  check('the same from the environment', !missingEnv.ok)
  if (!missingEnv.ok) {
    equal(
      'names the variable instead of the flag',
      voiceGapMessage(missingEnv.gap),
      'no model at /models/gone.bin — fix MOQI_WHISPER_MODEL',
    )
  }
}

{
  const none = resolveModel({}, probe([], []))
  check('an empty search is a gap', !none.ok)
  if (!none.ok) {
    equal('reported as model-unfound', none.gap.kind, 'model-unfound')
    equal(
      'with a file to download and a flag to point at it',
      voiceGapMessage(none.gap),
      'no whisper model — run: npm run setup-voice, or pass --voice-model',
    )
  }
}

check('the default search covers the home cache', MODEL_DIRECTORIES.includes('~/.cache/whisper'))
check('and the whisper.cpp system directory', MODEL_DIRECTORIES.includes('/usr/share/whisper.cpp'))
check('the model names are all ggml weights', MODEL_FILES.every((file) => /^ggml-.+\.bin$/.test(file)))

// ------------------------------------------------------------ whisper invocation

{
  const setup: VoiceSetup = {
    recorder: RECORDERS[0] as (typeof RECORDERS)[number],
    binary: 'whisper-cli',
    model: '/m.bin',
    language: undefined,
  }
  equal('whisper is given the model, the file, and nothing to print', whisperArgs(setup, '/home/tester/a.wav'), [
    '-m',
    '/m.bin',
    '-f',
    '/home/tester/a.wav',
    '-np',
  ])
  equal(
    'a configured language is passed through',
    whisperArgs({ ...setup, language: 'nl' }, '/home/tester/a.wav').slice(-2),
    ['-l', 'nl'],
  )
}

{
  const resolved = resolveVoiceSetup({ model: '/m.bin', language: '  nl  ' }, probe(['arecord', 'whisper'], ['/m.bin']))
  check('a language is trimmed', resolved.ok && resolved.setup.language === 'nl')
  const blank = resolveVoiceSetup({ model: '/m.bin', language: '   ' }, probe(['arecord', 'whisper'], ['/m.bin']))
  check('a blank language is dropped rather than passed as empty', blank.ok && blank.setup.language === undefined)
}

// ------------------------------------------------------------- output parsing

{
  const stdout = [
    '[00:00:00.000 --> 00:00:02.480]   Add a test for the retry path',
    '[00:00:02.480 --> 00:00:05.120]   and make it fail first.',
    '',
  ].join('\n')
  equal(
    'timestamps are stripped and segments joined',
    parseWhisperText(stdout),
    'Add a test for the retry path and make it fail first.',
  )
}

{
  const noisy = [
    'whisper_init_from_file_with_params_no_state: loading model from /m.bin',
    'whisper_model_load: n_vocab = 51864',
    'system_info: n_threads = 4 / 8 | AVX = 1 |',
    '',
    'main: processing /home/tester/a.wav (48000 samples, 3.0 sec)',
    '',
    '[00:00:00.000 --> 00:00:03.000]   Ship it.',
    '',
    'whisper_print_timings:    total time =   412.55 ms',
  ].join('\n')
  equal('a build that ignores -np is still parsed', parseWhisperText(noisy), 'Ship it.')
}

{
  const plain = ['Refactor the parser,', 'then run the suite.'].join('\n')
  equal(
    'plain output with no timestamps falls back to the lines',
    parseWhisperText(plain),
    'Refactor the parser, then run the suite.',
  )
}

{
  const logsOnly = [
    'whisper_init: loading',
    'main: done',
  ].join('\n')
  equal('output that is only log lines yields nothing', parseWhisperText(logsOnly), '')
}

equal('silence yields nothing', parseWhisperText('[00:00:00.000 --> 00:00:02.000]   [BLANK_AUDIO]'), '')
equal('so does a music marker', parseWhisperText('[00:00:00.000 --> 00:00:01.000]  (music)'), '')
equal('empty stdout yields nothing', parseWhisperText(''), '')
equal('whitespace is collapsed', parseWhisperText('[00:00:00.000 --> 00:00:01.000]   a    b  '), 'a b')
equal(
  'a colon inside real speech is not mistaken for a log prefix',
  parseWhisperText('the rule is this: keep it local'),
  'the rule is this: keep it local',
)

// ---------------------------------------------------------- composer insertion

equal('an empty composer takes the transcript as-is', insertionFor('', 0, 'hello there'), 'hello there')
equal('a space is added after a word', insertionFor('fix the', 7, 'retry path'), ' retry path')
equal('but not after existing whitespace', insertionFor('fix the ', 8, 'retry path'), 'retry path')
equal('nor after a newline', insertionFor('line\n', 5, 'two'), 'two')
equal('insertion respects the cursor, not the end', insertionFor('ab cd', 2, 'X'), ' X')
equal('at the very start no space is added', insertionFor('abc', 0, 'X'), 'X')
equal('an empty transcript inserts nothing', insertionFor('abc', 3, '   '), '')
equal('the transcript is trimmed', insertionFor('', 0, '  hi  '), 'hi')

// ------------------------------------------------------------- failure wording

equal(
  'a vanished binary is named plainly',
  transcribeError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), ''),
  'whisper binary vanished mid-run',
)
equal(
  'a timeout is named plainly',
  transcribeError(Object.assign(new Error('killed'), { code: 'ETIMEDOUT' }), ''),
  'whisper timed out',
)
equal(
  "whisper's own complaint is preferred over node's echo of the command line",
  transcribeError(new Error('Command failed: whisper-cli -m ...'), 'error: failed to read wav file\n'),
  'whisper: error: failed to read wav file',
)
check(
  'an unexplained failure still yields one line',
  !transcribeError(new Error('boom\nstack\nstack'), '').includes('\n'),
)

// --------------------------------------------------------------- the real probe

{
  // The system probe is exercised, not asserted against this machine: whether
  // whisper happens to be installed here is not something a suite may depend on.
  const real = systemProbe()
  equal('the probe reports the real home directory', real.home, homedir())
  check('a command that cannot exist is not found', !real.hasCommand('moqi-definitely-not-a-command'))
  check('a path that cannot exist does not exist', !real.exists('/moqi/definitely/not/a/path'))
  check('node itself is on PATH', hasCommand('node') || hasCommand(process.execPath))
  check('this test file exists', fileExists(new URL(import.meta.url).pathname))

  const resolution = resolveVoiceSetup(voiceOptionsFromEnv(), real)
  check(
    'and resolving against it either succeeds or names exactly one missing piece',
    resolution.ok || voiceGapMessage(resolution.gap).length > 0,
  )
  check(
    'a gap message is one line and short enough for the footer',
    resolution.ok ||
      (!voiceGapMessage(resolution.gap).includes('\n') && voiceGapMessage(resolution.gap).length <= 90),
  )
}

// The environment is read, but only from the three documented variables.
{
  const options = voiceOptionsFromEnv({
    MOQI_WHISPER_MODEL: '/m.bin',
    MOQI_WHISPER_BIN: '/b',
    MOQI_WHISPER_LANG: 'nl',
  })
  equal('the model variable is read', options.envModel, '/m.bin')
  equal('the binary variable is read', options.envBinary, '/b')
  equal('the language variable is read', options.language, 'nl')
  const empty = voiceOptionsFromEnv({})
  equal('an empty environment configures nothing', empty, {
    envModel: undefined,
    envBinary: undefined,
    language: undefined,
  })
}

// eslint-disable-next-line no-console
console.log(`ok - ${String(checks)} voice checks passed`)
