/**
 * Push-to-talk dictation, transcribed on this machine and nowhere else.
 *
 * The whole point of this feature is that a prompt spoken into the composer
 * never becomes somebody else's training data, so there is no cloud endpoint
 * here and no API key to lose: audio is captured by whatever recorder the
 * system already has and handed to a local `whisper.cpp` binary. That also
 * means the app cannot depend on any of it. A machine with no microphone
 * stack, no whisper build, or no model is the normal case, not the error
 * case — so every probe below reports what is missing in one line a person
 * can act on, and the app is otherwise untouched.
 *
 * Nothing in this module is a runtime dependency of the bundle: the recorder
 * and the transcriber are external processes discovered on `PATH`, and the
 * decision logic is pure so it can be tested without either of them.
 * @module
 */
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
/** How long a transcription may run before it is killed, in milliseconds. */
export const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** How long a recorder gets to flush its WAV header after a stop, in milliseconds. */
export const RECORDER_FLUSH_MS = 2000;
/**
 * Recorders in the order they are preferred.
 *
 * `arecord` comes first because on Linux it is part of alsa-utils, which is
 * already installed anywhere sound works at all, and it talks to ALSA
 * directly. `rec` and `sox` are the same program wearing two names; `rec`
 * defaults to the system input device while `sox` has to be told `-d`, which
 * is why they cannot share one entry.
 */
export const RECORDERS = [
    {
        command: 'arecord',
        packageName: 'alsa-utils',
        args: (target) => ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', target],
    },
    {
        command: 'rec',
        packageName: 'sox',
        args: (target) => ['-q', '-r', '16000', '-c', '1', '-b', '16', target],
    },
    {
        command: 'sox',
        packageName: 'sox',
        args: (target) => ['-q', '-d', '-r', '16000', '-c', '1', '-b', '16', target],
    },
];
/**
 * Names whisper.cpp has shipped its command-line front end under.
 *
 * `whisper-cli` is what upstream builds today and `whisper-cpp` is what most
 * distributions rename it to. Plain `main` is last on purpose: it is the
 * historic name of the build output and still what an in-tree build produces,
 * but it is far too generic to trust ahead of anything else on `PATH`.
 */
export const WHISPER_COMMANDS = [
    'whisper-cli',
    'whisper-cpp',
    'whisper.cpp',
    'whisper',
    'main',
];
/** Directories searched for a model when none was configured. */
export const MODEL_DIRECTORIES = [
    '~/.cache/whisper',
    '~/.local/share/whisper',
    '/usr/share/whisper.cpp',
    '/usr/local/share/whisper.cpp',
];
/**
 * Model files looked for inside each directory, best first.
 *
 * Dictation is a handful of seconds of one speaker close to the microphone,
 * which `base` already handles, so the ordering trades accuracy for the
 * latency a person is standing there waiting through. English-only weights
 * win their size class because they are measurably better at it.
 */
export const MODEL_FILES = [
    'ggml-base.en.bin',
    'ggml-base.bin',
    'ggml-small.en.bin',
    'ggml-small.bin',
    'ggml-medium.en.bin',
    'ggml-medium.bin',
    'ggml-tiny.en.bin',
    'ggml-tiny.bin',
];
/** Expand a leading `~` against the home directory the probe reports. */
function expandHome(path, home) {
    if (path === '~')
        return home;
    if (path.startsWith('~/'))
        return join(home, path.slice(2));
    return path;
}
/**
 * Decide whether voice input can run, and with what.
 *
 * Pure apart from the injected probe, because the interesting part is the
 * order the three dependencies are reported in and that is worth testing
 * without a microphone: the recorder comes first because it is the one a
 * person is most likely to already have, then the binary, then the weights —
 * which is also the order in which they get harder to install.
 */
