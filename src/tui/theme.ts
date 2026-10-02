/**
 * Palette and text styling for the terminal app.
 *
 * The colors default to the Rose Pine-ish pair the original Go client used,
 * kept as explicit light/dark variants so the app reads on either terminal
 * background. Everything emits truecolor SGR directly: the app already owns
 * the screen, so there is no styling library between it and the escape codes.
 *
 * Which palette is in force is swappable at runtime — see {@link applyTheme}
 * and the table in `themes.ts`. That is deliberately orthogonal to the
 * light/dark question: a theme supplies both variants, and the terminal's own
 * background still decides which of the two is drawn.
 * @module
 */

import { DEFAULT_PALETTE, DEFAULT_THEME, findTheme, THEMES, type Theme } from './themes.ts'

/** One color with a variant per terminal background. */
export interface AdaptiveColor {
  light: string
  dark: string
}

/**
 * Copy a palette entry into a fresh object.
 *
 * The exported constants have to be objects this module owns, not the table's
 * own, because {@link applyTheme} writes through them — sharing them with the
 * table would let one theme switch overwrite the palette it came from.
 */
function seed(color: AdaptiveColor): AdaptiveColor {
  return { light: color.light, dark: color.dark }
}

export const colAccent: AdaptiveColor = seed(DEFAULT_PALETTE.accent)
export const colMuted: AdaptiveColor = seed(DEFAULT_PALETTE.muted)
export const colBorder: AdaptiveColor = seed(DEFAULT_PALETTE.border)
export const colText: AdaptiveColor = seed(DEFAULT_PALETTE.text)
export const colWarn: AdaptiveColor = seed(DEFAULT_PALETTE.warn)
export const colOK: AdaptiveColor = seed(DEFAULT_PALETTE.ok)
export const colGreen: AdaptiveColor = seed(DEFAULT_PALETTE.green)
export const colGold: AdaptiveColor = seed(DEFAULT_PALETTE.gold)
export const colRose: AdaptiveColor = seed(DEFAULT_PALETTE.rose)
export const colInvert: AdaptiveColor = seed(DEFAULT_PALETTE.invert)

/** Which palette {@link applyTheme} last installed. */
let active = DEFAULT_THEME

/**
 * Install a named palette, returning false when there is no such theme.
 *
 * Every other module imported the color constants by name, so the switch has
 * to happen *through* those objects rather than by replacing them: an import
 * binding points at the object that existed when the module was evaluated,
 * and reassigning the constant here would leave every call site drawing with
 * the old palette. Writing the two fields in place is what makes a theme
 * change a one-line operation instead of a rewrite of every view.
 *
 * An unknown name is reported rather than thrown: it arrives from `/theme
 * <name>` or from a state file written by a future version, and neither is a
 * reason to take the app down.
 */
export function applyTheme(name: string): boolean {
  const theme = findTheme(name)
  if (theme === undefined) return false
  const pairs: [AdaptiveColor, AdaptiveColor][] = [
    [colAccent, theme.colors.accent],
    [colMuted, theme.colors.muted],
    [colBorder, theme.colors.border],
    [colText, theme.colors.text],
    [colWarn, theme.colors.warn],
    [colOK, theme.colors.ok],
    [colGreen, theme.colors.green],
    [colGold, theme.colors.gold],
    [colRose, theme.colors.rose],
    [colInvert, theme.colors.invert],
  ]
  for (const [target, source] of pairs) {
    target.light = source.light
    target.dark = source.dark
  }
  active = theme.name
  return true
}

/** The name of the palette currently installed. */
export function activeTheme(): string {
  return active
}

/** Every palette {@link applyTheme} will accept, in the order to list them. */
export function listThemes(): readonly Theme[] {
  return THEMES
}

/**
 * Re-exported so a caller that only wants to list or name a palette imports
 * this module alone, the way every drawing module already does.
 */
export type { Theme, ThemePalette } from './themes.ts'

/**
 * Whether this terminal is being treated as dark. `MOQI_THEME` wins; the
 * `COLORFGBG` convention decides otherwise; dark is the fallback because it is
 * the common default and the safer miss.
 */
