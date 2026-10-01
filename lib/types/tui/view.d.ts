/**
 * Frame composition: header, transcript, palette popup, composer, footer.
 *
 * The renderer is pure — it turns a snapshot of the app into the exact lines
 * the screen should show, and reports where the cursor belongs. Nothing here
 * touches the terminal or the Harness.
 * @module
 */
import { type FleetView } from './fleet.ts';
import { type UsageView } from './usage-view.ts';
import { Composer, type Message, type Palette, type BackgroundAgent, type Picker, type Segment, type SessionSummary } from './state.ts';
import { type AtMenu } from './atfile.ts';
import { type Span } from './select.ts';
import type { PanelView } from './panels.ts';
/** Everything the renderer needs to draw one frame. */
export interface Snapshot {
    columns: number;
    rows: number;
    title: string;
    host: string;
    modelName: string;
    messages: readonly Message[];
    /** The turn streaming in, prose and calls in arrival order. */
    streamingSegments: readonly Segment[];
    streamingReasoning: string;
    streaming: boolean;
    spinner: string;
    status: string;
    statusIsError: boolean;
    overlay: string;
    showThinking: boolean;
    composer: Composer;
    palette: Palette;
    picker: Picker;
    /** Rows scrolled up from the bottom of the transcript. */
    scrollBack: number;
    /** Whether each tool call is listed instead of summarized on one line. */
    expandTools: boolean;
    /** Open sessions, in creation order; the bar is hidden when there is one. */
    sessions: readonly SessionSummary[];
    /** Live agents other than the foreground one, newest last. */
    background: readonly BackgroundAgent[];
    /** Whether the background agents are listed instead of counted on one line. */
    expandBackground: boolean;
    /** Seconds the current reply has been running, for the activity line. */
    elapsedSeconds: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    haveUsage: boolean;
    contextLimit: number;
    /** Output tokens per second for the last settled turn; 0 when unknown. */
    tps?: number;
    /** Prompt tokens served from cache, and the total prompt tokens they came from. */
    cacheReadTokens?: number;
    confirming: boolean;
    /** Set while confirming: the yes/no question, drawn in the composer. */
    confirmText?: string;
    /** Whether a `/find` search is open, so its counter outranks the scroll hint. */
    searchActive?: boolean;
    /**
     * Prompts queued while the active session's reply streams, drawn dimmed
     * under the streaming block. Optional so snapshot builders without a
     * queue render exactly as before.
     */
    queued?: readonly string[];
    /**
     * The cross-device overview, when one is open. Optional so every existing
     * snapshot builder renders exactly as before.
     */
    fleet?: FleetView;
    /**
     * The `/usage` dashboard, when it is open. Optional so every existing
     * snapshot builder renders exactly as before.
     */
    usage?: UsageView;
    /**
     * Push-to-talk state, while the microphone is open or whisper is running.
     * Optional so every existing snapshot builder renders exactly as before.
     */
    voice?: VoicePhase;
    /**
     * The `@` file-completion menu, while an `@` token is being typed.
     * Optional so every existing snapshot builder renders exactly as before.
     */
    atMenu?: AtMenu;
    /**
     * A trust-surface panel (approval, question, plan review). While one is
     * open it owns the keyboard and replaces the transcript.
     */
    panel?: PanelView;
    /**
     * Index of the transcript turn under selection, marked with a gold bar.
     * Optional so every existing snapshot builder renders exactly as before.
     */
    selectedTurn?: number;
    /** One line a plugin contributed, drawn above the composer. */
    pluginLine?: string;
    /** The composer's vim mode, when modal editing is on. */
    vimMode?: 'insert' | 'normal';
    /**
     * The stacked view, while `/stack` has it open: every open session tiled
     * into the transcript region at once, one per pane. The pane snapshots are
     * whole ones so a pane draws with the exact renderer the full view uses.
     * Optional so every existing snapshot builder renders exactly as before.
     */
    stack?: {
        panes: readonly StackPane[];
        focused: number;
    };
    /**
     * A mouse drag's selection, drawn as the highlight over the frame. Only a
     * real drag sets it — a press that has not moved is still a pending click.
     * Optional so every existing snapshot builder renders exactly as before.
     */
    selection?: Span;
}
/** One tiled pane in the stacked view: a session's snapshot and its label. */
export interface StackPane {
    title: string;
    snapshot: Snapshot;
}
/** What push-to-talk is doing, for the footer indicator. */
export type VoicePhase = 'recording' | 'transcribing';
/** Geometry derived from the terminal size and the current composer height. */
export interface Layout {
    contentWidth: number;
    viewportRows: number;
    paletteRows: number;
    inputRows: number;
    /** Rows the `@` file-completion popup shows, excluding its border. */
    atRows: number;
    /** One row when a plugin contributed a status line. */
    pluginRows: number;
    /** Rows the background-agent strip occupies, including any border. */
    backgroundRows: number;
    /** Rows the session tab bar occupies (0 or 1). */
    sessionRows: number;
    /** Cleared on a window too short to afford the header. */
    showHeader: boolean;
    /** Cleared on a window too short to afford the blank separator row. */
    showGap: boolean;
}
/** Compute the geometry for a frame. */
export declare function layout(snapshot: Snapshot): Layout;
/** Strip the scheme and trailing slash from a base URL for the header. */
export declare function hostLabel(base: string): string;
/**
 * How far back the transcript can scroll: anything beyond this is empty space
 * above the first line, so the caller clamps to it rather than letting the view
 * drift off the top.
 */
