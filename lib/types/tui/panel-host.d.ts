/**
 * The host side of the `tuiHost` panel seam.
 *
 * A plugin contributes a {@link TuiPanel} — rows to draw and one action per
 * row — and this module turns that small contract into the whole lifecycle the
 * app would otherwise scatter: open the list, route a chosen row, raise the
 * masked prompt a row asks for, report a failure, and redraw. `TuiApp` learns
 * only where its surfaces are, never how a panel works.
 *
 * Framework-free on purpose: every dependency is a {@link PanelSurface} or a
 * {@link PanelSource}, so `tests/panel-host-smoke.ts` drives the whole
 * lifecycle with fakes and no Cordis or terminal.
 * @module
 */
import type { TuiPanel, TuiPanelRow } from '../tui-host-core.ts';
/** One palette command a contributed panel answers to. */
export interface PanelCommand {
    name: string;
    description: string;
}
/**
 * What the panel host needs from the running app.
 *
 * The seam has two adapters by design: `TuiApp` satisfies it with the picker,
 * the masked prompt, the status slot, and a repaint; the tests satisfy it with
 * an in-memory recorder. That second adapter is why this is an interface and
 * not a set of direct calls.
 */
export interface PanelSurface {
    /** Draw the panel's rows in the shared picker, focusing `select` when it survives. */
    showList(title: string, rows: readonly TuiPanelRow[], select?: string): void;
    /** Raise a masked prompt; resolves the trimmed answer, or `undefined` if the user backed out. */
    askSecret(title: string, message: string, placeholder?: string): Promise<string | undefined>;
    /** Report one neutral line, e.g. a cancelled prompt. */
    report(text: string): void;
    /** Report a failure; the app owns how an error is worded. */
    fail(error: unknown): void;
    /** Redraw the screen. */
    paint(): void;
}
/** Where panels come from; production is the `tuiHost` service. */
export interface PanelSource {
    panels(): readonly TuiPanel[];
    findPanel(name: string): TuiPanel | undefined;
}
/**
 * The host adapter at the panel seam.
 *
 * It holds the one active panel and never polls a plugin: rows are read when
 * the panel opens and again after each action, so the redraw *is* the refresh.
 * Every failure becomes a status line rather than an escaping throw, and the
 * panel is left open so the row can be tried again.
 */
export declare class PanelHost {
    /** The panel the picker is currently showing, for `enter` routing. */
    private active;
    private readonly source;
    private readonly surface;
    constructor(source: PanelSource, surface: PanelSurface);
    /**
     * Every contributed panel as a palette command.
     *
     * Names are deduplicated case-insensitively, matching the registry's own
     * rule, so one panel cannot appear twice in the palette.
     */
    commands(): readonly PanelCommand[];
    /**
     * Look a panel up by command name and open it.
     *
     * @returns whether a panel answered to the name, so the caller can fall
     *   through to its own "unknown command" report.
     */
    openByName(name: string): boolean;
    /** Show a panel's rows, with the cursor on `select` when it survives. */
    open(panel: TuiPanel, select?: string): void;
    /**
     * `enter` on a panel row: run it, then raise any secret it asks for.
     *
     * The action may toggle state and return nothing, in which case the rows are
     * simply re-read; or it may return a {@link TuiPanelSecret}, in which case
     * the prompt is raised, the trimmed answer submitted, and the rows re-read.
     * A throw — from the action or from `submit` — is reported and the panel
     * stays open, so a failed toggle never costs the user the panel.
     */
    activate(id: string): Promise<void>;
    /** Read the panel's rows and hand them to the surface. */
    private show;
    /** Report a failure and redraw. */
    private fail;
}
