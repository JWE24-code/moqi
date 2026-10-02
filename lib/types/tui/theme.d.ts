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
import { type Theme } from './themes.ts';
/** One color with a variant per terminal background. */
export interface AdaptiveColor {
    light: string;
    dark: string;
}
export declare const colAccent: AdaptiveColor;
export declare const colMuted: AdaptiveColor;
export declare const colBorder: AdaptiveColor;
export declare const colText: AdaptiveColor;
export declare const colWarn: AdaptiveColor;
export declare const colOK: AdaptiveColor;
export declare const colGreen: AdaptiveColor;
export declare const colGold: AdaptiveColor;
export declare const colRose: AdaptiveColor;
export declare const colInvert: AdaptiveColor;
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
export declare function applyTheme(name: string): boolean;
/** The name of the palette currently installed. */
export declare function activeTheme(): string;
/** Every palette {@link applyTheme} will accept, in the order to list them. */
export declare function listThemes(): readonly Theme[];
/**
 * Re-exported so a caller that only wants to list or name a palette imports
 * this module alone, the way every drawing module already does.
 */
export type { Theme, ThemePalette } from './themes.ts';
/**
 * Re-read the environment, so a change of terminal background applies without
 * a restart. This is about the light/dark variant only — the choice of
 * palette is {@link applyTheme}'s.
 */
export declare function refreshTheme(): void;
/** Whether styling currently targets a dark background. */
export declare function isDark(): boolean;
/** Resolve an adaptive color against the active background. */
export declare function resolve(color: AdaptiveColor): string;
/**
 * WCAG contrast ratio between two colors, 1 (identical) to 21 (black/white).
 * 4.5 is the AA threshold for body text.
 */
export declare function contrastRatio(a: AdaptiveColor, b: AdaptiveColor): number;
/**
 * Text on a colored bar: the given background, and whichever of the palette's
 * two text colors reads better on it.
 *
 * Which one that is cannot be assumed — a bar that takes white text on a dark
 * terminal may need dark text for the same palette's light variant — so the
 * pair is measured rather than picked.
 */
export declare function readableOn(background: AdaptiveColor): StyleOptions;
/** Clears every attribute set by {@link style}. */
export declare const RESET = "\u001B[0m";
/** Attributes a style can carry beyond its colors. */
export interface StyleOptions {
    fg?: AdaptiveColor;
    bg?: AdaptiveColor;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    dim?: boolean;
    strike?: boolean;
}
/**
 * Wrap text in a style. Each line is styled independently so a styled block
 * survives being split, padded, or placed beside other cells.
 */
export declare function style(text: string, options: StyleOptions): string;
export declare const muted: (text: string) => string;
export declare const warn: (text: string) => string;
export declare const ok: (text: string) => string;
export declare const bold: (text: string) => string;
export declare const accent: (text: string) => string;
export declare const selected: (text: string) => string;
