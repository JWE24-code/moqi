/**
 * The `tuiHost` service: the seam other plugins extend this terminal with.
 *
 * A plugin can own a key combination (Ctrl/Alt only, built-ins always win) and
 * can contribute one line above the composer. Everything is disposer-scoped,
 * so an unloaded plugin leaves nothing behind — and nothing here can take the
 * keyboard away from the app's own bindings.
 *
 * This module is the Cordis-bound half; the rules it delegates to live in
 * `./tui-host-core.ts` and are re-exported here, so `moqi-tui/tui-host`
 * remains the one import a plugin needs.
 * @module moqi-tui/tui-host
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { TuiPanel, TuiShortcut } from './tui-host-core.ts';
export * from './tui-host-core.ts';
/**
 * The extension seam (`ctx.tuiHost`). Plugins register shortcuts and a status
 * line; the app dispatches keys and draws the line, and owns nothing else.
 */
export declare class TuiHost extends Service {
    private readonly shortcuts;
    private readonly line;
    private readonly panelRegistry;
    constructor(ctx: Context);
    /** Claim a key combination; see {@link ShortcutRegistry.register}. */
    registerShortcut(shortcut: TuiShortcut): (() => void) | undefined;
    /** Every registered combination, for help output and tests. */
    registered(): readonly TuiShortcut[];
    /** Run a key's plugin handler, if one is registered. */
    dispatch(combo: string): boolean;
    /**
     * Contribute a command panel; `<name>` joins the command palette and the
     * host draws its rows, runs its actions, and raises its masked prompts.
     */
    registerPanel(panel: TuiPanel): (() => void) | undefined;
    /** Every contributed panel, for the palette and tests. */
    panels(): readonly TuiPanel[];
    /** The panel behind a command name, case-insensitively. */
    findPanel(name: string): TuiPanel | undefined;
    /** Contribute the one-line status above the composer. */
    setStatusLine(text: string | undefined): () => void;
    /** The status line a plugin contributed, if any. */
    statusLine(): string | undefined;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        tuiHost: TuiHost;
    }
}
export default TuiHost;
