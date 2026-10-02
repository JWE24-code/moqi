/**
 * Markdown to ANSI rendering, plus a small syntax highlighter for fenced code.
 *
 * The original Go client leaned on glamour and chroma. This is the same job
 * done with no dependency: the transcript is re-rendered on every frame and
 * while a reply streams in, so the renderer must tolerate a half-written
 * document (an unterminated fence, a dangling emphasis run) without throwing
 * or swallowing text.
 * @module
 */

import {
  colAccent,
  colGold,
  colGreen,
  colMuted,
  colRose,
  colText,
  style,
} from './theme.ts'
import { displayWidth, wrap } from './text.ts'

/** Languages the highlighter knows keywords for. */
const KEYWORDS: Record<string, readonly string[]> = {
  js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'await', 'async', 'import', 'export', 'from', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'this', 'null', 'undefined', 'true', 'false', 'switch', 'case', 'break', 'continue', 'default', 'extends', 'static', 'yield', 'delete', 'in', 'of'],
  ts: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'await', 'async', 'import', 'export', 'from', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'this', 'null', 'undefined', 'true', 'false', 'switch', 'case', 'break', 'continue', 'default', 'extends', 'implements', 'interface', 'type', 'enum', 'readonly', 'private', 'public', 'protected', 'static', 'satisfies', 'as', 'is', 'keyof', 'declare', 'namespace', 'yield', 'in', 'of'],
  go: ['package', 'import', 'func', 'return', 'if', 'else', 'for', 'range', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer', 'switch', 'case', 'default', 'break', 'continue', 'nil', 'true', 'false', 'select', 'fallthrough', 'goto'],
  python: ['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'class', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'None', 'True', 'False', 'and', 'or', 'not', 'in', 'is', 'pass', 'yield', 'global', 'nonlocal', 'assert', 'async', 'await', 'del'],
  bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'export', 'local', 'readonly', 'set', 'unset', 'echo', 'cd', 'exit', 'source'],
  yaml: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'],
  json: ['true', 'false', 'null'],
  rust: ['fn', 'let', 'mut', 'const', 'struct', 'enum', 'impl', 'trait', 'pub', 'use', 'mod', 'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'self', 'Self', 'where', 'async', 'await', 'move', 'ref', 'dyn', 'true', 'false', 'crate', 'super', 'type', 'unsafe'],
}

/** Map a fence's info string onto a keyword set. */
function languageOf(info: string): readonly string[] | undefined {
  const name = info.trim().toLowerCase().split(/\s+/)[0] ?? ''
  switch (name) {
    case 'js':
    case 'javascript':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return KEYWORDS['js']
    case 'ts':
    case 'typescript':
    case 'tsx':
      return KEYWORDS['ts']
    case 'go':
    case 'golang':
      return KEYWORDS['go']
    case 'py':
    case 'python':
      return KEYWORDS['python']
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'shell':
    case 'console':
      return KEYWORDS['bash']
    case 'yaml':
    case 'yml':
      return KEYWORDS['yaml']
    case 'json':
      return KEYWORDS['json']
    case 'rs':
    case 'rust':
      return KEYWORDS['rust']
    default:
      return undefined
  }
}

const COMMENT_PREFIX: Record<string, string> = {
  python: '#',
  bash: '#',
  yaml: '#',
}

/**
 * Highlight one line of code. A deliberately small tokenizer: strings, line
 * comments, numbers, and keywords. It never fails, so a language it does not
 * know simply renders in the plain code color.
 */
function highlight(line: string, keywords: readonly string[] | undefined, info: string): string {
  const name = info.trim().toLowerCase().split(/\s+/)[0] ?? ''
  const hashComment = COMMENT_PREFIX[name] !== undefined
  let out = ''
  let index = 0
  while (index < line.length) {
    const rest = line.slice(index)

    // Line comments run to the end of the line.
    if ((hashComment && rest.startsWith('#')) || (!hashComment && rest.startsWith('//'))) {
      out += style(rest, { fg: colMuted, italic: true })
      break
    }

    // String literals, single or double quoted, with backslash escapes.
    const quote = rest[0]
    if (quote === '"' || quote === "'" || quote === '`') {
      const end = stringLiteralLength(rest, quote)
      out += style(rest.slice(0, end), { fg: colGold })
      index += end
      continue
    }

    // Identifiers and keywords.
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest)
    if (word !== null) {
      const text = word[0]
      out += keywords !== undefined && keywords.includes(text)
        ? style(text, { fg: colAccent, bold: true })
        : style(text, { fg: colText })
      index += text.length
      continue
    }

    // Numbers.
    const number = /^\d[\d_.]*/.exec(rest)
    if (number !== null) {
      out += style(number[0], { fg: colRose })
      index += number[0].length
      continue
    }

    out += style(rest[0] ?? '', { fg: colMuted })
    index += 1
  }
  return out
}

