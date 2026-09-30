/**
 * App state: the transcript, the composer, the slash palette, and the picker.
 *
 * This module is deliberately free of terminal and Harness concerns so the
 * interaction rules stay testable on their own — it only knows strings,
 * cursors, and selections.
 * @module
 */
import { displayWidth, wrap } from "./text.js";
/** Minimum and maximum composer height, in text rows. */
export const MIN_INPUT_LINES = 1;
export const MAX_INPUT_LINES = 10;
/** How many sent prompts the composer history retains. */
export const HISTORY_LIMIT = 500;
/** A turn that is nothing but text: a prompt, a command result, a log replay. */
export function textMessage(role, text, rest = {}) {
    return { role, segments: [{ kind: 'text', text }], ...rest };
}
/**
 * The turn's prose with the tool calls dropped, for `/copy`, `/export`,
 * `/find`, and the tab title.
 *
 * Segments are joined with a blank line because a tool call is where the model
 * stopped and started again — running the two halves together is what made a
 * reply read as one endless paragraph.
 */
export function segmentsText(segments) {
    return segments
        .flatMap((segment) => (segment.kind === 'text' ? [segment.text.replace(/\s+$/, '')] : []))
        .filter((text) => text !== '')
        .join('\n\n');
}
export function messageText(message) {
    return segmentsText(message.segments);
}
/**
 * Every tool row, in order. The rows are the live objects, not copies, so a
 * later `tool/result` event settles the row where it already sits in the turn.
 */
export function segmentTools(segments) {
    return segments.flatMap((segment) => (segment.kind === 'tool' ? [segment.tool] : []));
}
/** Every tool row in the turn, in order — for result events and counting. */
export function messageTools(message) {
    return segmentTools(message.segments);
}
/**
 * Append streamed text to the turn, continuing the trailing run when there is
 * one. A tool call in between is what opens a new text segment, which is how
 * the order gets recorded at all.
 */
export function appendText(segments, text) {
    if (text === '')
        return;
    const last = segments[segments.length - 1];
    if (last !== undefined && last.kind === 'text')
        last.text += text;
    else
        segments.push({ kind: 'text', text });
}
/** The tool row for a call id, wherever it sits in the turn. */
export function findTool(segments, match) {
    for (const segment of segments) {
        if (segment.kind === 'tool' && match(segment.tool))
            return segment.tool;
    }
    return undefined;
}
/**
 * Whether a turn's queued prompts should send once it settles.
 *
 * A clean finish always drains the queue. An interrupt is the user asking for
 * silence — so it freezes the queue — *unless* the interrupt was asked for as
 * a redirection (`/interrupt`): stop this answer, then run what was queued.
 */
export function queueShouldDrain(options) {
    return !options.interrupted || options.drainRequested;
}
/**
 * The composer. A plain multi-line buffer with a cursor, wide enough in
 * behavior to feel like an editor: word motion, line motion, and kill-to-end.
 */
