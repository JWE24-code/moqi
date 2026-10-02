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
import type { ToolActivity } from './state.ts';
/**
 * Summarize what a tool call does from its raw `arguments` JSON — the exact
 * string the model produced, parsed leniently. `bash` becomes
 * `bash  docker ps --format {{.Names}}`; a read becomes its path; anything
 * unrecognized falls back to its first string-valued argument, then to the
 * compact JSON, then to nothing rather than to noise.
 */
export declare function describeToolCall(name: string, rawArguments: string | undefined): string;
/**
 * The one-line face of a tool result: its text content folded to a single
 * line, or the failure's identity when the result block says the tool erred.
 * `content` is the result block's content array; each text block contributes.
 *
 * @returns the summary, or `undefined` when the result says nothing readable.
 */
export declare function summarizeResult(content: readonly unknown[], error?: {
    name?: string;
    code?: string;
}): string | undefined;
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
export declare function applyToolEvent(tools: ToolActivity[], event: {
    type?: string;
    data?: Record<string, unknown>;
}): void;