export function resolveVoiceSetup(options, probe) {
    const recorder = RECORDERS.find((candidate) => probe.hasCommand(candidate.command));
    if (recorder === undefined)
        return { ok: false, gap: { kind: 'recorder' } };
    const named = firstConfigured(options.binary, options.envBinary);
    let binary;
    if (named !== undefined) {
        // A path was spelled out, so a miss is a mistake worth naming rather than
        // something to quietly paper over with a `PATH` lookup.
        const path = expandHome(named.value, probe.home);
        const present = isAbsolute(path) || path.includes('/') ? probe.exists(path) : probe.hasCommand(path);
        if (!present) {
            return { ok: false, gap: { kind: 'binary-missing', path, source: named.source } };
        }
        binary = path;
    }
    else {
        const found = WHISPER_COMMANDS.find((candidate) => probe.hasCommand(candidate));
        if (found === undefined)
            return { ok: false, gap: { kind: 'binary' } };
        binary = found;
    }
    const model = resolveModel(options, probe);
    if (!model.ok)
        return model;
    return {
        ok: true,
        setup: {
            recorder,
            binary,
            model: model.path,
            language: options.language === undefined || options.language.trim() === ''
                ? undefined
                : options.language.trim(),
        },
    };
}
/** The configured value that wins, with where it came from. */
function firstConfigured(flag, env) {
    // The flag beats the environment: it is the more deliberate of the two, and
    // it is the one a person can change without editing a shell profile.
    if (flag !== undefined && flag.trim() !== '')
        return { value: flag.trim(), source: 'flag' };
    if (env !== undefined && env.trim() !== '')
        return { value: env.trim(), source: 'env' };
    return undefined;
}
/** Resolve the weights from the flag, the environment, or the default search. */
export function resolveModel(options, probe) {
    const named = firstConfigured(options.model, options.envModel);
    if (named !== undefined) {
        const path = expandHome(named.value, probe.home);
        if (!probe.exists(path)) {
            return { ok: false, gap: { kind: 'model-missing', path, source: named.source } };
        }
        return { ok: true, path };
    }
    // Directory-major: a machine with both a distribution package and a hand
    // downloaded model should use the one it downloaded, which is the one in
    // the home directory, even when the packaged one is the larger weights.
    for (const directory of MODEL_DIRECTORIES) {
        const base = expandHome(directory, probe.home);
        for (const file of MODEL_FILES) {
            const candidate = join(base, file);
            if (probe.exists(candidate))
                return { ok: true, path: candidate };
        }
    }
    return { ok: false, gap: { kind: 'model-unfound' } };
}
/**
 * One line saying what is missing and how to get it.
 *
 * Deliberately a single sentence with a concrete next step in it: this lands
 * in the footer, which is one line wide, and an error there that only says
 * "voice unavailable" costs the reader a search through the README.
 */
export function voiceGapMessage(gap) {
    switch (gap.kind) {
        case 'recorder':
            return 'no recorder — run: npm run setup-voice, or install alsa-utils or sox';
        case 'binary':
            return 'no whisper binary — run: npm run setup-voice, or set MOQI_WHISPER_BIN';
        case 'binary-missing':
            return `no whisper binary at ${gap.path} — fix ${sourceLabel(gap.source, 'bin')}`;
        case 'model-missing':
            return `no model at ${gap.path} — fix ${sourceLabel(gap.source, 'model')}`;
        case 'model-unfound':
            return 'no whisper model — run: npm run setup-voice, or pass --voice-model';
    }
}
/** Name the knob that produced a bad path, so the fix is unambiguous. */
function sourceLabel(source, which) {
    if (source === 'flag')
        return which === 'bin' ? '--voice-bin' : '--voice-model';
    return which === 'bin' ? 'MOQI_WHISPER_BIN' : 'MOQI_WHISPER_MODEL';
}
/**
 * Arguments for one transcription run.
 *
 * `-np` suppresses whisper.cpp's banner and progress so the only thing left
 * on stdout is the transcript; the segment timestamps are deliberately kept,
 * because they are the one marker that reliably separates a result line from
 * whatever a given build still prints alongside it.
 */
export function whisperArgs(setup, wavPath) {
    const args = ['-m', setup.model, '-f', wavPath, '-np'];
    if (setup.language !== undefined)
        args.push('-l', setup.language);
    return args;
}
/** Segment markers whisper emits for audio that carries no speech. */
const NON_SPEECH = /^[[(](?:blank_audio|silence|music|sound|noise|inaudible)[\])]$/i;
/**
 * Turn whisper's stdout into the text a person meant to say.
 *
 * whisper.cpp prints one line per segment, `[00:00:00.000 --> 00:00:02.000]`
 * and then the words. When any such line is present those lines are the whole
 * answer and everything else is noise from a build that ignored `-np`; when
 * none is, the build was asked for plain output and the lines are the text —
 * minus the log chatter, which is recognisable by its `prefix:` shape.
 */
export function parseWhisperText(stdout) {
    const timestamped = [];
    const plain = [];
    for (const raw of stdout.split('\n')) {
        const line = raw.trim();
        if (line === '')
            continue;
        if (isTimestamped(line)) {
            const text = timestampText(line);
            if (text !== '')
                timestamped.push(text);
            continue;
        }
        const speech = plainSpeech(line);
        if (speech !== undefined)
            plain.push(speech);
    }
    const parts = timestamped.length > 0 ? timestamped : plain;
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}
/** The spoken text a timestamped subtitle line carries, empty when non-speech. */
function timestampText(line) {
    const segment = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*(.*)$/.exec(line);
    const text = (segment?.[1] ?? '').trim();
    return NON_SPEECH.test(text) ? '' : text;
}
/** Whether the line carries a timestamped subtitle. */
function isTimestamped(line) {
    return /^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]/.test(line);
}
/**
 * The plain text a non-timestamped line contributes, or undefined when it is
 * log chatter rather than speech.
 */
