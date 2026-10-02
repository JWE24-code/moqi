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
export const TUI_HOST_NAME = 'tuiHost'

/** One plugin-registered key combination. */
export interface TuiShortcut {
  /** Canonical key name the app dispatches, e.g. `ctrl+shift+g`. */
  combo: string
  /** One-line description, for refusal messages and future help. */
  label: string
  /** Called on the keypress; a throw is reported as a status line. */
  handler: () => void
}

/**
 * Combinations the app itself owns.
 *
 * Built-ins win outright: a plugin that tries to take `ctrl+c` would be able to
 * swallow the quit confirmation, so the registration is refused rather than
 * silently ordered.
 */
export const RESERVED_COMBOS: ReadonlySet<string> = new Set([
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
])

/** Why a registration was refused, or `undefined` when it was accepted. */
export function shortcutProblem(combo: string, taken: ReadonlySet<string>): string | undefined {
  if (combo.trim() === '') return 'the combination is empty'
  if (!combo.startsWith('ctrl+') && !combo.startsWith('alt+')) {
    return 'plugin shortcuts must carry ctrl or alt'
  }
  if (RESERVED_COMBOS.has(combo)) return `${combo} is a built-in binding`
  if (taken.has(combo)) return `${combo} is already registered`
  return undefined
}

/** Shortcut claims, without any Cordis dependency — the testable half. */
export class ShortcutRegistry {
  private readonly shortcuts = new Map<string, TuiShortcut>()

  /**
   * Claim a key combination.
   *
   * @returns a disposer that releases it, or `undefined` when the combination
   *   is reserved, malformed, or already registered.
   */
  register(shortcut: TuiShortcut): (() => void) | undefined {
    const problem = shortcutProblem(shortcut.combo, new Set(this.shortcuts.keys()))
    if (problem !== undefined) return undefined
    this.shortcuts.set(shortcut.combo, shortcut)
    return () => {
      // Only release it if this exact registration still owns the combo.
      if (this.shortcuts.get(shortcut.combo) === shortcut) this.shortcuts.delete(shortcut.combo)
    }
  }

  /** Every registered combination, in registration order. */
  registered(): readonly TuiShortcut[] {
    return [...this.shortcuts.values()]
  }

  /** The label for one combination, when it is claimed. */
  labelOf(combo: string): string | undefined {
    return this.shortcuts.get(combo)?.label
  }

  /**
   * Run the handler for one key, if a plugin owns it.
   *
   * @returns whether the key was claimed, so the app can stop before it treats
   *   the key as text.
   */
  dispatch(combo: string): boolean {
    const shortcut = this.shortcuts.get(combo)
    if (shortcut === undefined) return false
    shortcut.handler()
    return true
  }
}

/** The one-line status slot, also independent of Cordis. */
export class StatusLine {
  private line: string | undefined

  /**
   * Contribute the line. The slot is replaced, not stacked: a terminal has one
   * line to give, and last registration wins — the same rule a status bar has.
   */
  set(text: string | undefined): () => void {
    const previous = this.line
    const applied = text === '' ? undefined : text
    this.line = applied
    return () => {
      // Only restore if nothing newer has taken the line since.
      if (this.line === applied) this.line = previous
    }
  }

  get(): string | undefined {
    return this.line
  }
}

/** One row a plugin panel asks the host to draw. */
export interface TuiPanelRow {
  id: string
  title: string
  subtitle: string
  /** Draws the row's "on" marker. */
  active?: boolean
}

/**
 * A masked prompt the host raises on a panel's behalf.
 *
 * The host owns the input surface, so the plugin never sees the draft until
 * `submit`; the value crosses the seam only once, answered.
 */
export interface TuiPanelSecret {
  kind: 'secret'
  message: string
  placeholder?: string
  submit: (value: string) => void | Promise<void>
}

/** What activating a panel row produced: nothing, or a secret to ask for. */
export type TuiPanelResult = void | TuiPanelSecret

/**
 * A command panel a plugin contributes to the host.
 *
 * The plugin owns what the panel means — its rows, its toggles, its prompts —
 * and the host owns how a panel looks and which keys drive it. Registering one
 * adds `<name>` to the command palette.
 */
export interface TuiPanel {
  /** Palette command name, without the slash. */
  name: string
  /** Panel heading; defaults to `name`. */
  title?: string
  /** One-line palette description. */
  description: string
  /** The rows to draw right now. */
  rows(): TuiPanelRow[]
  /** The row chosen with enter; may return a secret prompt to raise. */
  activate(id: string): TuiPanelResult | Promise<TuiPanelResult>
}

/** Contributed panels, keyed by lowercased command name. */
export class PanelRegistry {
  private readonly panels = new Map<string, TuiPanel>()

  /**
   * Claim a panel command.
   *
   * @returns a disposer that releases it, or `undefined` when the name is
   *   empty or already taken.
   */
  register(panel: TuiPanel): (() => void) | undefined {
    const key = panel.name.trim().toLowerCase()
    if (key === '' || this.panels.has(key)) return undefined
    this.panels.set(key, panel)
    return () => {
      if (this.panels.get(key) === panel) this.panels.delete(key)
    }
  }

  /** Every registered panel, in registration order. */
  registered(): readonly TuiPanel[] {
    return [...this.panels.values()]
  }

  /** The panel registered under a command name, case-insensitively. */
  find(name: string): TuiPanel | undefined {
    return this.panels.get(name.trim().toLowerCase())
  }
}
