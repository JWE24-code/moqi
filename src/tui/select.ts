/**
 * Mouse-drag selection: the span between two screen cells, the text it
 * covers, and the highlight painted over the frame.
 *
 * One module owns everything the drag feature needs beyond event delivery, so
 * the app only routes `click`/`drag`/`release` keys here and copies what
 * `spanText` returns. All of it is pure — the caller holds the frame lines.
 * @module
 */

import { selected } from './theme.ts'
import { displayWidth, sliceColumns, stripAnsi } from './text.ts'

/** One screen cell, 0-indexed, as the key decoder reports it. */
export interface Cell {
  row: number
  column: number
}

/** A selection: where the press landed and where the pointer is now. */
export interface Span {
  anchor: Cell
  head: Cell
}

/** The span's two corners in reading order (top row first, columns next). */
export function ordered(span: Span): { start: Cell; end: Cell } {
  const before =
    span.anchor.row < span.head.row ||
    (span.anchor.row === span.head.row && span.anchor.column <= span.head.column)
  return before ? { start: span.anchor, end: span.head } : { start: span.head, end: span.anchor }
}

/** Whether the pointer has moved off the anchor, i.e. a drag and not a click. */
export function isDrag(span: Span): boolean {
  return span.anchor.row !== span.head.row || span.anchor.column !== span.head.column
}

/**
 * The plain text a span covers in the painted frame, rows joined by newlines.
 *
 * Selection is rectangular — the eye dragged a box, so that is what it gets —
 * over the stripped text of each row, with the edges cut at the pointer's
 * columns and full rows in between.
 */
export function spanText(lines: readonly string[], span: Span): string {
  const { start, end } = ordered(span)
  const out: string[] = []
  for (let row = start.row; row <= end.row; row += 1) {
    const line = lines[row]
    if (line === undefined) continue
    const text = stripAnsi(line).trimEnd()
    const width = displayWidth(text)
    const from = row === start.row ? Math.min(start.column, width) : 0
    const to = row === end.row ? Math.min(end.column, width) : width
    out.push(sliceColumns(text, from, to).trimEnd())
  }
  return out.join('\n')
}

/**
 * The frame with the span's rows restyled as the selection highlight.
 *
 * Highlighted rows are rebuilt from their plain text with the `selected`
 * palette: inverting a slice of an already-styled line would cut SGR runs
 * mid-sequence, and a highlighted row that briefly loses its colors reads
 * clearly as "this is what will be copied". Rows outside the span pass
 * through untouched, so one drag repaints at most the span's rows.
 */
export function highlighted(lines: readonly string[], span: Span): string[] {
  const { start, end } = ordered(span)
  return lines.map((line, row) => {
    if (row < start.row || row > end.row) return line
    const plain = stripAnsi(line)
    const width = displayWidth(plain)
    const from = row === start.row ? Math.min(start.column, width) : 0
    const to = row === end.row ? Math.min(end.column, width) : width
    if (to <= from) return line
    return `${sliceColumns(plain, 0, from)}${selected(sliceColumns(plain, from, to))}${sliceColumns(plain, to, width)}`
  })
}