function plainSpeech(line) {
    // A log line from whisper or its loader, e.g. `whisper_init_from_file:` or
    // `main: processing ...`. Real speech can contain a colon, but not one
    // sitting directly after a leading run of identifier characters.
    if (/^[a-z_][a-z0-9_.]*\s*:/i.test(line))
        return undefined;
    if (line.startsWith('[') || line.startsWith('<'))
        return undefined;
    return NON_SPEECH.test(line) ? undefined : line;
}
/**
 * The text to splice into the composer at `cursor`.
 *
 * Dictation is usually appended to something already typed, and two utterances
 * running together into one word is the kind of small wrongness that makes a
 * feature feel broken, so a separator is added when the character before the
 * cursor is not already one.
 */
export function insertionFor(value, cursor, transcript) {
    const text = transcript.trim();
    if (text === '')
        return '';
    const before = value.slice(0, Math.max(cursor, 0));
    if (before === '' || /\s$/.test(before))
        return text;
    return ` ${text}`;
}
/** Whether a command resolves to an executable somewhere on `PATH`. */
export function hasCommand(command, env = process.env) {
    if (command.includes('/'))
        return fileExists(command);
    const path = env['PATH'] ?? '';
    for (const directory of path.split(delimiter)) {
        if (directory === '')
            continue;
        try {
            accessSync(join(directory, command), constants.X_OK);
            return true;
        }
        catch {
            // Not here, or not executable; keep walking the rest of PATH.
        }
    }
    return false;
}
/** Whether a path exists and is readable. */
export function fileExists(path) {
    try {
        accessSync(path, constants.R_OK);
        return true;
    }
    catch {
        return false;
    }
}
/** The probe that answers against the real filesystem. */
export function systemProbe(env = process.env) {
    return {
        hasCommand: (command) => hasCommand(command, env),
        exists: fileExists,
        home: homedir(),
    };
}
/** Read the environment half of the configuration. */
export function voiceOptionsFromEnv(env = process.env) {
    return {
        envModel: env['MOQI_WHISPER_MODEL'],
        envBinary: env['MOQI_WHISPER_BIN'],
        language: env['MOQI_WHISPER_LANG'],
    };
}
/**
 * Start the recorder.
 *
 * stdio is fully detached from this process's own: the app owns the alternate
 * screen buffer, and a recorder writing a warning onto it would tear the frame
 * apart with no way to repaint the damage.
 */
export function startRecording(setup, wavPath) {
    const child = spawn(setup.recorder.command, setup.recorder.args(wavPath), {
        stdio: ['ignore', 'ignore', 'ignore'],
    });
    return { child, wavPath };
}
/**
 * Stop the recorder and wait for the file to be finished.
 *
 * SIGINT rather than SIGTERM because both recorders treat it as "wrap up":
 * they close the WAV and go back and write the real length into the header.
 * Killed harder, the file is left claiming a length of zero and whisper reads
 * nothing out of it. The hard kill is only the fallback for a recorder that
 * ignores the polite request.
 */
export function stopRecording(recording) {
    return new Promise((resolve) => {
        const child = recording.child;
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            }
            catch {
                // Already gone; the exit handler below has the resolve either way.
            }
            resolve();
        }, RECORDER_FLUSH_MS);
        timer.unref?.();
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        try {
            child.kill('SIGINT');
        }
        catch {
            clearTimeout(timer);
            resolve();
        }
    });
}
/**
 * Transcribe one WAV file and return the text.
 *
 * Rejects with a one-line message rather than an exec error, because the
 * caller puts whatever comes back straight into a status line that is one
 * line wide.
 */
export function transcribe(setup, wavPath) {
    return new Promise((resolve, reject) => {
        execFile(setup.binary, whisperArgs(setup, wavPath), { timeout: TRANSCRIBE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error !== null) {
                reject(new Error(transcribeError(error, String(stderr))));
                return;
            }
            resolve(parseWhisperText(String(stdout)));
        });
    });
}
/** A one-line reason a transcription run failed. */
export function transcribeError(error, stderr) {
    const code = error?.code;
    if (code === 'ENOENT')
        return 'whisper binary vanished mid-run';
    if (code === 'ETIMEDOUT')
        return 'whisper timed out';
    // whisper says why on stderr; node's own message is the whole command line
    // echoed back, which is useless in a footer.
    const detail = stderr
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '' && /error|failed|cannot|unable/i.test(line));
    if (detail !== undefined)
        return `whisper: ${detail}`;
    return error instanceof Error ? error.message.split('\n')[0] ?? 'whisper failed' : 'whisper failed';
}