export class Composer {
    text = '';
    cursor = 0;
    value() {
        return this.text;
    }
    position() {
        return this.cursor;
    }
    setValue(value) {
        this.text = value;
        this.cursor = value.length;
    }
    /** Replace the whole buffer and land the cursor at an explicit offset. */
    adopt(text, cursor) {
        this.text = text;
        this.cursor = Math.min(Math.max(cursor, 0), text.length);
    }
    reset() {
        this.text = '';
        this.cursor = 0;
    }
    insert(chunk) {
        this.text = this.text.slice(0, this.cursor) + chunk + this.text.slice(this.cursor);
        this.cursor += chunk.length;
    }
    backspace() {
        if (this.cursor === 0)
            return;
        this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
        this.cursor -= 1;
    }
    deleteForward() {
        if (this.cursor >= this.text.length)
            return;
        this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
    }
    /** Delete from the cursor back to the start of the current word. */
    deleteWord() {
        if (this.cursor === 0)
            return;
        let start = this.cursor;
        while (start > 0 && /\s/.test(this.text[start - 1] ?? ''))
            start -= 1;
        while (start > 0 && !/\s/.test(this.text[start - 1] ?? ''))
            start -= 1;
        this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
        this.cursor = start;
    }
    /** Delete from the cursor to the end of the buffer. */
    killToEnd() {
        this.text = this.text.slice(0, this.cursor);
    }
    /** Delete from the start of the buffer to the cursor. */
    killToStart() {
        this.text = this.text.slice(this.cursor);
        this.cursor = 0;
    }
    left() {
        if (this.cursor > 0)
            this.cursor -= 1;
    }
    right() {
        if (this.cursor < this.text.length)
            this.cursor += 1;
    }
    wordLeft() {
        while (this.cursor > 0 && /\s/.test(this.text[this.cursor - 1] ?? ''))
            this.cursor -= 1;
        while (this.cursor > 0 && !/\s/.test(this.text[this.cursor - 1] ?? ''))
            this.cursor -= 1;
    }
    wordRight() {
        const length = this.text.length;
        while (this.cursor < length && /\s/.test(this.text[this.cursor] ?? ''))
            this.cursor += 1;
        while (this.cursor < length && !/\s/.test(this.text[this.cursor] ?? ''))
            this.cursor += 1;
    }
    home() {
        const start = this.text.lastIndexOf('\n', Math.max(this.cursor - 1, 0));
        this.cursor = start === -1 ? 0 : start + 1;
    }
    end() {
        const next = this.text.indexOf('\n', this.cursor);
        this.cursor = next === -1 ? this.text.length : next;
    }
    toStart() {
        this.cursor = 0;
    }
    toEnd() {
        this.cursor = this.text.length;
    }
    /** Offset of the first character of the cursor's logical line. */
    lineStartIndex() {
        const at = this.text.lastIndexOf('\n', Math.max(this.cursor - 1, 0));
        return at === -1 ? 0 : at + 1;
    }
    /** Offset of the newline (or end of buffer) that closes the cursor's line. */
    lineEndIndex() {
        const at = this.text.indexOf('\n', this.cursor);
        return at === -1 ? this.text.length : at;
    }
    /**
     * Delete a half-open range and park the cursor at its start.
     *
     * The bounds are clamped, so a motion that ran off either end of the buffer
     * deletes what it actually covered rather than throwing.
     */
    deleteRange(start, end) {
        const from = Math.min(Math.max(start, 0), this.text.length);
        const to = Math.min(Math.max(end, from), this.text.length);
        this.text = this.text.slice(0, from) + this.text.slice(to);
        this.cursor = Math.min(from, this.text.length);
    }
    /** Move the cursor one visual row up or down within the wrapped composer. */
    moveRow(delta, width) {
        const rows = this.layout(width);
        const current = rows.findIndex((row) => this.cursor >= row.start && this.cursor <= row.end);
        if (current === -1)
            return;
        const target = current + delta;
        if (target < 0 || target >= rows.length)
            return;
        const column = this.cursor - (rows[current]?.start ?? 0);
        const destination = rows[target];
        if (destination === undefined)
            return;
        this.cursor = Math.min(destination.start + column, destination.end);
    }
    /**
     * Wrap the buffer to `width`, returning each visual row with the buffer
     * offsets it covers. The view and the cursor both read this, so they cannot
     * disagree about where a row begins.
     */
    layout(width) {
        const rows = [];
        let offset = 0;
        for (const logical of this.text.split('\n')) {
            const pieces = width > 0 ? wrap(logical, width) : [logical];
            let consumed = 0;
            for (const piece of pieces) {
                // wrap() drops the space it broke on; find the true span in the source.
                const start = offset + consumed;
                const pieceLength = piece.length;
                rows.push({ text: piece, start, end: start + pieceLength });
                consumed += pieceLength;
                if (logical[start + pieceLength - offset] === ' ')
                    consumed += 1;
            }
            if (pieces.length === 0)
                rows.push({ text: '', start: offset, end: offset });
            offset += logical.length + 1;
        }
        return rows;
    }
    /** Height in rows the composer wants at `width`, clamped to the app's bounds. */
    height(width) {
        const rows = this.layout(width).length;
        return Math.min(Math.max(rows, MIN_INPUT_LINES), MAX_INPUT_LINES);
    }
    /**
     * Whether the cursor sits on the first visual row, so `↑` would otherwise be
     * a no-op — the moment input-history recall should take over.
     */
    atFirstRow(width) {
        const first = this.layout(width)[0];
        return first === undefined || this.cursor <= first.end;
    }
    /** The mirror of {@link atFirstRow} for `↓` and newer history entries. */
    atLastRow(width) {
        const rows = this.layout(width);
        const last = rows[rows.length - 1];
        return last === undefined || this.cursor >= last.start;
    }
}
/**
 * Recall of previously sent prompts, the way a shell recalls its history.
 *
 * `recall` walks older (`-1`) or newer (`+1`) entries and returns the text to
 * show, or `undefined` when there is nothing further in that direction — the
 * caller then falls back to ordinary cursor motion. The draft being typed is
 * remembered the first time recall leaves it, so walking back down to the end
 * restores it rather than stranding the user on the last sent prompt.
 */
