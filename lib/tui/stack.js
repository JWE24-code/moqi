/**
 * The stacked view: auto-tiling geometry for showing every open session at
 * once, and the stitching that turns per-pane bodies into one frame region.
 *
 * Geometry and seams live here; what a pane shows does not. The caller hands
 * in a `renderBody` callback and receives finished lines, so this module never
 * needs to know how a transcript is drawn. Everything is pure.
 * @module
 */
import { padEnd, truncate } from "./text.js";
import { accent } from "./theme.js";
/**
 * The grid the panes tile into: the most square arrangement that fits `count`.
 *
 * Two sessions split side by side, three make a row of three or a 2+1, four
 * and up settle into a near-square grid — the auto-tile answer, and the same
 * math `focusNeighbor` uses, so directions on screen and in the tab order
 * always agree.
 */
export function tileGrid(count) {
    const columns = Math.max(Math.ceil(Math.sqrt(count)), 1);
    const rows = Math.max(Math.ceil(count / columns), 1);
    return { columns, rows };
}
/** Every pane's rectangle, laid out row-major inside a `width`×`height` region. */
export function tiles(count, width, height) {
    const { columns, rows } = tileGrid(count);
    const out = [];
    for (let index = 0; index < count; index += 1) {
        const column = index % columns;
        const row = Math.floor(index / columns);
        // The last row and column absorb the remainder, so no cell is lost to
        // rounding and every pane keeps at least a one-cell body.
        const isLastColumn = column === columns - 1;
        const isLastRow = row === rows - 1;
        out.push({
            x: Math.floor((width / columns) * column),
            y: Math.floor((height / rows) * row),
            width: isLastColumn
                ? width - Math.floor((width / columns) * column)
                : Math.floor(width / columns),
            height: isLastRow
                ? height - Math.floor((height / rows) * row)
                : Math.floor(height / rows),
        });
    }
    return out;
}
/**
 * The pane in a direction from `focused`, or `undefined` when the edge is
 * there. Left/right walk a row; up/down jump a whole row of the same grid
 * `tiles` used, so what is beside the focused pane on screen is what gets
 * focused.
 */
export function focusNeighbor(count, focused, direction) {
    const { columns } = tileGrid(count);
    const column = focused % columns;
    const row = Math.floor(focused / columns);
    const target = direction === 'left'
        ? column === 0
            ? undefined
            : focused - 1
        : direction === 'right'
            ? column === columns - 1 || focused + 1 >= count
                ? undefined
                : focused + 1
            : direction === 'up'
                ? row === 0
                    ? undefined
                    : focused - columns
                : focused + columns >= count
                    ? undefined
                    : focused + columns;
    return target !== undefined && target >= 0 && target < count ? target : undefined;
}
/** Compose every pane's body into `height` lines of `width` columns. */
export function stackFrame(options) {
    const { count, width, height, focused, title, renderBody } = options;
    if (count < 1 || width < 1 || height < 1)
        return [];
    // The canvas is plain text plus styled slices, so cells join with spaces.
    const canvas = Array.from({ length: height }, () => []);
    for (const row of canvas)
        for (let x = 0; x < width; x += 1)
            row.push(' ');
    for (const [index, tile] of tiles(count, width, height).entries()) {
        const isFocused = index === focused;
        // A focused pane claims attention with its border, not with a title it
        // already has: the accent is the only thing that changes between panes.
        const top = isFocused ? '─' : '·';
        const label = truncate(title(index), Math.max(tile.width - 4, 1));
        // Top border: ` label ` fills the tile's width. Focus is legible without
        // color too — a solid rule for the focused pane, dots for the rest — and
        // the accent border colors it for eyes that have that channel.
        const cells = padEnd(` ${label} `, tile.width).split('');
        if (tile.width > 1) {
            cells[0] = top;
            cells[tile.width - 1] = top;
        }
        const border = cells.join('');
        canvas[tile.y]?.splice(tile.x, tile.width, ...(isFocused ? accent(border) : border).split(''));
        const innerHeight = Math.max(tile.height - 1, 0);
        // The tail of the body is what shows — a transcript reads from its bottom,
        // where the newest turn is — and a short one is top-padded so that bottom
        // stays anchored to the tile's lower edge.
        const rendered = renderBody(index, Math.max(tile.width - 2, 1), innerHeight);
        const body = [
            ...Array(Math.max(innerHeight - rendered.length, 0)).fill(''),
            ...rendered,
        ].slice(-innerHeight);
        for (let row = 0; row < innerHeight; row += 1) {
            const line = body[row] ?? '';
            canvas[tile.y + 1 + row]?.splice(tile.x, tile.width, ' ', ...padEnd(truncate(line, tile.width - 2), tile.width - 2).split(''), ' ');
        }
    }
    return canvas.map((row) => row.join(''));
}
