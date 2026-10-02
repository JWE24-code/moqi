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
import { muted, style, colAccent, colWarn, colOK } from "./theme.js";
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
    const { count, width, height, focused, title, renderBody, attention, blinkOn } = options;
    if (count < 1 || width < 1 || height < 1)
        return [];
    // The canvas is plain text plus styled slices, so cells join with spaces.
    const canvas = Array.from({ length: height }, () => []);
    for (const row of canvas)
        for (let x = 0; x < width; x += 1)
            row.push(' ');
    for (const [index, tile] of tiles(count, width, height).entries()) {
        const isFocused = index === focused;
        const mark = attention?.(index);
        // Every pane sits in a full line box, so sessions read as separate
        // surfaces; the focused pane's whole border is the accent in bold, the
        // rest are dim. Bold survives NO_COLOR terminals, so focus stays legible
        // even where color does not. An attention pane outranks focus with the
        // highlight color — warn for input, ok for done — and blinks by falling
        // back to dim on the off phase, so the eye catches it without focus.
        const styleBorder = (line) => {
            if (mark !== undefined && (blinkOn === true || isFocused)) {
                return style(line, { fg: mark === 'input' ? colWarn : colOK, bold: true });
            }
            if (mark !== undefined)
                return muted(line);
            return isFocused ? style(line, { fg: colAccent, bold: true }) : muted(line);
        };
        // A tile's line is written as one cell — styled text cannot be split into
        // per-character cells without its escapes shifting everything after it —
        // and the cells it covers are emptied, so the grid's indices stay honest
        // for the tiles written after it.
        const place = (row, line) => {
            const cells = canvas[row];
            if (cells === undefined)
                return;
            cells.splice(tile.x, tile.width, line, ...Array(tile.width - 1).fill(''));
        };
        const label = truncate(title(index), Math.max(tile.width - 6, 1));
        // The attention marker rides the title: `!` waits on you, `✓` finished
        // for you — one glyph, legible in every interface language.
        const marked = mark === 'input' ? `! ${label}` : mark === 'done' ? `✓ ${label}` : label;
        const top = padEnd(` ${marked} `, Math.max(tile.width - 2, 0));
        place(tile.y, styleBorder(tile.width > 2 ? `┌${top}┐` : top));
        const innerHeight = Math.max(tile.height - 2, 0);
        // The tail of the body is what shows — a transcript reads from its bottom,
        // where the newest turn is — and a short one is top-padded so that bottom
        // stays anchored just above the pane's lower border.
        const rendered = renderBody(index, Math.max(tile.width - 2, 1), innerHeight);
        const body = [
            ...Array(Math.max(innerHeight - rendered.length, 0)).fill(''),
            ...rendered,
        ].slice(-innerHeight);
        // Only the walls take the border style: a body line carries its own
        // colors, and an escape inside it would end a wrap-around style early.
        for (let row = 0; row < innerHeight; row += 1) {
            const line = body[row] ?? '';
            const inner = padEnd(truncate(line, Math.max(tile.width - 2, 1)), Math.max(tile.width - 2, 0));
            place(tile.y + 1 + row, tile.width > 2 ? `${styleBorder('│')}${inner}${styleBorder('│')}` : inner);
        }
        if (innerHeight >= 0 && tile.height >= 2) {
            const bottom = '─'.repeat(Math.max(tile.width - 2, 0));
            place(tile.y + tile.height - 1, styleBorder(tile.width > 2 ? `└${bottom}┘` : bottom));
        }
    }
    return canvas.map((row) => row.join(''));
}
