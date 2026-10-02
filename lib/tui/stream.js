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
import { appendText, findTool } from "./state.js";
import { describeToolCall } from "./tooldetail.js";
/**
 * Argument text accumulated per live row, keyed weakly so committed rows
 * carry no buffer of their own. A settled block's complete `arguments`
 * replace whatever streamed in.
 */
const argumentBuffers = new WeakMap();
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
export function projectStreamChunk(surface, chunk) {
    switch (chunk.type) {
        case 'text-delta':
            appendText(surface.streamingSegments, chunk.text ?? '');
            break;
        case 'reasoning-delta':
            surface.streamingReasoning += chunk.text ?? '';
            break;
        case 'tool-call-delta':
            projectCallDelta(surface, chunk);
            break;
        case 'usage': {
            const usage = chunk.usage;
            if (usage === undefined)
                break;
            surface.promptTokens = usage.inputTokens;
            surface.completionTokens = usage.outputTokens;
            surface.totalTokens = usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
            surface.cacheReadTokens = usage.cacheReadTokens ?? 0;
            surface.cacheWriteTokens = usage.cacheWriteTokens ?? 0;
            surface.haveUsage = true;
            break;
        }
        case 'block-end':
            projectBlockEnd(surface, chunk.block);
            break;
        default:
            break;
    }
}
/**
 * The name arrives on the first delta of a call and is omitted on the
 * argument deltas that follow, so the call id is what identifies a row.
 * The argument deltas accumulate into the row's detail as they arrive —
 * partial JSON still reads as the command typing itself out.
 */
function projectCallDelta(surface, chunk) {
    const id = String(chunk.id);
    let row = findTool(surface.streamingSegments, (tool) => tool.id === id);
    if (row === undefined) {
        row = { id, name: chunk.name ?? 'tool', status: 'running' };
        surface.streamingSegments.push({ kind: 'tool', tool: row });
    }
    if (chunk.name !== undefined && row.name === 'tool')
        row.name = chunk.name;
    if (chunk.argumentsDelta === undefined || chunk.argumentsDelta === '')
        return;
    argumentBuffers.set(row, (argumentBuffers.get(row) ?? '') + chunk.argumentsDelta);
    const detail = describeToolCall(row.name, argumentBuffers.get(row));
    if (detail !== '')
        row.detail = detail;
}
/**
 * A settled tool-call block flips its row from running to done, fills in the
 * name the deltas may have omitted, and says what the call does: the block
 * carries the complete raw `arguments`, which summarize into the row's
 * one-line detail (the command, the path, the query).
 */
function projectBlockEnd(surface, block) {
    if (block?.type !== 'tool-call')
        return;
    const row = findTool(surface.streamingSegments, (tool) => tool.id === String(block.id)) ??
        findTool(surface.streamingSegments, (tool) => tool.name === block.name);
    if (row === undefined) {
        surface.streamingSegments.push({
            kind: 'tool',
            tool: {
                id: String(block.id),
                name: block.name ?? 'tool',
                status: 'ok',
                detail: describeToolCall(block.name ?? 'tool', block.arguments),
                args: block.arguments,
            },
        });
        return;
    }
    row.name = block.name ?? row.name;
    row.status = 'ok';
    row.args = block.arguments;
    argumentBuffers.delete(row);
    const detail = describeToolCall(row.name, block.arguments);
    if (detail !== '')
        row.detail = detail;
}