export declare function maxScrollBack(snapshot: Snapshot): number;
/**
 * Lines of the rendered body that contain `query`, case-insensitively.
 *
 * Matching runs over the printable text of each line — the styled form is full
 * of SGR escapes the user never typed — and returns indexes into the same
 * line array the viewport slices, so a hit can be scrolled to directly.
 */
export declare function findMatches(snapshot: Snapshot, query: string): number[];
/**
 * The screen row the session bar occupies, or `undefined` when it is not
 * drawn. Clicks and the renderer must agree on where the bar is, and the
 * header above it is conditional — so the position is computed from the same
 * layout the frame is, never assumed to be the first row.
 */
export declare function sessionBarRow(snapshot: Snapshot): number | undefined;
/**
 * The tab a mouse click lands on, if any: the whole decision, pure.
 *
 * Keeping it here rather than in the app means the two halves that must
 * agree — which row the bar is on, and which column inside it a tab covers —
 * are exercised together, against the same layout the renderer uses.
 */
export declare function tabClickTarget(snapshot: Snapshot, cell: {
    column: number;
    row: number;
}): number | undefined;
/**
 * Which transcript turn a mouse click landed on, if any.
 *
 * Click-to-copy needs the same guarantee the tab bar gets: the hit test is
 * computed from the layout the frame was drawn with, not assumed. A click in
 * the blank line between two turns selects the turn above it — a gap is not
 * worth a miss. Returns `undefined` when the transcript pane is not on screen
 * (an overlay, picker, panel, or the stacked view, whose per-pane mapping is
 * its own later piece) or the click fell outside it.
 */
export declare function turnClickTarget(snapshot: Snapshot, cell: {
    row: number;
}): number | undefined;
/**
 * Which session a click on the tab bar landed on, if any.
 *
 * The extents mirror {@link sessionBar}'s cell construction exactly — mark,
 * space, label truncated to 18, and the wrapping spaces — because a hit test
 * that drifts from the renderer sends clicks to the wrong tab, which is worse
 * than no click support at all: it looks deliberate. Styled text measures the
 * same as plain (the escapes carry no width), so the arithmetic runs on the
 * unstyled shapes. Returns `undefined` for a click between tabs, on the
 * overflow marker, or when the bar is not being drawn at all.
 */
export declare function tabAtColumn(snapshot: Snapshot, column: number): number | undefined;
/** Build a full frame plus the cursor position for the screen to place. */
export declare function render(snapshot: Snapshot): {
    lines: string[];
    cursor: {
        row: number;
        column: number;
    } | undefined;
};
/**
 * The help text shown by `/help`, rendered as markdown in the transcript pane.
 *
 * It is longer than a default 80x24 window, and the overlay shows the *tail*
 * of it, so the list has a budget: every line added here pushes one off the
 * top, and what falls off first is the session keys. A new section therefore
 * comes with an equal number of lines folded together further down — which is
 * why several entries below read as two keys on one row.
 */
/**
 * The key reference.
 *
 * The strings live in the `i18n` catalog so one list covers both languages;
 * this export is the English one, which the render tests assert against.
 *
 * The overlay shows the tail of it, so the list has a budget: a new section
 * comes with an equal number of lines folded elsewhere. A line added to one
 * language's copy in `i18n.ts` must be added to the other, or the two drift.
 */
export declare const HELP_TEXT: string;
/** The key reference in the active language, for the `/help` overlay. */
export declare function keyReference(): string;
