/**
 * The stacked view: auto-tiling geometry for showing every open session at
 * once, and the stitching that turns per-pane bodies into one frame region.
 *
 * Geometry and seams live here; what a pane shows does not. The caller hands
 * in a `renderBody` callback and receives finished lines, so this module never
 * needs to know how a transcript is drawn. Everything is pure.
 * @module
 */

import { padEnd, truncate } from './text.ts'
import { muted, style, colAccent, colWarn, colOK } from './theme.ts'

/** A pane's rectangle inside the frame region, 0-indexed. */
export interface Tile {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The grid the panes tile into: the most square arrangement that fits `count`.
 *
 * Two sessions split side by side, three make a row of three or a 2+1, four
 * and up settle into a near-square grid — the auto-tile answer, and the same
 * math `focusNeighbor` uses, so directions on screen and in the tab order
 * always agree.
 */
export function tileGrid(count: number): { columns: number; rows: number } {
  const columns = Math.max(Math.ceil(Math.sqrt(count)), 1)
  const rows = Math.max(Math.ceil(count / columns), 1)
  return { columns, rows }
}

/** Every pane's rectangle, laid out row-major inside a `width`×`height` region. */
export function tiles(count: number, width: number, height: number): Tile[] {
  const { columns, rows } = tileGrid(count)
  const out: Tile[] = []
  for (let index = 0; index < count; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    // The last row and column absorb the remainder, so no cell is lost to
    // rounding and every pane keeps at least a one-cell body.
    const isLastColumn = column === columns - 1
    const isLastRow = row === rows - 1
    out.push({
      x: Math.floor((width / columns) * column),
      y: Math.floor((height / rows) * row),
      width: isLastColumn
        ? width - Math.floor((width / columns) * column)
        : Math.floor(width / columns),
      height: isLastRow
        ? height - Math.floor((height / rows) * row)
        : Math.floor(height / rows),
    })
  }
  return out
}

/** Directional focus moves, named for the arrow keys that drive them. */
export type Direction = 'up' | 'down' | 'left' | 'right'

/**
 * The pane in a direction from `focused`, or `undefined` when the edge is
 * there. Left/right walk a row; up/down jump a whole row of the same grid
 * `tiles` used, so what is beside the focused pane on screen is what gets
 * focused.
 */
export function focusNeighbor(
  count: number,
  focused: number,
  direction: Direction,
): number | undefined {
  const { columns } = tileGrid(count)
  const column = focused % columns
  const row = Math.floor(focused / columns)
  const target =
    rowNeighbor(count, columns, row, focused, direction) ??
    columnNeighbor(count, columns, column, focused, direction)
  return target !== undefined && target >= 0 && target < count ? target : undefined
}

/** The pane above or below `focused`, or undefined off the grid or direction. */
function rowNeighbor(
  count: number,
  columns: number,
  row: number,
  focused: number,
  direction: Direction,
): number | undefined {
  if (direction === 'up') return row === 0 ? undefined : focused - columns
  if (direction === 'down') return focused + columns >= count ? undefined : focused + columns
  return undefined
}

/** The pane left or right of `focused`, or undefined off the row or direction. */
function columnNeighbor(
  count: number,
  columns: number,
  column: number,
  focused: number,
  direction: Direction,
): number | undefined {
  if (direction === 'left') return column === 0 ? undefined : focused - 1
  if (direction === 'right') {
    return column === columns - 1 || focused + 1 >= count ? undefined : focused + 1
  }
  return undefined
}

/** What the stitcher needs to turn a set of panes into frame lines. */
export interface StackFrame {
  /** Panes laid out; the grid and tile math derive from this count. */
  count: number
  /** Size of the region the tiles fill. */
  width: number
  height: number
  /** The pane with keyboard focus, drawn with the accent border. */
  focused: number
  /** The label in a pane's top border — its session title. */
  title: (index: number) => string
  /**
   * One pane's body at the given inner size, already the right length or
   * shorter; shorter bodies are top-padded so transcripts stay anchored to
   * the bottom of their tile.
   */
  renderBody: (index: number, innerWidth: number, innerHeight: number) => string[]
  /**
   * A pane asking for the user: `input` waits on an approval or question,
   * `done` finished a reply nobody has read yet. An attention pane's border
   * carries the highlight color — warn for input, ok for done — instead of
   * the focus accent, and blinks while `blinkOn` alternates.
   */
  attention?: (index: number) => 'input' | 'done' | undefined
  /** The blink phase, alternated by the app while any pane has attention. */
  blinkOn?: boolean
}

/** A blank canvas of single-character cells the tiles write into. */
function initCanvas(width: number, height: number): string[][] {
  const canvas: string[][] = Array.from({ length: height }, () => [])
  for (const row of canvas) for (let x = 0; x < width; x += 1) row.push(' ')
  return canvas
}

/** How a pane's border line is styled, by its attention and focus. */
function paneBorder(
  mark: 'input' | 'done' | undefined,
  isFocused: boolean,
  blinkOn: boolean | undefined,
): (line: string) => string {
  // Every pane sits in a full line box, so sessions read as separate
  // surfaces; the focused pane's whole border is the accent in bold, the
  // rest are dim. Bold survives NO_COLOR terminals, so focus stays legible
  // even where color does not. An attention pane outranks focus with the
  // highlight color — warn for input, ok for done — and blinks by falling
  // back to dim on the off phase, so the eye catches it without focus.
  return (line: string): string => {
    if (mark !== undefined && (blinkOn === true || isFocused)) {
      return style(line, { fg: mark === 'input' ? colWarn : colOK, bold: true })
    }
    if (mark !== undefined) return muted(line)
    return isFocused ? style(line, { fg: colAccent, bold: true }) : muted(line)
  }
}

/** The label in a pane's top border, with its attention marker if any. */
function paneTitle(title: string, mark: 'input' | 'done' | undefined, width: number): string {
  const label = truncate(title, Math.max(width - 6, 1))
  // The attention marker rides the title: `!` waits on you, `✓` finished
  // for you — one glyph, legible in every interface language.
  let marked = label
  if (mark === 'input') marked = `! ${label}`
  else if (mark === 'done') marked = `✓ ${label}`
  return padEnd(` ${marked} `, Math.max(width - 2, 0))
}

/** A pane body fit to its tile: clipped per line, padded, bottom-anchored. */
function paneBody(
  rendered: string[],
  tile: { width: number },
  innerHeight: number,
  border: (line: string) => string,
): string[] {
  // The tail of the body is what shows — a transcript reads from its bottom,
  // where the newest turn is — and a short one is top-padded so that bottom
  // stays anchored just above the pane's lower border.
  const body = [
    ...Array<string>(Math.max(innerHeight - rendered.length, 0)).fill(''),
    ...rendered,
  ].slice(-innerHeight)
  // Only the walls take the border style: a body line carries its own
  // colors, and an escape inside it would end a wrap-around style early.
  const out: string[] = []
  for (let row = 0; row < innerHeight; row += 1) {
    const line = body[row] ?? ''
    const inner = padEnd(truncate(line, Math.max(tile.width - 2, 1)), Math.max(tile.width - 2, 0))
    out.push(tile.width > 2 ? `${border('│')}${inner}${border('│')}` : inner)
  }
  return out
}

/** Compose every pane's body into `height` lines of `width` columns. */
export function stackFrame(options: StackFrame): string[] {
  const { count, width, height, focused, title, renderBody, attention, blinkOn } = options
  if (count < 1 || width < 1 || height < 1) return []

  // The canvas is plain text plus styled slices, so cells join with spaces.
  const canvas = initCanvas(width, height)

  for (const [index, tile] of tiles(count, width, height).entries()) {
    const mark = attention?.(index)
    const border = paneBorder(mark, index === focused, blinkOn)
    // A tile's line is written as one cell — styled text cannot be split into
    // per-character cells without its escapes shifting everything after it —
    // and the cells it covers are emptied, so the grid's indices stay honest
    // for the tiles written after it.
    const place = (row: number, line: string): void => {
      const cells = canvas[row]
      if (cells === undefined) return
      cells.splice(tile.x, tile.width, line, ...Array<string>(tile.width - 1).fill(''))
    }

    const top = paneTitle(title(index), mark, tile.width)
    place(tile.y, border(tile.width > 2 ? `┌${top}┐` : top))

    const innerHeight = Math.max(tile.height - 2, 0)
    const rendered = renderBody(index, Math.max(tile.width - 2, 1), innerHeight)
    paneBody(rendered, tile, innerHeight, border).forEach((line, row) => {
      place(tile.y + 1 + row, line)
    })

    if (innerHeight >= 0 && tile.height >= 2) {
      const bottom = '─'.repeat(Math.max(tile.width - 2, 0))
      place(tile.y + tile.height - 1, border(tile.width > 2 ? `└${bottom}┘` : bottom))
    }
  }
  return canvas.map((row) => row.join(''))
}
