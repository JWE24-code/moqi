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
      let end = 1
      while (end < rest.length) {
        if (rest[end] === '\\') {
          end += 2
          continue
        }
        if (rest[end] === quote) {
          end += 1
          break
        }
        end += 1
      }
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

    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence !== null) {
      const marker = (fence[1] ?? '```').slice(0, 3)
      const info = fence[2] ?? ''
      const body: string[] = []
      index += 1
      while (index < rows.length) {
        const candidate = rows[index] ?? ''
        if (candidate.trimStart().startsWith(marker)) {
          index += 1
          break
        }
        body.push(candidate)
        index += 1
      }
      blocks.push({ kind: 'code', info, lines: body })
      continue
    }

    if (/^\s*$/.test(line)) {
      index += 1
      continue
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' })
      index += 1
      continue
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const tableRows: string[][] = []
      while (index < rows.length && /^\s*\|.*\|\s*$/.test(rows[index] ?? '')) {
        const raw = (rows[index] ?? '').trim()
        const cells = raw.slice(1, -1).split('|').map((cell) => cell.trim())
        // Skip the alignment row that separates head from body.
        if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) tableRows.push(cells)
        index += 1
      }
      blocks.push({ kind: 'table', rows: tableRows })
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null) {
      const parts: string[] = [quote[1] ?? '']
      index += 1
      while (index < rows.length) {
        const next = /^\s*>\s?(.*)$/.exec(rows[index] ?? '')
        if (next === null) break
        parts.push(next[1] ?? '')
        index += 1
      }
      blocks.push({ kind: 'quote', text: parts.join('\n') })
      continue
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bullet !== null) {
      const items: { marker: string; text: string; depth: number }[] = []
      while (index < rows.length) {
        const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(rows[index] ?? '')
        if (match === null) {
          // A plain indented line continues the previous item.
          const continuation = /^\s{2,}(\S.*)$/.exec(rows[index] ?? '')
          const last = items.at(-1)
          if (continuation !== null && last !== undefined) {
            last.text += ` ${continuation[1] ?? ''}`
            index += 1
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
        index += 1
      }
      blocks.push({ kind: 'list', items })
      continue
    }

    const paragraph: string[] = [line]
    index += 1
    while (index < rows.length) {
      const next = rows[index] ?? ''
      if (
        /^\s*$/.test(next) ||
        /^\s*(`{3,}|~{3,})/.test(next) ||
        /^#{1,6}\s/.test(next) ||
        /^\s*([-*+]|\d+[.)])\s/.test(next) ||
        /^\s*>/.test(next) ||
        /^\s*\|.*\|\s*$/.test(next)
      ) break
      paragraph.push(next)
      index += 1
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
  }

  return blocks
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
    case 'code': {
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
    case 'table': {
      const columns = Math.max(...block.rows.map((row) => row.length), 0)
      if (columns === 0) return []
      const widths: number[] = []
      for (let column = 0; column < columns; column += 1) {
        widths.push(Math.max(...block.rows.map((row) => displayWidth(row[column] ?? '')), 3))
      }
      // Shrink proportionally when the table is wider than the viewport.
      const total = widths.reduce((sum, value) => sum + value + 3, 1)
      if (total > width) {
        const scale = (width - columns * 3 - 1) / (total - columns * 3 - 1)
        for (let column = 0; column < columns; column += 1) {
          widths[column] = Math.max(Math.floor((widths[column] ?? 3) * scale), 3)
        }
      }
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
    case 'paragraph':
      return wrap(renderInlineForWrap(block.text), width).map((line) => renderInline(line))
  }
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