function detectDark(): boolean {
  const forced = process.env['MOQI_THEME']
  if (forced === 'light') return false
  if (forced === 'dark') return true
  const fgbg = process.env['COLORFGBG']
  if (fgbg !== undefined) {
    const background = fgbg.split(';').pop()
    if (background !== undefined && /^\d+$/.test(background)) {
      const value = Number(background)
      // 0-6 and 8 are the dark background slots in the COLORFGBG convention.
      return value <= 6 || value === 8
    }
  }
  return true
}

let dark = detectDark()

/**
 * Re-read the environment, so a change of terminal background applies without
 * a restart. This is about the light/dark variant only — the choice of
 * palette is {@link applyTheme}'s.
 */
export function refreshTheme(): void {
  dark = detectDark()
}

/** Whether styling currently targets a dark background. */
export function isDark(): boolean {
  return dark
}

/** Resolve an adaptive color against the active background. */
export function resolve(color: AdaptiveColor): string {
  return dark ? color.dark : color.light
}

/** Whether color should be emitted at all. Honors the NO_COLOR convention. */
const colorEnabled = process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb'

function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ]
}

/** WCAG relative luminance of a resolved color. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * WCAG contrast ratio between two colors, 1 (identical) to 21 (black/white).
 * 4.5 is the AA threshold for body text.
 */
export function contrastRatio(a: AdaptiveColor, b: AdaptiveColor): number {
  const first = luminance(resolve(a))
  const second = luminance(resolve(b))
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/**
 * Text on a colored bar: the given background, and whichever of the palette's
 * two text colors reads better on it.
 *
 * Which one that is cannot be assumed — a bar that takes white text on a dark
 * terminal may need dark text for the same palette's light variant — so the
 * pair is measured rather than picked.
 */
export function readableOn(background: AdaptiveColor): StyleOptions {
  const candidates: AdaptiveColor[] = [colText, colInvert]
  const best = candidates.reduce((a, b) =>
    contrastRatio(background, b) > contrastRatio(background, a) ? b : a,
  )
  return { bg: background, fg: best }
}

const ESC = ''

/** Clears every attribute set by {@link style}. */
export const RESET = `${ESC}[0m`

/** Attributes a style can carry beyond its colors. */
export interface StyleOptions {
  fg?: AdaptiveColor
  bg?: AdaptiveColor
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
  strike?: boolean
}

/**
 * Build the SGR prefix for a style, or an empty string when the style would
 * emit nothing (color disabled and no text attributes).
 */
function prefix(options: StyleOptions): string {
  const codes: string[] = []
  if (options.bold === true) codes.push('1')
  if (options.dim === true) codes.push('2')
  if (options.italic === true) codes.push('3')
  if (options.underline === true) codes.push('4')
  if (options.strike === true) codes.push('9')
  if (colorEnabled) {
    if (options.fg !== undefined) {
      const [r, g, b] = channels(resolve(options.fg))
      codes.push(`38;2;${r};${g};${b}`)
    }
    if (options.bg !== undefined) {
      const [r, g, b] = channels(resolve(options.bg))
      codes.push(`48;2;${r};${g};${b}`)
    }
  }
  if (codes.length === 0) return ''
  return `${ESC}[${codes.join(';')}m`
}

/**
 * Wrap text in a style. Each line is styled independently so a styled block
 * survives being split, padded, or placed beside other cells.
 */
export function style(text: string, options: StyleOptions): string {
  const open = prefix(options)
  if (open === '') return text
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `${open}${line}${RESET}`))
    .join('\n')
}

export const muted = (text: string): string => style(text, { fg: colMuted })
export const warn = (text: string): string => style(text, { fg: colWarn })
export const ok = (text: string): string => style(text, { fg: colOK })
export const bold = (text: string): string => style(text, { fg: colText, bold: true })
export const accent = (text: string): string => style(text, { fg: colAccent })
export const selected = (text: string): string =>
  style(text, { fg: colInvert, bg: colAccent, bold: true })
