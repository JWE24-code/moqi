/**
 * The stacked view: auto-tiling geometry for showing every open session at
 * once, and the stitching that turns per-pane bodies into one frame region.
 *
 * Geometry and seams live here; what a pane shows does not. The caller hands
 * in a `renderBody` callback and receives finished lines, so this module never
 * needs to know how a transcript is drawn. Everything is pure.
 * @module
 */
/** A pane's rectangle inside the frame region, 0-indexed. */
export interface Tile {
    x: number;
    y: number;
    width: number;
    height: number;
}
/**
 * The grid the panes tile into: the most square arrangement that fits `count`.
 *
 * Two sessions split side by side, three make a row of three or a 2+1, four
 * and up settle into a near-square grid — the auto-tile answer, and the same
 * math `focusNeighbor` uses, so directions on screen and in the tab order
 * always agree.
 */
export declare function tileGrid(count: number): {
    columns: number;
    rows: number;
};
/** Every pane's rectangle, laid out row-major inside a `width`×`height` region. */
export declare function tiles(count: number, width: number, height: number): Tile[];
/** What a pane can want from the user; absent means it wants nothing. */
type Attention = 'input' | 'done';
/** Directional focus moves, named for the arrow keys that drive them. */
export type Direction = 'up' | 'down' | 'left' | 'right';
/**
 * The pane in a direction from `focused`, or `undefined` when the edge is
 * there. Left/right walk a row; up/down jump a whole row of the same grid
 * `tiles` used, so what is beside the focused pane on screen is what gets
 * focused.
 */
export declare function focusNeighbor(count: number, focused: number, direction: Direction): number | undefined;
/** What the stitcher needs to turn a set of panes into frame lines. */
export interface StackFrame {
    /** Panes laid out; the grid and tile math derive from this count. */
    count: number;
    /** Size of the region the tiles fill. */
    width: number;
    height: number;
    /** The pane with keyboard focus, drawn with the accent border. */
    focused: number;
    /** The label in a pane's top border — its session title. */
    title: (index: number) => string;
    /**
     * One pane's body at the given inner size, already the right length or
     * shorter; shorter bodies are top-padded so transcripts stay anchored to
     * the bottom of their tile.
     */
    renderBody: (index: number, innerWidth: number, innerHeight: number) => string[];
    /**
     * A pane asking for the user: `input` waits on an approval or question,
     * `done` finished a reply nobody has read yet. An attention pane's border
     * carries the highlight color — warn for input, ok for done — instead of
     * the focus accent, and blinks while `blinkOn` alternates.
     */
    attention?: (index: number) => Attention | undefined;
    /** The blink phase, alternated by the app while any pane has attention. */
    blinkOn?: boolean;
}
/** Compose every pane's body into `height` lines of `width` columns. */
export declare function stackFrame(options: StackFrame): string[];
export {};
