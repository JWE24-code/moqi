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
import { PanelRegistry, ShortcutRegistry, StatusLine, TUI_HOST_NAME } from "./tui-host-core.js";
export * from "./tui-host-core.js";
/**
 * The extension seam (`ctx.tuiHost`). Plugins register shortcuts and a status
 * line; the app dispatches keys and draws the line, and owns nothing else.
 */
export class TuiHost extends Service {
    shortcuts = new ShortcutRegistry();
    line = new StatusLine();
    panelRegistry = new PanelRegistry();
    constructor(ctx) {
        super(ctx, TUI_HOST_NAME);
    }
    /** Claim a key combination; see {@link ShortcutRegistry.register}. */
    registerShortcut(shortcut) {
        return this.shortcuts.register(shortcut);
    }
    /** Every registered combination, for help output and tests. */
    registered() {
        return this.shortcuts.registered();
    }
    /** Run a key's plugin handler, if one is registered. */
    dispatch(combo) {
        return this.shortcuts.dispatch(combo);
    }
    /**
     * Contribute a command panel; `<name>` joins the command palette and the
     * host draws its rows, runs its actions, and raises its masked prompts.
     */
    registerPanel(panel) {
        return this.panelRegistry.register(panel);
    }
    /** Every contributed panel, for the palette and tests. */
    panels() {
        return this.panelRegistry.registered();
    }
    /** The panel behind a command name, case-insensitively. */
    findPanel(name) {
        return this.panelRegistry.find(name);
    }
    /** Contribute the one-line status above the composer. */
    setStatusLine(text) {
        return this.line.set(text);
    }
    /** The status line a plugin contributed, if any. */
    statusLine() {
        return this.line.get();
    }
}
export default TuiHost;
