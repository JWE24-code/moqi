/**
 * The terminal app's command-line provider.
 *
 * It parses this app's own flags out of the shared immutable cmdline snapshot
 * and publishes them as a service, so the app row can consume them lazily —
 * the same shape the shipped headless bundle uses.
 * @module moqi-tui/startup
 */
import { Command } from 'commander';
import { parseCmdline } from '@deepseek-ai/dsh-cmdline';
import { VERSION } from "./version.js";
/** Stable Cordis plugin name. */
export const name = 'tui-startup';
/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs'];
/** Service key provided by this plugin and injected by the app row. */
export const TUI_STARTUP_SERVICE = 'tuiStartup';
/** This app's command grammar, help text, and examples. */
function tuiCommand() {
    return new Command()
        .name('dsh --profile tui')
        .description('An interactive terminal client for the Harness.')
        .version(VERSION, '--version', 'print the app version and exit')
        .helpOption('-h, --help', 'show this help')
        .option('--resume <id>', 'open the persisted session with this id instead of a new one')
        .option('--model <name>', 'model to select for this run')
        .option('--thinking', 'start with reasoning output visible')
        .option('--context-limit <tokens>', "context budget override; default is the model's own capacity")
        .option('--mouse', 'report mouse events (the default; accepted for compatibility)')
        .option('--no-mouse', 'disable mouse reporting, so plain drag selects text for the terminal')
        .option('--no-bell', 'stay silent when a session finishes instead of ringing the terminal bell')
        .option('--vim', 'modal vim editing in the composer: esc for normal mode, i to insert')
        .option('--no-restore', 'start with one empty session instead of reopening the last ones')
        .option('--peer <host>', 'device to include in the sessions overview; repeatable, anything ssh accepts', (value, previous) => [...previous, value], [])
        .option('--voice-model <path>', 'whisper.cpp weights for push-to-talk dictation (ctrl+v)')
        .option('--voice-bin <path>', 'whisper.cpp executable to transcribe with; default searches PATH')
        .option('--dispatch-profile <name>', 'profile /dispatch boots on a peer; headless by default')
        .addHelpText('after', `
Examples:
  dsh --profile tui                      start a new session
  dsh --profile tui --resume session-...  reopen an existing session
  dsh --profile tui --thinking            show the reasoner's chain of thought
  dsh --profile tui --peer laptop         include another device in ctrl+s
  dsh --profile tui --no-restore          start clean instead of reopening tabs

Inside the app, type / for the command palette; press ctrl+c twice within 1.5s
to quit.
`);
}
/**
 * Parse this app's flags and provide them as an ordinary Cordis service.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx) {
    const program = tuiCommand();
    program.action(() => {
        const options = program.opts();
        if (options.resume !== undefined && options.resume.trim() === '') {
            program.error('error: --resume requires a non-empty session id');
        }
        // Left undefined, the app asks the provider for the model's real capacity.
        let contextLimit;
        const fromEnvironment = process.env['MOQI_CONTEXT_LIMIT'];
        if (fromEnvironment !== undefined && /^\d+$/.test(fromEnvironment)) {
            contextLimit = Number.parseInt(fromEnvironment, 10);
        }
        if (options.contextLimit !== undefined) {
            if (!/^\d+$/.test(options.contextLimit)) {
                program.error('error: --context-limit requires a positive integer');
            }
            contextLimit = Number.parseInt(options.contextLimit, 10);
        }
        if (contextLimit !== undefined && contextLimit <= 0) {
            program.error('error: --context-limit must be greater than zero');
        }
        ctx.provide(TUI_STARTUP_SERVICE, {
            resumeSessionId: options.resume,
            model: options.model,
            thinking: options.thinking === true,
            contextLimit,
            mouse: options.mouse !== false,
            // commander maps --no-bell to bell: false and leaves it true otherwise.
            bell: options.bell !== false,
            vim: options.vim === true,
            restore: options.restore !== false,
            peers: options.peer ?? [],
            // Left undefined the app reads MOQI_WHISPER_MODEL / _BIN, then falls
            // back to its own search, so passing nothing here is the normal case.
            voiceModel: options.voiceModel,
            voiceBin: options.voiceBin,
            dispatchProfile: options.dispatchProfile,
        });
    });
    parseCmdline(ctx, program);
}
