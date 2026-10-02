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

import type { ToolActivity } from './state.ts'

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
