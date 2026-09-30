/**
 * App state: the transcript, the composer, the slash palette, and the picker.
 *
 * This module is deliberately free of terminal and Harness concerns so the
 * interaction rules stay testable on their own — it only knows strings,
 * cursors, and selections.
 * @module
 */
/** Minimum and maximum composer height, in text rows. */
export declare const MIN_INPUT_LINES = 1;
export declare const MAX_INPUT_LINES = 10;
/** How many sent prompts the composer history retains. */
export declare const HISTORY_LIMIT = 500;
/**
 * One piece of a turn, in the order it actually happened.
 *
 * A turn is not prose with tool calls bolted on the side: the agent says
 * something, runs a tool, says something about what came back. Holding the text
 * as one string and the calls as a separate list threw that order away, so the
 * prose arrived as one run of concatenated fragments under a block of calls —
 * which is exactly how a turn stops making sense to read.
 */
export type Segment = {
    kind: 'text';
    text: string;
} | {
    kind: 'tool';
    tool: ToolActivity;
};
/** One turn of the transcript. */
export interface Message {
    role: 'user' | 'assistant';
    /** The turn's pieces in arrival order — prose and tool calls interleaved. */
    segments: readonly Segment[];
    /** Reasoning text, shown only when thinking is toggled on. */
    reasoning?: string;
    /** Set when this message is a command result rather than model output. */
    command?: {
        name: string;
        ok: boolean;
    };
    /** Set on a user prompt steered into a still-running turn. */
    steering?: boolean;
    /** Images sent with this user prompt, drawn as one summary line. */
    attachments?: readonly {
        name: string;
        width: number;
        height: number;
    }[];
}
/** A turn that is nothing but text: a prompt, a command result, a log replay. */
export declare function textMessage(role: Message['role'], text: string, rest?: Omit<Message, 'role' | 'segments'>): Message;
/**
 * The turn's prose with the tool calls dropped, for `/copy`, `/export`,
 * `/find`, and the tab title.
 *
 * Segments are joined with a blank line because a tool call is where the model
 * stopped and started again — running the two halves together is what made a
 * reply read as one endless paragraph.
 */
export declare function segmentsText(segments: readonly Segment[]): string;
export declare function messageText(message: Message): string;
/**
 * Every tool row, in order. The rows are the live objects, not copies, so a
 * later `tool/result` event settles the row where it already sits in the turn.
 */
export declare function segmentTools(segments: readonly Segment[]): ToolActivity[];
/** Every tool row in the turn, in order — for result events and counting. */
export declare function messageTools(message: Message): ToolActivity[];
/**
 * Append streamed text to the turn, continuing the trailing run when there is
 * one. A tool call in between is what opens a new text segment, which is how
 * the order gets recorded at all.
 */
export declare function appendText(segments: Segment[], text: string): void;
/** The tool row for a call id, wherever it sits in the turn. */
export declare function findTool(segments: readonly Segment[], match: (tool: ToolActivity) => boolean): ToolActivity | undefined;
/** A single tool invocation surfaced in the transcript. */
export interface ToolActivity {
    /** Provider-issued call id; the only stable handle across argument deltas. */
    id?: string;
    name: string;
    status: 'running' | 'ok' | 'error';
    detail?: string;
    /** One line of what came back, rendered under the call it belongs to. */
    result?: string;
}
/**
 * Whether a turn's queued prompts should send once it settles.
 *
 * A clean finish always drains the queue. An interrupt is the user asking for
 * silence — so it freezes the queue — *unless* the interrupt was asked for as
 * a redirection (`/interrupt`): stop this answer, then run what was queued.
 */
export declare function queueShouldDrain(options: {
    interrupted: boolean;
    drainRequested: boolean;
}): boolean;
/**
 * What a session is doing, for the tab bar.
 *
 * `ready` is the state worth interrupting someone for: the turn finished and
 * the answer has not been seen. It is what the bell announces.
 */
export type SessionStatus = 'idle' | 'running' | 'ready';
/** One open session, as the tab bar shows it. */
export interface SessionSummary {
    id: string;
    title: string;
    status: SessionStatus;
    active: boolean;
}
/**
 * A live agent other than the one the transcript is showing.
 *
 * The Harness can run delegated work — subagents the foreground turn spawned —
 * and without a row here that work is invisible: the screen looks idle while
 * the machine is busy.
 */
export interface BackgroundAgent {
    /** Session id, used as the stable identity. */
    id: string;
    /** Short human label: the preset name when composed from one. */
    label: string;
    status: 'idle' | 'running';
    /** Delegation depth; 1 is a direct child of the foreground agent. */
    depth: number;
    /** Epoch millis when this agent was first seen. */
    startedAt: number;
}
/** A slash command as the palette shows it. */
export interface PaletteCommand {
    name: string;
    args: string;
    description: string;
}
/** Which list the picker is currently showing. */
export type PickerKind = 'sessions' | 'models' | 'themes' | 'plugins' | 'panel' | 'open' | 'delete' | 'rewind' | 'stored' | 'lang' | 'login' | 'login-method' | 'setup' | 'none';
/** One row in the picker. */
export interface PickerItem {
    id: string;
    title: string;
    subtitle: string;
    /** Set on a model row: the provider route that owns the model. */
    provider?: string;
    /** Set on a model row: the model id passed to the request. */
    model?: string;
    /** Marks the row that is currently in use. */
    active?: boolean;
}
/**
 * The composer. A plain multi-line buffer with a cursor, wide enough in
 * behavior to feel like an editor: word motion, line motion, and kill-to-end.
 */
