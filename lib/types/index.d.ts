/**
 * moqi — an interactive terminal app for DeepSeek Harness.
 *
 * The bundle patch rides over `dsh-base` without a Host, HTTP server, or
 * browser plugin: the terminal is the only surface. This module owns the
 * Harness wiring — creating or resuming an Agent, projecting its assistant
 * stream into the transcript, and dispatching slash commands through
 * `ctx.commands` — while `./tui/*` owns everything drawn on screen.
 *
 * @module moqi
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export declare const name = "moqi";
/** Core services required before the terminal can open. */
export declare const inject: string[];
/** Plugin config, resolved from this app's startup provider. */
export interface Config {
    resumeSessionId?: string;
    model?: string;
    thinking?: boolean;
    contextLimit?: number;
    /** Report mouse events so the wheel scrolls and the session bar clicks; on by default. */
    mouse?: boolean;
    /** Ring the terminal bell when a session's turn finishes; on by default. */
    bell?: boolean;
    /** Modal vim editing for the composer; off by default. */
    vim?: boolean;
    /**
     * The view to open in: `stack` tiles every open session on screen at once;
     * anything else — including absent — reads as `tabs`, the default. The view
     * you switched to with `/tiled` is remembered across restarts
     * and outranks this.
     */
    view?: string;
    /**
     * Devices to include in the fleet overview, as anything `ssh` accepts.
     * Empty means the overview shows only this machine.
     */
    peers?: string[];
    /** Reopen the sessions that were open at the last exit; on by default. */
    restore?: boolean;
    /** Whisper weights for push-to-talk; absent falls back to the default search. */
    voiceModel?: string;
    /** Whisper executable for push-to-talk; absent looks for the known names. */
    voiceBin?: string;
    /**
     * The profile `/dispatch` boots on a peer. The shipped `headless` profile is
     * the one that answers a single task and exits.
     */
    dispatchProfile?: string;
}
export declare const Config: z<Config>;
/**
 * Mount the terminal app.
 * @param ctx - plugin context carrying the core services and launcher exit.
 * @param config - validated startup options.
 */
export declare function apply(ctx: Context, config: Config): void;
