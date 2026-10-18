/**
 * The terminal app's command-line provider.
 *
 * It parses this app's own flags out of the shared immutable cmdline snapshot
 * and publishes them as a service, so the app row can consume them lazily —
 * the same shape the shipped headless bundle uses.
 * @module moqi-tui/startup
 */
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "tui-startup";
/** Services required before the flags can be resolved. */
export declare const inject: string[];
/** Service key provided by this plugin and injected by the app row. */
export declare const TUI_STARTUP_SERVICE = "tuiStartup";
/** What the app row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
    /** Exact session to adopt on launch; absent starts a fresh one. */
    resumeSessionId: string | undefined;
    /** Model override for this run; absent uses the profile's default. */
    model: string | undefined;
    /** Whether reasoning output starts visible. */
    thinking: boolean;
    /** Context budget override; absent means use the model's own capacity. */
    contextLimit: number | undefined;
    /** Report mouse events so the wheel scrolls and the session bar clicks; on by default. */
    mouse: boolean;
    /** Ring the bell when a session's turn finishes; on by default. */
    bell: boolean;
    /** Modal vim editing for the composer; off by default. */
    vim: boolean;
    /** How new sessions in a git repository isolate their changes; absent defers to the stored choice. */
    isolation: string | undefined;
    /** Bring back the sessions that were open at the last exit; on by default. */
    restore: boolean;
    /** Devices to include in the fleet overview; empty means this one only. */
    peers: string[];
    /** Whisper weights for push-to-talk; absent falls back to the default search. */
    voiceModel: string | undefined;
    /** Whisper executable for push-to-talk; absent looks for the known names. */
    voiceBin: string | undefined;
    /** Peer profile `/dispatch` boots; the shipped `headless` one by default. */
    dispatchProfile: string | undefined;
}
/**
 * Parse this app's flags and provide them as an ordinary Cordis service.
 * @param ctx - plugin context carrying the command line.
 */
export declare function apply(ctx: Context): void;
