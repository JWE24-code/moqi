/**
 * The `tuiHost` seam's framework-free half: what a shortcut claim and the
 * status slot mean, with no Cordis import.
 *
 * It lives apart from `./tui-host.ts` so `npm test` can exercise it without a
 * Harness on disk — the suites run from a bare `npm ci`, where `@deepseek-ai/*`
 * does not resolve at all.
 * @module
 */
/** The name the service registers under (`ctx.tuiHost`). */
export const TUI_HOST_NAME = 'tuiHost';
/**
 * Combinations the app itself owns.
 *
 * Built-ins win outright: a plugin that tries to take `ctrl+c` would be able to
 * swallow the quit confirmation, so the registration is refused rather than
 * silently ordered.
 */
export const RESERVED_COMBOS = new Set([
    'ctrl+c',
    'ctrl+d',
    'ctrl+j',
    'ctrl+n',
    'ctrl+p',
    'ctrl+r',
    'ctrl+t',
    'ctrl+u',
    'ctrl+v',
    'ctrl+w',
    'ctrl+x',
    'ctrl+y',
    'ctrl+s',
    'ctrl+g',
    'ctrl+b',
    'ctrl+o',
    'ctrl+k',
    'ctrl+left',
    'ctrl+right',
    'ctrl+up',
    'ctrl+down',
    'ctrl+enter',
    'esc',
    'enter',
    'tab',
    'up',
    'down',
    'left',
    'right',
    'pageup',
    'pagedown',
    'home',
    'end',
    'backspace',
    'delete',
    'shift+up',
    'shift+down',
    'alt+n',
    'alt+p',
    'alt+e',
    'alt+c',
    'alt+up',
    'alt+down',
    'wheelup',
    'wheeldown',
]);
/** Why a registration was refused, or `undefined` when it was accepted. */
export function shortcutProblem(combo, taken) {
    if (combo.trim() === '')
        return 'the combination is empty';
    if (!combo.startsWith('ctrl+') && !combo.startsWith('alt+')) {
        return 'plugin shortcuts must carry ctrl or alt';
    }
    if (RESERVED_COMBOS.has(combo))
        return `${combo} is a built-in binding`;
    if (taken.has(combo))
        return `${combo} is already registered`;
    return undefined;
}
/** Shortcut claims, without any Cordis dependency — the testable half. */
export class ShortcutRegistry {
    shortcuts = new Map();
    /**
     * Claim a key combination.
     *
     * @returns a disposer that releases it, or `undefined` when the combination
     *   is reserved, malformed, or already registered.
     */
    register(shortcut) {
        const problem = shortcutProblem(shortcut.combo, new Set(this.shortcuts.keys()));
        if (problem !== undefined)
            return undefined;
        this.shortcuts.set(shortcut.combo, shortcut);
        return () => {
            // Only release it if this exact registration still owns the combo.
            if (this.shortcuts.get(shortcut.combo) === shortcut)
                this.shortcuts.delete(shortcut.combo);
        };
    }
    /** Every registered combination, in registration order. */
    registered() {
        return [...this.shortcuts.values()];
    }
    /** The label for one combination, when it is claimed. */
    labelOf(combo) {
        return this.shortcuts.get(combo)?.label;
    }
    /**
     * Run the handler for one key, if a plugin owns it.
     *
     * @returns whether the key was claimed, so the app can stop before it treats
     *   the key as text.
     */
    dispatch(combo) {
        const shortcut = this.shortcuts.get(combo);
        if (shortcut === undefined)
            return false;
        shortcut.handler();
        return true;
    }
}
/** The one-line status slot, also independent of Cordis. */
export class StatusLine {
    line;
    /**
     * Contribute the line. The slot is replaced, not stacked: a terminal has one
     * line to give, and last registration wins — the same rule a status bar has.
     */
    set(text) {
        const previous = this.line;
        const applied = text === '' ? undefined : text;
        this.line = applied;
        return () => {
            // Only restore if nothing newer has taken the line since.
            if (this.line === applied)
                this.line = previous;
        };
    }
    get() {
        return this.line;
    }
}
/** Contributed panels, keyed by lowercased command name. */
export class PanelRegistry {
    panels = new Map();
    /**
     * Claim a panel command.
     *
     * @returns a disposer that releases it, or `undefined` when the name is
     *   empty or already taken.
     */
    register(panel) {
        const key = panel.name.trim().toLowerCase();
        if (key === '' || this.panels.has(key))
            return undefined;
        this.panels.set(key, panel);
        return () => {
            if (this.panels.get(key) === panel)
                this.panels.delete(key);
        };
    }
    /** Every registered panel, in registration order. */
    registered() {
        return [...this.panels.values()];
    }
    /** The panel registered under a command name, case-insensitively. */
    find(name) {
        return this.panels.get(name.trim().toLowerCase());
    }
}