/** How many bytes one quoted literal spans, opening quote included. */
function stringLiteralLength(rest: string, quote: string): number {
  let end = 1
  while (end < rest.length) {
    if (rest[end] === '\\') {
      end += 2
      continue
    }
    if (rest[end] === quote) return end + 1
    end += 1
  }
  return end
}

/** Render inline spans: code, bold, italic, strikethrough, and links. */
export function renderInline(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const rest = text.slice(index)

    const code = /^`([^`]+)`/.exec(rest)
    if (code !== null) {
      out += style(` ${code[1] ?? ''} `, { fg: colGold })
      index += code[0].length
      continue
    }

    const strong = /^\*\*([^*]+)\*\*/.exec(rest) ?? /^__([^_]+)__/.exec(rest)
    if (strong !== null) {
      out += style(strong[1] ?? '', { fg: colText, bold: true })
      index += strong[0].length
      continue
    }

    const strike = /^~~([^~]+)~~/.exec(rest)
    if (strike !== null) {
      out += style(strike[1] ?? '', { fg: colMuted, strike: true })
      index += strike[0].length
      continue
    }

    const emphasis = /^\*([^*]+)\*/.exec(rest) ?? /^_([^_]+)_/.exec(rest)
    if (emphasis !== null) {
      out += style(emphasis[1] ?? '', { fg: colText, italic: true })
      index += emphasis[0].length
      continue
    }

    const link = /^\[([^\]]*)\]\(([^)]+)\)/.exec(rest)
    if (link !== null) {
      out += style(link[1] ?? '', { fg: colOKish, underline: true })
      out += style(` (${link[2] ?? ''})`, { fg: colMuted })
      index += link[0].length
      continue
    }

    out += text[index] ?? ''
    index += 1
  }
  return out
}

// Declared after use above for readability of the inline renderer.
const colOKish = colGreen

/** One parsed block of a markdown document. */
type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; info: string; lines: string[] }
  | { kind: 'list'; items: { marker: string; text: string; depth: number }[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; rows: string[][] }

/** Split a document into blocks, tolerating an unterminated code fence. */
function parse(source: string): Block[] {
  const blocks: Block[] = []
  const rows = source.replace(/\r\n/g, '\n').split('\n')
  let index = 0

  while (index < rows.length) {
    const line = rows[index] ?? ''

    // A blank line produces nothing; it just separates the blocks around it.
    if (/^\s*$/.test(line)) {
      index += 1
      continue
    }
    // Each scanner owns the block its first line starts; undefined passes the
    // line to the next kind. A fence outranks everything, and the paragraph
    // reader is the fall-through that gathers whatever is left.
    const parsed =
      parseFence(rows, index) ??
      parseRule(rows, index) ??
      parseHeading(rows, index) ??
      parseTable(rows, index) ??
      parseQuote(rows, index) ??
      parseList(rows, index) ??
      parseParagraph(rows, index)
    blocks.push(parsed.block)
    index = parsed.next
  }

  return blocks
}

/** One block a scanner read, and the row index just past it. */
interface ParsedBlock {
  block: Block
  next: number
}

/** A fenced code block, possibly unterminated. */
function parseFence(rows: readonly string[], index: number): ParsedBlock | undefined {
  const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(rows[index] ?? '')
  if (fence === null) return undefined
  const marker = (fence[1] ?? '```').slice(0, 3)
  const info = fence[2] ?? ''
  const body: string[] = []
  let next = index + 1
  while (next < rows.length) {
    const candidate = rows[next] ?? ''
    if (candidate.trimStart().startsWith(marker)) {
      next += 1
      break
    }
    body.push(candidate)
    next += 1
  }
  return { block: { kind: 'code', info, lines: body }, next }
}

