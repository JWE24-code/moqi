/**
 * Pure projection of a Harness assistant-stream chunk onto the transcript.
 *
 * `TuiApp.onFrame` used to hold this switch inline, which made the one path
 * that turns a live model reply into visible text untestable without a full
 * Harness runtime. This module keeps the identical logic but depends on
 * nothing: it imports no Harness types and no npm packages, so a synthetic
 * chunk sequence can be replayed in a dependency-free test (see
 * `tests/stream-smoke.ts`) the same way `render-smoke.ts` exercises `view.ts`.
 *
 * @module moqi-tui/tui/stream
 */

import type { Segment, ToolActivity } from './state.ts'
import { appendText, findTool } from './state.ts'
import { describeToolCall } from './tooldetail.ts'

/**
 * Argument text accumulated per live row, keyed weakly so committed rows
 * carry no buffer of their own. A settled block's complete `arguments`
 * replace whatever streamed in.
 */
const argumentBuffers = new WeakMap<ToolActivity, string>()

/**
 * The mutable streaming surface a chunk projects onto — a structural subset of
 * the app's session tab, so the function works on the real tab or a test stub
 * with no Harness types in sight.
 */
export interface StreamingSurface {
  /** The turn so far, prose and calls in the order they arrived. */
  streamingSegments: Segment[]
  streamingReasoning: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  haveUsage: boolean
  /** Prompt tokens served from the provider's cache, when it reports them. */
  cacheReadTokens: number
  /** Prompt tokens written to the provider's cache, when it reports them. */
  cacheWriteTokens: number
  /** Output tokens per second for the last settled turn, when measurable. */
  tps: number
}

/**
 * Structural view of a Harness `StreamChunk`, carrying only the fields the TUI
 * renders. It is deliberately wide (every field optional) so the real union —
 * whose variants carry `index`, `argumentsDelta`, `reason`, etc. — assigns to
 * it without a cast, and unknown future chunk kinds fall through the default.
 */
export interface StreamChunkLike {
  type: string
  text?: string
  id?: string | number
  name?: string
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  block?: { type: string; id?: string | number; name?: string; arguments?: string }
  /** Rendered fields the union carries but this app ignores. */
  index?: number
  argumentsDelta?: string
  blockType?: unknown
  reason?: unknown
  replayState?: unknown
}

/**
 * Apply one stream chunk to a streaming surface, mutating it in place.
 *
 * `text-delta` continues the turn's trailing run of prose, a `tool-call-delta`
 * adds or names a running tool row keyed by call id, `usage` lands the token
 * counters, and `block-end` settles the matching row to `ok`. Unknown chunk
 * kinds are ignored on purpose — the chunk union is merge-extensible and a
 * plugin may emit one this app has never heard of.
 *
 * Order is the point: text after a call opens a new segment rather than
 * extending the text before it, so "checking…", the call, and "found it" stay
 * three things in sequence instead of one paragraph and a detached list.
 */
export function projectStreamChunk(surface: StreamingSurface, chunk: StreamChunkLike): void {
  switch (chunk.type) {
    case 'text-delta':
      appendText(surface.streamingSegments, chunk.text ?? '')
      break
    case 'reasoning-delta':
      surface.streamingReasoning += chunk.text ?? ''
      break
    case 'tool-call-delta':
      projectCallDelta(surface, chunk)
      break
    case 'usage': {
      const usage = chunk.usage
      if (usage === undefined) break
      surface.promptTokens = usage.inputTokens
      surface.completionTokens = usage.outputTokens
      surface.totalTokens = usage.totalTokens ?? usage.inputTokens + usage.outputTokens
      surface.cacheReadTokens = usage.cacheReadTokens ?? 0
      surface.cacheWriteTokens = usage.cacheWriteTokens ?? 0
      surface.haveUsage = true
      break
    }
    case 'block-end':
      projectBlockEnd(surface, chunk.block)
      break
    default:
      break
  }
}

/**
 * The name arrives on the first delta of a call and is omitted on the
 * argument deltas that follow, so the call id is what identifies a row.
 * The argument deltas accumulate into the row's detail as they arrive —
 * partial JSON still reads as the command typing itself out.
 */
function projectCallDelta(surface: StreamingSurface, chunk: StreamChunkLike): void {
  const id = String(chunk.id)
  let row = findTool(surface.streamingSegments, (tool) => tool.id === id)
  if (row === undefined) {
    row = { id, name: chunk.name ?? 'tool', status: 'running' }
    surface.streamingSegments.push({ kind: 'tool', tool: row })
  }
  if (chunk.name !== undefined && row.name === 'tool') row.name = chunk.name
  if (chunk.argumentsDelta === undefined || chunk.argumentsDelta === '') return
  argumentBuffers.set(row, (argumentBuffers.get(row) ?? '') + chunk.argumentsDelta)
  const detail = describeToolCall(row.name, argumentBuffers.get(row))
  if (detail !== '') row.detail = detail
}

/**
 * A settled tool-call block flips its row from running to done, fills in the
 * name the deltas may have omitted, and says what the call does: the block
 * carries the complete raw `arguments`, which summarize into the row's
 * one-line detail (the command, the path, the query).
 */
function projectBlockEnd(
  surface: StreamingSurface,
  block: { type: string; id?: string | number; name?: string; arguments?: string } | undefined,
): void {
  if (block === undefined || block.type !== 'tool-call') return
  const row =
    findTool(surface.streamingSegments, (tool) => tool.id === String(block.id)) ??
    findTool(surface.streamingSegments, (tool) => tool.name === block.name)
  if (row === undefined) {
    surface.streamingSegments.push({
      kind: 'tool',
      tool: {
        id: String(block.id),
        name: block.name ?? 'tool',
        status: 'ok',
        detail: describeToolCall(block.name ?? 'tool', block.arguments),
      },
    })
    return
  }
  row.name = block.name ?? row.name
  row.status = 'ok'
  argumentBuffers.delete(row)
  const detail = describeToolCall(row.name, block.arguments)
  if (detail !== '') row.detail = detail
}
