/**
 * Small durable state for the terminal app: composer history, UI
 * preferences, the sessions that were open, and the usage ledger, kept as one
 * JSON file under `$DSH_HOME`.
 *
 * Everything here is best-effort by design. The app must run on a read-only
 * or missing home just as well as on a writable one — persistence is a
 * convenience, never a dependency.
 * @module moqi-tui/persist
 */
import type { UsageEntry, UsageLedger } from './usage.ts';
/**
 * One session that was open when the app last exited.
 *
 * Only the id is load-bearing — the transcript itself lives in the Harness
 * session store and is re-read on restore. The model and title are carried
 * along so the tab bar and footer read correctly the instant the app paints,
 * rather than snapping into place once each agent has been adopted.
 */
export interface PersistedSession {
    /** The Harness session id to re-adopt. */
    id: string;
    /** Label of the model that session was using; empty means "use the default". */
    model: string;
    /** The tab's title, normally the opening prompt; empty until one is sent. */
    title: string;
    /** Color palette that session was using; absent means "use the default". */
    theme?: string;
}
/** What survives a restart of the app. */
export interface PersistedState {
    /** Previously sent prompts, oldest first, for composer recall. */
    inputHistory: string[];
    /** Whether reasoning output was visible when the app last ran. */
    thinking: boolean;
    /** Name of the chosen color palette; absent means the app's default. */
    theme?: string;
    /** Interface language: `en` or `zh-CN`. */
    lang?: string;
    /** Whether the first-run setup list has been seen; it returns until it has. */
    setupDone?: boolean;
    /**
     * Whether tool calls were listed rather than summarized when the app last
     * ran; absent means the default, which is to list them.
     */
    expandTools?: boolean;
    /**
     * Whether the stacked view was open when the app last ran; absent means the
     * default. The profile's `view` config only fills a first run — the last
     * view you switched to wins.
     */
    stackView?: boolean;
    /** Devices to include in the fleet overview, as `ssh` destinations. */
    peers: string[];
    /** Sessions that were open at the last exit, in tab order. */
    sessions: PersistedSession[];
    /** Index into {@link PersistedState.sessions} of the tab that was on screen. */
    activeSession: number;
    /** Per-provider token usage, accumulated across every session so far. */
    usage: UsageLedger;
    /**
     * The rolling-window log `/usage`'s session (5h) and week (7d) views are
     * computed from — bounded to the last 7 days, unlike `usage` itself, which
     * never forgets.
     */
    usageEntries: UsageEntry[];
}
/**
 * How many sessions a single restore will bring back.
 *
 * Every restored tab costs one session-store lookup and one agent adoption,
 * both of them I/O before the first paint. A state file that has grown a long
 * tail — or been hand-edited — must not turn a launch into a multi-second
 * stall, and nobody navigates more tabs than this by hand anyway.
 */
export declare const MAX_RESTORED_SESSIONS = 16;
/** Where the state file lives: `$DSH_HOME/tui-state.json`, default `~/.dsh`. */
export declare function statePath(env?: NodeJS.ProcessEnv): string;
/**
 * Turn the raw file contents into state, without touching the filesystem.
 *
 * Parsing is separated from reading so the whole degrade-gracefully contract
 * — bad JSON, a version from another release, a half-written array of
 * sessions — can be exercised as a pure function. It never throws: an input
 * it cannot make sense of yields the fallback, which is always usable.
 */
export declare function decodeState(raw: string): PersistedState;
/**
 * Assemble the state to write, from the live values the app holds.
 *
 * The field list lives here rather than inline in the app because listing it
 * by hand is exactly how fields get lost: `persistNow` used to rebuild the
 * object itself, and every field it forgot — `lang` and `setupDone` were both
 * dropped this way — was written as absent on every save no matter what the
 * app had set. One list, in one place, exercised by a test.
 */
export declare function assembleState(input: {
    inputHistory: string[];
    thinking: boolean;
    theme: string;
    lang: string;
    setupDone: boolean | undefined;
    expandTools: boolean | undefined;
    stackView: boolean | undefined;
    peers: string[];
    sessions: PersistedSession[];
    activeSession: number;
    usage: UsageLedger;
    usageEntries: UsageEntry[];
}): PersistedState;
/**
 * Read the persisted state, returning the fallback when there is none or it
 * cannot be understood.
 */
export declare function loadState(env?: NodeJS.ProcessEnv): Promise<PersistedState>;
/** The sessions to bring back, and which of them to put on screen. */
export interface RestorePlan {
    /** Sessions worth adopting, in tab order; may be empty. */
    sessions: PersistedSession[];
    /** Index into {@link RestorePlan.sessions} to make active. */
    active: number;
}
/**
 * Decide what a restore should attempt, given what is still on disk.
 *
 * The session store is not owned by this app: `/delete` prunes it, and so does
 * anything else that touches `$DSH_HOME` between two runs. A remembered id
 * whose directory has gone is therefore an ordinary outcome and not an error —
 * it is dropped here, silently, before anything tries to adopt it.
 *
 * @param state - what was read back from disk.
 * @param isAvailable - whether that session id still exists in the store.
 */
export declare function restorePlan(state: PersistedState, isAvailable: (id: string) => boolean): RestorePlan;
/**
 * A scratch path for the write-then-rename, unique to this process.
 *
 * The rename is what makes a save atomic, but the file it renames has to be
 * this process's alone. Several sessions of this app run at once -- that is
 * the point of the fleet -- and when two of them saved at the same moment they
 * wrote the same `tui-state.json.tmp` on top of each other and renamed the
 * interleaved result into place. The file that came out was one complete
 * document followed by a fragment of another, which every later read then
 * discarded as unparseable, silently losing the remembered sessions, peers and
 * theme. Observed, not hypothetical.
 */
export declare function scratchPath(target: string): string;
/**
 * Write the state atomically: a temporary file in the same directory, then a
 * rename, so a crash mid-write can never leave a half-written JSON behind.
 */
export declare function saveState(state: PersistedState, env?: NodeJS.ProcessEnv): Promise<void>;
/**
 * The synchronous twin of {@link saveState}, for the teardown path: `quit()`
 * asks the launcher to exit immediately, so an in-flight async write would be
 * cut off and the last prompt lost.
 */
export declare function saveStateSync(state: PersistedState, env?: NodeJS.ProcessEnv): void;
