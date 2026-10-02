/**
 * What a tool call says about itself, and what came back.
 *
 * A tool row used to carry only the tool's name — `bash` four times over said
 * nothing about what the agent was doing. The raw `arguments` JSON is already
 * on the call (and its result already in the session log), so the readable
 * summary is a pair of pure functions over strings: no Harness types, no I/O,
 * replayable in a dependency-free suite next to the stream projection.
 *
 * @module moqi-tui/tui/tooldetail
 */

import type { DiffLine, ToolActivity } from './state.ts'

/** Stored detail/results are capped here; the renderer truncates to width. */
const DETAIL_LIMIT = 200

/**
 * Argument keys that name what a call does, most specific first. A tool's own
 * key wins when present; otherwise the first string value speaks for the call.
 */
const PREFERRED_KEYS = [
  'command',
  'cmd',
  'script',
  'file_path',
  'path',
  'filePath',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
  'objective',
  'content',
  'name',
] as const

/** One line, whitespace folded, bounded. */
function oneline(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, DETAIL_LIMIT)
}

/**
 * Summarize what a tool call does from its raw `arguments` JSON — the exact
 * string the model produced, parsed leniently. `bash` becomes
 * `bash  docker ps --format {{.Names}}`; a read becomes its path; anything
 * unrecognized falls back to its first string-valued argument, then to the
 * compact JSON, then to nothing rather than to noise.
 */
export function describeToolCall(name: string, rawArguments: string | undefined): string {
  if (rawArguments === undefined) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return oneline(rawArguments)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return typeof parsed === 'string' ? oneline(parsed) : ''
  }
  const record = parsed as Record<string, unknown>
  for (const key of PREFERRED_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return oneline(value)
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim() !== '') return oneline(value)
  }
  return ''
}

/**
 * The one-line face of a tool result: its text content folded to a single
 * line, or the failure's identity when the result block says the tool erred.
 * `content` is the result block's content array; each text block contributes.
 *
 * @returns the summary, or `undefined` when the result says nothing readable.
 */
export function summarizeResult(
  content: readonly unknown[],
  error?: { name?: string; code?: string },
): string | undefined {
  const text = content
    .map((block) => (block as { text?: unknown } | null | undefined)?.text)
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
  const line = oneline(text)
  if (line !== '') return line
  if (error !== undefined) {
    const who = oneline([error.name, error.code].filter(Boolean).join(' '))
    if (who !== '') return who
  }
  return undefined
}

/** The editor tool whose calls can be shown as a diff. */
export const EDIT_TOOL = 'str_replace_editor'

/** Rows of context kept either side of a change. */
export const DIFF_CONTEXT_ROWS = 3

/** The file an edit call names, for reading it back once the edit settles. */
export function editPath(rawArguments: string | undefined): string | undefined {
  const record = editArguments(rawArguments)
  const path = record?.['path']
  return typeof path === 'string' && path !== '' ? path : undefined
}