export class InputHistory {
    entries = [];
    /** Position while recalling; `-1` means the live draft, not any entry. */
    index = -1;
    draft = '';
    /** Record a sent prompt, ignoring empties and immediate repeats. */
    add(text) {
        const trimmed = text.trim();
        if (trimmed === '')
            return;
        if (this.entries[this.entries.length - 1] === trimmed) {
            this.reset();
            return;
        }
        this.entries.push(trimmed);
        if (this.entries.length > HISTORY_LIMIT) {
            this.entries.splice(0, this.entries.length - HISTORY_LIMIT);
        }
        this.reset();
    }
    /** Adopt persisted entries (oldest first), keeping the most recent ones. */
    load(entries) {
        this.entries = entries.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
        if (this.entries.length > HISTORY_LIMIT) {
            this.entries = this.entries.slice(this.entries.length - HISTORY_LIMIT);
        }
        this.reset();
    }
    /** Every recorded prompt, oldest first, for persistence. */
    snapshot() {
        return [...this.entries];
    }
    /**
     * Walk the history. `draft` is what the composer holds now; it is saved the
     * first time recall moves away from live typing.
     */
    recall(delta, draft) {
        if (this.entries.length === 0)
            return undefined;
        if (this.index === -1 && delta < 0) {
            // Leaving the live draft: remember it so recall(+1) can come back.
            this.draft = draft;
            this.index = this.entries.length - 1;
            return this.entries[this.index];
        }
        if (this.index === -1)
            return undefined;
        const next = this.index + delta;
        if (next < 0)
            return undefined;
        if (next >= this.entries.length) {
            const draft = this.draft;
            this.reset();
            return draft;
        }
        this.index = next;
        return this.entries[next];
    }
    /** Whether a recall is in flight, i.e. ↑/↓ should keep walking history. */
    isRecalling() {
        return this.index !== -1;
    }
    /** Return to live typing; called whenever the composer is edited or sent. */
    reset() {
        this.index = -1;
        this.draft = '';
    }
}
/** The popup that filters slash commands as they are typed. */
export class Palette {
    open = false;
    matches = [];
    selected = 0;
    /**
     * Recompute from the composer text. The palette lives only while the input
     * is a single unfinished `/word`; once a space is typed the user has moved
     * on to the command's own arguments.
     */
    update(input, commands) {
        if (!input.startsWith('/') || /[\s\n]/.test(input)) {
            this.close();
            return;
        }
        const prefix = input.slice(1).toLowerCase();
        // Case-insensitive so a plugin may register `JevLoop` and still answer to
        // `/jevloop`; every built-in is already lowercase, so this changes nothing.
        this.matches = commands.filter((command) => command.name.toLowerCase().startsWith(prefix));
        this.open = this.matches.length > 0;
        if (this.selected >= this.matches.length)
            this.selected = this.matches.length - 1;
        if (this.selected < 0)
            this.selected = 0;
    }
    move(delta) {
        if (!this.open || this.matches.length === 0)
            return;
        this.selected = (this.selected + delta + this.matches.length) % this.matches.length;
    }
    current() {
        if (!this.open)
            return undefined;
        return this.matches[this.selected];
    }
    close() {
        this.open = false;
        this.matches = [];
        this.selected = 0;
    }
}
/**
 * Subsequence match, the same shape of filter an editor's command palette
 * uses: every character of the query appears in order, not necessarily
 * adjacent, so "g53" finds "glm-5.3".
 */
