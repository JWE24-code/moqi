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
import { findMatches, layout, maxScrollBack } from "./tui/view.js";
export class SearchState {
    query;
    cursor = 0;
    /** Whether a search is live — the `n`/`N`/`esc` keys and the footer care. */
    get active() {
        return this.query !== undefined;
    }
    /** Read-only view for callers that only need to know it is live. */
    view() {
        return this.query === undefined ? undefined : { query: this.query, cursor: this.cursor };
    }
    /** Start (or replace) the search, positioned at its first match. */
    start(query) {
        this.query = query;
        this.cursor = 0;
    }
    /** Forget the search; the status bar returns to its idle hint. */
    clear() {
        this.query = undefined;
    }
    /**
     * Move to another match. `delta` wraps around the list; `0` lands on the
     * current match.
     *
     * @returns what the app should apply, or `undefined` when no search is live.
     */
    jump(delta, snapshot) {
        const query = this.query;
        if (query === undefined)
            return undefined;
        const hits = findMatches(snapshot, query);
        if (hits.length === 0)
            return { kind: 'none', status: `no matches for “${query}”` };
        this.cursor = ((this.cursor + delta) % hits.length + hits.length) % hits.length;
        const line = hits[this.cursor] ?? 0;
        const viewportRows = layout(snapshot).viewportRows;
        const limit = maxScrollBack(snapshot);
        // Center the hit vertically, clamped so the view cannot drift off the body.
        const start = Math.min(Math.max(line - Math.floor(viewportRows / 2), 0), limit);
        return {
            kind: 'moved',
            scrollBack: limit - start,
            status: `match ${String(this.cursor + 1)}/${String(hits.length)}  ·  n next  ·  N prev  ·  esc clear`,
        };
    }
}