/** The parsed argument object, or undefined when there is none to trust. */
function editArguments(rawArguments: string | undefined): Record<string, unknown> | undefined {
  if (rawArguments === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A text's display lines: a trailing newline is not a line of its own. */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The 1-based row `needle` starts at in `file`, or undefined when the file
 * does not contain it. The edit has already been applied by the time this
 * runs, so the added text is what gets located.
 */
function rowOf(file: string, needle: string): number | undefined {
  if (needle === '') return undefined
  const at = file.indexOf(needle)
  if (at === -1) return undefined
  return file.slice(0, at).split('\n').length
}

/** Context rows either side of a change, in the order they are drawn. */
function contextRows(
  fileLines: readonly string[],
  from: number,
  to: number,
): { kind: 'context'; line: number; text: string }[] {
  const out: { kind: 'context'; line: number; text: string }[] = []
  for (let row = from; row <= to; row += 1) {
    const text = fileLines[row - 1]
    if (text !== undefined) out.push({ kind: 'context', line: row, text })
  }
  return out
}

/**
 * A file edit as red/green diff rows with their row numbers and three rows of
 * context either side.
 *
 * The tool's result is a one-line success message, so the change comes from
 * the call's own arguments; the row numbers and context come from the file as
 * it now stands, which is why `fileText` is optional — without it the hunk is
 * still shown, just unplaced. Only `str_replace_editor` edits qualify: another
 * tool that happens to pass a `path` is not a diff.
 */
export function editDiff(
  name: string,
  rawArguments: string | undefined,
  fileText?: string,
): DiffLine[] | undefined {
  if (name !== EDIT_TOOL) return undefined
  const record = editArguments(rawArguments)
  if (record === undefined) return undefined
  const command = textOf(record['command'])
  if (command === 'str_replace') {
    return replaceDiff(textOf(record['old_str']) ?? '', textOf(record['new_str']) ?? '', fileText)
  }
  if (command === 'insert') {
    const at = record['insert_line']
    return insertDiff(typeof at === 'number' ? at : undefined, textOf(record['new_str']) ?? '', fileText)
  }
  if (command === 'create') {
    const created = splitLines(textOf(record['file_text']) ?? '')
    return created.map((text, index) => ({ kind: 'add', line: index + 1, text }))
  }
  return undefined
}

/** Removed lines red, added lines green, both at the row the new text starts. */
function replaceDiff(
  oldText: string,
  newText: string,
  fileText: string | undefined,
): DiffLine[] | undefined {
  const removed = splitLines(oldText)
  const added = splitLines(newText)
  if (removed.length === 0 && added.length === 0) return undefined
  // The addition is what can be found in the file now; a deletion leaves
  // nothing to find, so its rows go unnumbered rather than guessed at.
  const startRow = fileText === undefined ? undefined : rowOf(fileText, newText)
  const fileLines = fileText === undefined ? [] : fileText.split('\n')
  const out: DiffLine[] = []
  if (startRow !== undefined) {
    out.push(...contextRows(fileLines, startRow - DIFF_CONTEXT_ROWS, startRow - 1))
  }
  for (const text of removed) {
    out.push(startRow === undefined ? { kind: 'remove', text } : { kind: 'remove', line: startRow, text })
  }
  added.forEach((text, index) => {
    const line = startRow === undefined ? undefined : startRow + index
    out.push(line === undefined ? { kind: 'add', text } : { kind: 'add', line, text })
  })
  if (startRow !== undefined) {
    const after = startRow + Math.max(added.length, 1)
    out.push(...contextRows(fileLines, after, after + DIFF_CONTEXT_ROWS - 1))
  }
  return out
}

/** Inserted lines, numbered from the row they follow, with context. */
function insertDiff(
  insertLine: number | undefined,
  newText: string,
  fileText: string | undefined,
): DiffLine[] | undefined {
  const added = splitLines(newText)
  if (added.length === 0) return undefined
  if (insertLine === undefined) return added.map((text) => ({ kind: 'add', text }))
  const startRow = insertLine + 1
  const fileLines = fileText === undefined ? [] : fileText.split('\n')
  const out: DiffLine[] = contextRows(fileLines, startRow - DIFF_CONTEXT_ROWS, startRow - 1)
  added.forEach((text, index) => out.push({ kind: 'add', line: startRow + index, text }))
  out.push(...contextRows(fileLines, startRow + added.length, startRow + added.length + DIFF_CONTEXT_ROWS - 1))
  return out
}

/**
 * Fold one session-log event onto the live tool rows of the turn in flight.
 *
 * `tool/call` fills a row's detail (the deltas name it, the log says what it
 * does); `tool/result` settles the row — `ok` or `error` — and attaches its
 * outcome underneath the very call that produced it, in flow. Rows are keyed
 * by call id and never created here: only stream deltas and block ends, which
 * observe the same calls, add rows, so an event from an earlier turn logged
 * before the sync point finds no row and is ignored.
 */
export function applyToolEvent(
  tools: ToolActivity[],
  event: { type?: string; data?: Record<string, unknown> },
): void {
  if (event.data === undefined) return
  if (event.type === 'tool/call') applyToolCall(tools, event.data)
  else if (event.type === 'tool/result') applyToolResult(tools, event.data)
}

/** `tool/call` fills a row's name and, when the deltas left it empty, its detail. */
function applyToolCall(tools: ToolActivity[], data: Record<string, unknown>): void {
  const row = tools.find((tool) => tool.id === String(data['callId']))
  if (row === undefined) return
  const name = typeof data['name'] === 'string' ? data['name'] : undefined
  if (row.name === 'tool' && name !== undefined) row.name = name
  const raw = str(data['arguments'])
  if (raw !== undefined) row.args = raw
  if (row.detail !== undefined && row.detail !== '') return
  const detail = describeToolCall(name ?? row.name, str(data['arguments']))
  if (detail !== '') row.detail = detail
}

/** `tool/result` settles the row the result block names, with its outcome. */
function applyToolResult(tools: ToolActivity[], data: Record<string, unknown>): void {
  const message = data['message'] as { content?: unknown[] } | undefined
  const block = Array.isArray(message?.content)
    ? (message?.content as { toolCallId?: unknown; content?: unknown[]; isError?: unknown }[])[0]
    : undefined
  if (block === undefined) return
  const row = tools.find((tool) => tool.id === String(block.toolCallId))
  if (row === undefined) return
  const error = data['error'] as { name?: string; code?: string } | undefined
  row.status = block.isError === true || error !== undefined ? 'error' : 'ok'
  const summary = summarizeResult(
    Array.isArray(block.content) ? block.content : [],
    error ?? undefined,
  )
  if (summary !== undefined) row.result = summary
}

/** `unknown` to `string | undefined`, the only coercion event fields need. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
