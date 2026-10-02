/**
 * Width-aware text helpers.
 *
 * Every measurement in the app goes through {@link displayWidth}, which ignores
 * SGR escapes and counts East Asian wide characters as two columns. Without
 * that, styled or CJK content silently breaks the column arithmetic the whole
 * layout depends on.
 * @module
 */

const ESC = ''
const BEL = ''

/** Matches an ANSI escape sequence (CSI or OSC), which occupies no columns. */
const ANSI_PATTERN = String.raw`${ESC}\[[0-9;?]*[ -/]*[@-~]|${ESC}\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\)`

function ansiRegex(): RegExp {
  return new RegExp(ANSI_PATTERN, 'g')
}

/** Remove every escape sequence, leaving the printable text. */
export function stripAnsi(text: string): string {
  return text.replace(ansiRegex(), '')
}

/** Whether a code point renders two columns wide. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/** Whether a code point is a zero-width joiner, selector, or combining mark. */
function isZeroWidth(code: number): boolean {
  return (
    code === 0x200b ||
    code === 0x200c ||
    code === 0x200d ||
    code === 0xfe0f ||
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x20d0 && code <= 0x20ff)
  )
}

/** Width of one code point in terminal columns. */
function charWidth(code: number): number {
  if (isZeroWidth(code)) return 0
  return isWide(code) ? 2 : 1
}

/** Printable width of a string in terminal columns, ignoring escapes. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0)
    if (code === undefined) continue
    width += charWidth(code)
  }
  return width
}

/** The escape sequence starting at `index`, when there is one. */
function escapeAt(text: string, index: number): string | undefined {
  if (text[index] !== ESC) return undefined
  const regex = ansiRegex()
  regex.lastIndex = index
  const match = regex.exec(text)
  if (match?.index !== index) return undefined
  return match[0]
}

/**
 * Cut a string to `limit` columns, appending an ellipsis when it did not fit.
 * Escape sequences pass through so styling is never severed mid-code, and a
 * reset is appended when the cut text carried any styling.
 */
export function truncate(text: string, limit: number): string {
  if (limit <= 0) return ''
  if (displayWidth(text) <= limit) return text
  const budget = limit <= 1 ? limit : limit - 1
  let out = ''
  let width = 0
  let index = 0
  let styled = false
  while (index < text.length) {
    const escape = escapeAt(text, index)
    if (escape !== undefined) {
      out += escape
      styled = true
      index += escape.length
      continue
    }
    const code = text.codePointAt(index)
    if (code === undefined) break
    const char = String.fromCodePoint(code)
    const width0 = charWidth(code)
    if (width + width0 > budget) break
    out += char
    width += width0
    index += char.length
  }
  const reset = styled ? `${ESC}[0m` : ''
  const tail = limit <= 1 ? '' : '…'
  return `${out}${reset}${tail}`
}

/** Pad a string on the right to `width` columns. */
export function padEnd(text: string, width: number): string {
  const pad = width - displayWidth(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}

/**
 * The text occupying columns `[start, end)` of a display string.
 *
 * Selection copies what the eye saw, so the cut is by screen column: escapes
 * carry no width and pass through untouched, and a wide character straddling
 * an edge belongs to the span when its first half is inside it.
 */
export function sliceColumns(text: string, start: number, end: number): string {
  if (end <= start) return ''
  let column = 0
  let out = ''
  let index = 0
  // Escapes carry no width, so they pass through wherever they occur —
  // including the reset that follows the last kept character, which is what
  // keeps a cut styled string from bleeding its color past the slice.
  let done = false
  while (index < text.length) {
    const escape = escapeAt(text, index)
    if (escape !== undefined) {
      out += escape
      index += escape.length
      continue
    }
    if (done) break
    const code = text.codePointAt(index) ?? 0
    const width = charWidth(code)
    if (column + width > start && column < end) out += String.fromCodePoint(code)
    column += width
    index += String.fromCodePoint(code).length
    if (column >= end) done = true
  }
  return out
}

/**
 * Hard-wrap plain text to `width` columns, breaking on spaces where possible
 * and mid-word only when a single word cannot fit on a line of its own.
 */
export function wrap(text: string, width: number): string[] {
  if (width < 1) return text.split('\n')
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') out.push('')
    else wrapParagraph(paragraph, width, out)
  }
  return out
}

/** Wrap one paragraph's words into `out`, breaking overlong words hard. */
function wrapParagraph(paragraph: string, width: number, out: string[]): void {
  let line = ''
  for (const word of paragraph.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`
    if (displayWidth(candidate) <= width) {
      line = candidate
      continue
    }
    if (line !== '') out.push(line)
    let rest = word
    while (displayWidth(rest) > width) {
      const head = cut(rest, width)
      out.push(head)
      rest = rest.slice(head.length)
    }
    line = rest
  }
  out.push(line)
}

/** Take exactly as many code points as fit in `width` columns, no ellipsis. */
export function cut(text: string, width: number): string {
  let out = ''
  let used = 0
  let index = 0
  while (index < text.length) {
    const code = text.codePointAt(index)
    if (code === undefined) break
    const char = String.fromCodePoint(code)
    const w = charWidth(code)
    if (used + w > width) break
    out += char
    used += w
    index += char.length
  }
  return out
}
