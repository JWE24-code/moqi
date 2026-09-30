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
/**
 * The host adapter at the panel seam.
 *
 * It holds the one active panel and never polls a plugin: rows are read when
 * the panel opens and again after each action, so the redraw *is* the refresh.
 * Every failure becomes a status line rather than an escaping throw, and the
 * panel is left open so the row can be tried again.
 */
export class PanelHost {
    /** The panel the picker is currently showing, for `enter` routing. */
    active;
    source;
    surface;
    constructor(source, surface) {
        this.source = source;
        this.surface = surface;
    }
    /**
     * Every contributed panel as a palette command.
     *
     * Names are deduplicated case-insensitively, matching the registry's own
     * rule, so one panel cannot appear twice in the palette.
     */
    commands() {
        const seen = new Set();
        const commands = [];
        for (const panel of this.source.panels()) {
            const key = panel.name.trim().toLowerCase();
            if (key === '' || seen.has(key))
                continue;
            seen.add(key);
            commands.push({ name: panel.name, description: panel.description });
        }
        return commands;
    }
    /**
     * Look a panel up by command name and open it.
     *
     * @returns whether a panel answered to the name, so the caller can fall
     *   through to its own "unknown command" report.
     */
    openByName(name) {
        const panel = this.source.findPanel(name);
        if (panel === undefined)
            return false;
        this.open(panel);
        return true;
    }
    /** Show a panel's rows, with the cursor on `select` when it survives. */
    open(panel, select) {
        this.active = panel;
        this.show(panel, select);
    }
    /**
     * `enter` on a panel row: run it, then raise any secret it asks for.
     *
     * The action may toggle state and return nothing, in which case the rows are
     * simply re-read; or it may return a {@link TuiPanelSecret}, in which case
     * the prompt is raised, the trimmed answer submitted, and the rows re-read.
     * A throw — from the action or from `submit` — is reported and the panel
     * stays open, so a failed toggle never costs the user the panel.
     */
    async activate(id) {
        const panel = this.active;
        if (panel === undefined)
            return;
        let result;
        try {
            result = await panel.activate(id);
        }
        catch (error) {
            this.fail(error);
            this.show(panel, id);
            return;
        }
        if (result !== undefined && result.kind === 'secret') {
            const value = await this.surface.askSecret(panel.title ?? panel.name, result.message, result.placeholder);
            if (value === undefined) {
                this.surface.report('cancelled');
                this.show(panel, id);
                return;
            }
            try {
                await result.submit(value);
            }
            catch (error) {
                this.fail(error);
                this.show(panel, id);
                return;
            }
        }
        this.show(panel, id);
    }
    /** Read the panel's rows and hand them to the surface. */
    show(panel, select) {
        this.surface.showList(panel.title ?? panel.name, panel.rows(), select);
        this.surface.paint();
    }
    /** Report a failure and redraw. */
    fail(error) {
        this.surface.fail(error);
        this.surface.paint();
    }
}
