/**
 * Width-aware text helpers.
 *
 * Every measurement in the app goes through {@link displayWidth}, which ignores
 * SGR escapes and counts East Asian wide characters as two columns. Without
 * that, styled or CJK content silently breaks the column arithmetic the whole
 * layout depends on.
 * @module
 */
/** Remove every escape sequence, leaving the printable text. */
export declare function stripAnsi(text: string): string;
/** Printable width of a string in terminal columns, ignoring escapes. */
export declare function displayWidth(text: string): number;
/**
 * Cut a string to `limit` columns, appending an ellipsis when it did not fit.
 * Escape sequences pass through so styling is never severed mid-code, and a
 * reset is appended when the cut text carried any styling.
 */
export declare function truncate(text: string, limit: number): string;
/** Pad a string on the right to `width` columns. */
export declare function padEnd(text: string, width: number): string;
/**
 * The text occupying columns `[start, end)` of a display string.
 *
 * Selection copies what the eye saw, so the cut is by screen column: escapes
 * carry no width and pass through untouched, and a wide character straddling
 * an edge belongs to the span when its first half is inside it.
 */
export declare function sliceColumns(text: string, start: number, end: number): string;
/**
 * Hard-wrap plain text to `width` columns, breaking on spaces where possible
 * and mid-word only when a single word cannot fit on a line of its own.
 */
export declare function wrap(text: string, width: number): string[];
/** Take exactly as many code points as fit in `width` columns, no ellipsis. */
export declare function cut(text: string, width: number): string;
