/**
 * The transcript search: its query, which match is on screen, and the jump
 * math that centers a match in the viewport.
 *
 * The state and the wrap rules live here; the app supplies the transcript
 * snapshot and applies what a jump returns — scroll offset and status text.
 * The hits are recomputed on every jump, so a reply still streaming in simply
 * adds lines to search rather than staleness.
 * @module
 */
import { type Snapshot } from './tui/view.ts';
/** What one jump asks the app to do: move, or report that nothing matched. */
export type SearchJump = {
    kind: 'none';
    status: string;
} | {
    kind: 'moved';
    scrollBack: number;
    status: string;
};
export declare class SearchState {
    private query;
    private cursor;
    /** Whether a search is live — the `n`/`N`/`esc` keys and the footer care. */
    get active(): boolean;
    /** Read-only view for callers that only need to know it is live. */
    view(): {
        query: string;
        cursor: number;
    } | undefined;
    /** Start (or replace) the search, positioned at its first match. */
    start(query: string): void;
    /** Forget the search; the status bar returns to its idle hint. */
    clear(): void;
    /**
     * Move to another match. `delta` wraps around the list; `0` lands on the
     * current match.
     *
     * @returns what the app should apply, or `undefined` when no search is live.
     */
    jump(delta: number, snapshot: Snapshot): SearchJump | undefined;
}