export declare class Composer {
    private text;
    private cursor;
    value(): string;
    position(): number;
    setValue(value: string): void;
    /** Replace the whole buffer and land the cursor at an explicit offset. */
    adopt(text: string, cursor: number): void;
    reset(): void;
    insert(chunk: string): void;
    backspace(): void;
    deleteForward(): void;
    /** Delete from the cursor back to the start of the current word. */
    deleteWord(): void;
    /** Delete from the cursor to the end of the buffer. */
    killToEnd(): void;
    /** Delete from the start of the buffer to the cursor. */
    killToStart(): void;
    left(): void;
    right(): void;
    wordLeft(): void;
    wordRight(): void;
    home(): void;
    end(): void;
    toStart(): void;
    toEnd(): void;
    /** Offset of the first character of the cursor's logical line. */
    lineStartIndex(): number;
    /** Offset of the newline (or end of buffer) that closes the cursor's line. */
    lineEndIndex(): number;
    /**
     * Delete a half-open range and park the cursor at its start.
     *
     * The bounds are clamped, so a motion that ran off either end of the buffer
     * deletes what it actually covered rather than throwing.
     */
    deleteRange(start: number, end: number): void;
    /** Move the cursor one visual row up or down within the wrapped composer. */
    moveRow(delta: number, width: number): void;
    /**
     * Wrap the buffer to `width`, returning each visual row with the buffer
     * offsets it covers. The view and the cursor both read this, so they cannot
     * disagree about where a row begins.
     */
    layout(width: number): {
        text: string;
        start: number;
        end: number;
    }[];
    /** Height in rows the composer wants at `width`, clamped to the app's bounds. */
    height(width: number): number;
    /**
     * Whether the cursor sits on the first visual row, so `↑` would otherwise be
     * a no-op — the moment input-history recall should take over.
     */
    atFirstRow(width: number): boolean;
    /** The mirror of {@link atFirstRow} for `↓` and newer history entries. */
    atLastRow(width: number): boolean;
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
export declare class InputHistory {
    private entries;
    /** Position while recalling; `-1` means the live draft, not any entry. */
    private index;
    private draft;
    /** Record a sent prompt, ignoring empties and immediate repeats. */
    add(text: string): void;
    /** Adopt persisted entries (oldest first), keeping the most recent ones. */
    load(entries: readonly string[]): void;
    /** Every recorded prompt, oldest first, for persistence. */
    snapshot(): readonly string[];
    /**
     * Walk the history. `draft` is what the composer holds now; it is saved the
     * first time recall moves away from live typing.
     */
    recall(delta: number, draft: string): string | undefined;
    /** Whether a recall is in flight, i.e. ↑/↓ should keep walking history. */
    isRecalling(): boolean;
    /** Return to live typing; called whenever the composer is edited or sent. */
    reset(): void;
}
/** The popup that filters slash commands as they are typed. */
export declare class Palette {
    open: boolean;
    matches: PaletteCommand[];
    selected: number;
    /**
     * Recompute from the composer text. The palette lives only while the input
     * is a single unfinished `/word`; once a space is typed the user has moved
     * on to the command's own arguments.
     */
    update(input: string, commands: readonly PaletteCommand[]): void;
    move(delta: number): void;
    current(): PaletteCommand | undefined;
    close(): void;
}
/**
 * Subsequence match, the same shape of filter an editor's command palette
 * uses: every character of the query appears in order, not necessarily
 * adjacent, so "g53" finds "glm-5.3".
 */
export declare function fuzzyMatch(query: string, text: string): boolean;
/**
 * The full-pane list that replaces the transcript for `/resume` and `/model`.
 *
 * It filters as you type and, when grouped, prints a header each time the
 * subtitle changes — so a model list reads provider by provider rather than as
 * one undifferentiated column.
 */
export declare class Picker {
    kind: PickerKind;
    title: string;
    items: PickerItem[];
    selected: number;
    query: string;
    /** Whether rows are grouped under their subtitle. */
    grouped: boolean;
    show(kind: Exclude<PickerKind, 'none'>, title: string, items: PickerItem[], options?: {
        grouped?: boolean;
    }): void;
    hide(): void;
    /** Rows surviving the current query, in their original order. */
    matches(): PickerItem[];
    /** Narrow or widen the filter, keeping the selection in range. */
    setQuery(query: string): void;
    move(delta: number): void;
    /** Put the cursor on a given row of the unfiltered list, if it survives. */
    selectById(id: string): void;
    current(): PickerItem | undefined;
}
/** The minimum a session has to expose for {@link ownerOfDelegated}. */
export interface DelegationHost {
    id: string;
    streaming: boolean;
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
export declare function ownerOfDelegated(sessions: readonly DelegationHost[], parentSessionId: string | undefined, activeIndex: number): number;
/**
 * Walk a transcript selection.
 *
 * There is no selection until the first key: `alt+↑`/`alt+↓` then start at the
 * newest turn and move, clamped at both ends and empty when there is nothing
 * to select.
 */
export declare function moveSelection(current: number | undefined, delta: number, count: number): number | undefined;
/** Format a token count the way a status bar wants it: 834, 1.2K, 64K. */
export declare function formatTokens(count: number): string;
/** A deliberately rough chars/4 estimate, used until real usage is reported. */
export declare function estimateTokens(text: string): number;