/** A horizontal rule: `---`, `***`, or `___`. */
function parseRule(rows: readonly string[], index: number): ParsedBlock | undefined {
  if (!/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(rows[index] ?? '')) return undefined
  return { block: { kind: 'rule' }, next: index + 1 }
}

/** A heading: one to six `#` and its text. */
function parseHeading(rows: readonly string[], index: number): ParsedBlock | undefined {
  const heading = /^(#{1,6})\s+(.*)$/.exec(rows[index] ?? '')
  if (heading === null) return undefined
  return {
    block: { kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' },
    next: index + 1,
  }
}

/** A pipe table, run of consecutive pipe lines, minus its alignment row. */
function parseTable(rows: readonly string[], index: number): ParsedBlock | undefined {
  if (!/^\s*\|.*\|\s*$/.test(rows[index] ?? '')) return undefined
  const tableRows: string[][] = []
  let next = index
  while (next < rows.length && /^\s*\|.*\|\s*$/.test(rows[next] ?? '')) {
    const raw = (rows[next] ?? '').trim()
    const cells = raw.slice(1, -1).split('|').map((cell) => cell.trim())
    // Skip the alignment row that separates head from body.
    if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) tableRows.push(cells)
    next += 1
  }
  return { block: { kind: 'table', rows: tableRows }, next }
}

/** A blockquote: consecutive `>` lines joined back into one text. */
function parseQuote(rows: readonly string[], index: number): ParsedBlock | undefined {
  const quote = /^\s*>\s?(.*)$/.exec(rows[index] ?? '')
  if (quote === null) return undefined
  const parts: string[] = [quote[1] ?? '']
  let next = index + 1
  while (next < rows.length) {
    const more = /^\s*>\s?(.*)$/.exec(rows[next] ?? '')
    if (more === null) break
    parts.push(more[1] ?? '')
    next += 1
  }
  return { block: { kind: 'quote', text: parts.join('\n') }, next }
}

/** A list: bullets at any depth, with indented continuation lines. */
function parseList(rows: readonly string[], index: number): ParsedBlock | undefined {
  const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(rows[index] ?? '')
  if (bullet === null) return undefined
  const items: { marker: string; text: string; depth: number }[] = []
  let next = index
  while (next < rows.length) {
    const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(rows[next] ?? '')
    if (match === null) {
      // A plain indented line continues the previous item.
      const continuation = /^\s{2,}(\S.*)$/.exec(rows[next] ?? '')
      const last = items.at(-1)
      if (continuation !== null && last !== undefined) {
        last.text += ` ${continuation[1] ?? ''}`
        next += 1
        continue
      }
      break
    }
    const indent = (match[1] ?? '').length
    const raw = match[2] ?? '-'
    items.push({
      marker: /^\d/.test(raw) ? raw : '•',
      text: match[3] ?? '',
      depth: Math.floor(indent / 2),
    })
    next += 1
  }
  return { block: { kind: 'list', items }, next }
}

/** A paragraph: everything until a line another block kind would start. */
function parseParagraph(rows: readonly string[], index: number): ParsedBlock {
  const paragraph: string[] = [rows[index] ?? '']
  let next = index + 1
  while (next < rows.length) {
    const nextLine = rows[next] ?? ''
    if (
      /^\s*$/.test(nextLine) ||
      /^\s*(`{3,}|~{3,})/.test(nextLine) ||
      /^#{1,6}\s/.test(nextLine) ||
      /^\s*([-*+]|\d+[.)])\s/.test(nextLine) ||
      /^\s*>/.test(nextLine) ||
      /^\s*\|.*\|\s*$/.test(nextLine)
    ) break
    paragraph.push(nextLine)
    next += 1
  }
  return { block: { kind: 'paragraph', text: paragraph.join(' ') }, next }
}

/** Render a parsed block to styled lines at `width` columns. */
function renderBlock(block: Block, width: number): string[] {
  switch (block.kind) {
    case 'heading': {
      const prefix = block.level <= 1 ? '' : `${'#'.repeat(block.level)} `
      const text = `${prefix}${block.text}`
      const rendered = wrap(text, width).map((line) =>
        style(line, { fg: block.level <= 2 ? colAccent : colText, bold: true }),
      )
      return block.level <= 2 ? [...rendered, style('─'.repeat(Math.min(width, displayWidth(text))), { fg: colBorderish })] : rendered
    }
    case 'rule':
      return [style('─'.repeat(width), { fg: colBorderish })]
    case 'code':
      return renderCodeBlock(block, width)
    case 'quote':
      return block.text
        .split('\n')
        .flatMap((line) => wrap(line, Math.max(width - 2, 8)))
        .map((line) => `${style('┃', { fg: colMuted })} ${style(renderInline(line), { fg: colMuted, italic: true })}`)
    case 'list':
      return block.items.flatMap((item) => {
        const indent = '  '.repeat(item.depth)
        const bullet = style(item.marker, { fg: colAccent })
        const body = wrap(renderInlineForWrap(item.text), Math.max(width - indent.length - 2, 8))
        return body.map((line, position) =>
          position === 0
            ? `${indent}${bullet} ${renderInline(line)}`
            : `${indent}  ${renderInline(line)}`,
        )
      })
    case 'table':
      return renderTable(block, width)
    case 'paragraph':
      return wrap(renderInlineForWrap(block.text), width).map((line) => renderInline(line))
  }
}

/** A fenced code block: the language label, then each line highlighted. */
function renderCodeBlock(block: Extract<Block, { kind: 'code' }>, width: number): string[] {
  const keywords = languageOf(block.info)
  const label = block.info.trim()
  const head = label === ''
    ? []
    : [style(`  ${label}`, { fg: colMuted, italic: true })]
  const body = block.lines.map((line) => {
    const clipped = line.length > width - 4 ? line.slice(0, Math.max(width - 4, 0)) : line
    return `  ${style('│', { fg: colBorderish })} ${highlight(clipped, keywords, block.info)}`
  })
  return [...head, ...body]
}

/** A pipe table: auto-fit columns, shrunk proportionally when too wide. */
function renderTable(block: Extract<Block, { kind: 'table' }>, width: number): string[] {
  const columns = Math.max(...block.rows.map((row) => row.length), 0)
  if (columns === 0) return []
  const widths = columnWidths(block.rows, columns, width)
  return block.rows.map((row, position) => {
    const cells = widths.map((cellWidth, column) => {
      const value = row[column] ?? ''
      const clipped = displayWidth(value) > cellWidth ? `${value.slice(0, Math.max(cellWidth - 1, 0))}…` : value
      return clipped + ' '.repeat(Math.max(cellWidth - displayWidth(clipped), 0))
    })
    const line = cells.join(style(' │ ', { fg: colBorderish }))
    return position === 0 ? style(line, { fg: colText, bold: true }) : renderInline(line)
  })
}

/** Each column's width: the widest cell, at least three, shrunk to fit. */
function columnWidths(rows: readonly string[][], columns: number, width: number): number[] {
  const widths: number[] = []
  for (let column = 0; column < columns; column += 1) {
    widths.push(Math.max(...rows.map((row) => displayWidth(row[column] ?? '')), 3))
  }
  // Shrink proportionally when the table is wider than the viewport.
  const total = widths.reduce((sum, value) => sum + value + 3, 1)
  if (total <= width) return widths
  const scale = (width - columns * 3 - 1) / (total - columns * 3 - 1)
  for (let column = 0; column < columns; column += 1) {
    widths[column] = Math.max(Math.floor((widths[column] ?? 3) * scale), 3)
  }
  return widths
}

/**
 * Wrapping happens on the unstyled text, because escape codes would corrupt
 * the width arithmetic; the inline renderer then runs per output line.
 */
function renderInlineForWrap(text: string): string {
  return text
}

const colBorderish = colMuted

/** Render a markdown document to styled lines at `width` columns. */
export function renderMarkdown(source: string, width: number): string {
  const safeWidth = Math.max(width, 4)
  const blocks = parse(source)
  const out: string[] = []
  blocks.forEach((block, index) => {
    if (index > 0) out.push('')
    out.push(...renderBlock(block, safeWidth))
  })
  return out.join('\n')
}