export function fuzzyMatch(query, text) {
    if (query === '')
        return true;
    let index = 0;
    for (const char of text) {
        if (char === query[index]) {
            index += 1;
            if (index === query.length)
                return true;
        }
    }
    return false;
}
/**
 * The full-pane list that replaces the transcript for `/resume` and `/model`.
 *
 * It filters as you type and, when grouped, prints a header each time the
 * subtitle changes — so a model list reads provider by provider rather than as
 * one undifferentiated column.
 */
export class Picker {
    kind = 'none';
    title = '';
    items = [];
    selected = 0;
    query = '';
    /** Whether rows are grouped under their subtitle. */
    grouped = false;
    show(kind, title, items, options = {}) {
        this.kind = kind;
        this.title = title;
        this.items = items;
        this.selected = 0;
        this.query = '';
        this.grouped = options.grouped === true;
    }
    hide() {
        this.kind = 'none';
        this.items = [];
        this.selected = 0;
        this.query = '';
        this.grouped = false;
    }
    /** Rows surviving the current query, in their original order. */
    matches() {
        const query = this.query.trim().toLowerCase();
        if (query === '')
            return this.items;
        return this.items.filter((item) => fuzzyMatch(query, `${item.subtitle} ${item.title} ${item.id}`.toLowerCase()));
    }
    /** Narrow or widen the filter, keeping the selection in range. */
    setQuery(query) {
        this.query = query;
        this.selected = 0;
    }
    move(delta) {
        const count = this.matches().length;
        if (count === 0)
            return;
        this.selected = Math.min(Math.max(this.selected + delta, 0), count - 1);
    }
    /** Put the cursor on a given row of the unfiltered list, if it survives. */
    selectById(id) {
        const index = this.matches().findIndex((item) => item.id === id);
        if (index !== -1)
            this.selected = index;
    }
    current() {
        return this.matches()[this.selected];
    }
}
/**
 * Which open session a delegated agent belongs to, as an index.
 *
 * The Harness does not report a delegation parent, so this is a rule rather
 * than a lookup, and it is worth stating plainly because the alternative --
 * one list shared by every session -- is what made another conversation's
 * subagents appear in whichever tab was on screen.
 *
 * Fork lineage wins when it names a session that is actually open. Otherwise
 * timing decides: delegated work is spawned while its parent's turn runs, so
 * the streaming session claims it. With neither, the active session is the
 * only honest guess.
 */
export function ownerOfDelegated(sessions, parentSessionId, activeIndex) {
    if (sessions.length === 0)
        return -1;
    if (parentSessionId !== undefined) {
        const byLineage = sessions.findIndex((session) => session.id === parentSessionId);
        if (byLineage !== -1)
            return byLineage;
    }
    const streaming = sessions.findIndex((session) => session.streaming);
    if (streaming !== -1)
        return streaming;
    return activeIndex >= 0 && activeIndex < sessions.length ? activeIndex : 0;
}
/**
 * Walk a transcript selection.
 *
 * There is no selection until the first key: `alt+↑`/`alt+↓` then start at the
 * newest turn and move, clamped at both ends and empty when there is nothing
 * to select.
 */
export function moveSelection(current, delta, count) {
    if (count <= 0)
        return undefined;
    if (current === undefined)
        return count - 1;
    return Math.min(Math.max(current + delta, 0), count - 1);
}
/** Format a token count the way a status bar wants it: 834, 1.2K, 64K. */
export function formatTokens(count) {
    if (count < 1000)
        return String(count);
    if (count < 10000)
        return `${(count / 1000).toFixed(1)}K`;
    return `${Math.floor(count / 1000)}K`;
}
/** A deliberately rough chars/4 estimate, used until real usage is reported. */
export function estimateTokens(text) {
    return Math.ceil(displayWidth(text) / 4);
}
