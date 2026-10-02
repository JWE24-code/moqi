/**
 * The fleet overview: sessions across every device, in one list.
 *
 * This module is pure. It knows nothing about filesystems, SSH, or the
 * Harness — it takes presence records that someone else collected and turns
 * them into ordered, rendered rows. That is what keeps the interesting part
 * (staleness, ranking, what a row says) testable without a second machine.
 *
 * The transport is deliberately outside this file: see `src/fleet-sources.ts`.
 * @module
 */
/**
 * What one device publishes about one of its open sessions.
 *
 * A record is written by the app that owns the session and refreshed on a
 * heartbeat, so its age is the liveness signal. Nothing here is derived from
 * the session log: the owning app already knows its own status exactly, and
 * decompressing a log per session per device would not scale over SSH.
 */
export interface PresenceRecord {
    /** Record format version, so an older device's file can be rejected. */
    v: number;
    /** Device name, as the overview labels it. */
    host: string;
    /** Process that owns the session, for diagnosis only. */
    pid: number;
    sessionId: string;
    title: string;
    status: PresenceStatus;
    /** Model the session is using, when known. */
    model?: string;
    /** Working directory the session was created in. */
    cwd?: string;
    /** Epoch millis of the last heartbeat. */
    updatedAt: number;
}
/**
 * What a session is doing, as a device reports it.
 *
 * Deliberately declared here rather than imported from the session state: the
 * overview's wire format must not move when the local UI's types do, and it
 * keeps this module dependency-free apart from rendering helpers.
 */
export type PresenceStatus = 'idle' | 'running' | 'ready';
/** The record version this build writes and accepts. */
export declare const PRESENCE_VERSION = 1;
/**
 * How long a record may go unrefreshed before its device is presumed gone.
 *
 * Generous relative to the heartbeat: a laptop that sleeps mid-turn should
 * read as `stale` rather than flapping, and a slow SSH round trip must not
 * make a healthy device look dead.
 */
export declare const DEFAULT_STALE_AFTER_MS = 30000;
/** A session's state in the overview, including the one presence cannot claim. */
export type FleetStatus = PresenceStatus | 'stale';
/** One row of the overview. */
export interface FleetSession {
    host: string;
    sessionId: string;
    title: string;
    status: FleetStatus;
    model?: string;
    cwd?: string;
    updatedAt: number;
    /** True when this row is the device the overview is running on. */
    local: boolean;
    /** Seconds since the last heartbeat, for display. */
    ageSeconds: number;
}
/** Sentinel id for the "start a new session here" action row. */
export declare const NEW_SESSION_ID = "new-session";
/** Whether a row is the new-session action rather than a real session. */
export declare function isActionRow(session: FleetSession): boolean;
/**
 * The action row shown at the top of this device's group.
 *
 * It is not a presence record and never travels over SSH: it exists so the
 * list is also where a conversation is started, as the open-sessions picker
 * used to be.
 */
export declare function newSessionRow(host: string): FleetSession;
/** What a device's collector returned, including the failure case. */
export interface FleetSource {
    host: string;
    local: boolean;
    /** Records read from the device, or an empty list when it could not be read. */
    records: readonly PresenceRecord[];
    /** Set when the device could not be reached or read. */
    error?: string;
}
/** Whether a record is well-formed enough to display. */
export declare function isPresenceRecord(value: unknown): value is PresenceRecord;
/**
 * Merge every device's records into one ordered list.
 *
 * A record older than `staleAfterMs` is reported `stale` whatever it claimed:
 * a device that stopped heartbeating mid-turn would otherwise sit in the
 * overview claiming to be running forever.
 */
export declare function mergeFleet(sources: readonly FleetSource[], now: number, staleAfterMs?: number): FleetSession[];
/** A compact age: 8s, 4m, 2h, 3d. */
export declare function formatAge(seconds: number): string;
/**
 * The command that opens a session on the device that owns it.
 *
 * A remote session is reached the same way the device itself is: over SSH,
 * with a TTY, resuming by id. Nothing new is exposed to do it.
 */
export declare function jumpCommand(session: FleetSession, profile?: string): string;
/**
 * The argv to actually run {@link jumpCommand}'s remote half, for spawning
 * directly rather than copying to a clipboard.
 *
 * The session id is quoted for the remote shell the same way a dispatched
 * prompt is: a presence record names the id, and a presence record can come
 * from a compromised or merely buggy peer, so nothing here trusts it to be
 * shell-safe on its own.
 */
export declare function jumpArgv(session: FleetSession, profile?: string): string[];
/**
 * Quote one argument for a POSIX shell.
 *
 * A prompt is arbitrary text and is about to travel through `ssh`, which hands
 * it to the remote shell — so it is single-quoted with the one escape a single
 * quoted string has. Nothing here trusts the caller.
 */
export declare function shellQuote(text: string): string;
/**
 * The argv for dispatching a task to a peer's headless profile.
 *
 * The prompt is quoted for the remote shell; the profile name and host are
 * passed as separate argv words so the local shell never interprets them.
 */
export declare function dispatchArgv(host: string, profile: string, prompt: string): string[];
/** Options for {@link renderFleet}. */
export interface FleetRenderOptions {
    width: number;
    /** Index of the highlighted row, or -1 for none. */
    selectedIndex?: number;
    spinner?: string;
    /** Devices that could not be read, reported under the list. */
    sources?: readonly FleetSource[];
}
/**
 * Render the overview to styled lines.
 *
 * Grouped by device, because "which machine is this on" is the question the
 * overview exists to answer; an unreachable device is named rather than
 * silently contributing nothing.
 */
export declare function renderFleet(sessions: readonly FleetSession[], options: FleetRenderOptions): string[];
/** A one-line summary for the status bar: how much is running where. */
export declare function fleetSummary(sessions: readonly FleetSession[]): string;
/** Colors re-exported so a caller can match the overview's palette. */
export declare const FLEET_COLORS: {
    readonly colGreen: import("./theme.ts").AdaptiveColor;
    readonly colGold: import("./theme.ts").AdaptiveColor;
    readonly colMuted: import("./theme.ts").AdaptiveColor;
    readonly colText: import("./theme.ts").AdaptiveColor;
    readonly ok: (text: string) => string;
};
/**
 * Which rendered line carries row `index`.
 *
 * {@link renderFleet} inserts a heading per device and a blank line between
 * groups, so the selected row's index is not its line. The pane needs the
 * line to scroll, and duplicating the rule here rather than returning it from
 * the renderer keeps the renderer a plain function of its inputs. The two must
 * agree, which is what the smoke test pins.
 */
export declare function fleetLineOf(sessions: readonly FleetSession[], index: number): number;
/**
 * Whether a string is safe and sensible to use as a peer.
 *
 * The value ends up on an `ssh` command line, so this is a gate rather than a
 * tidy-up: anything a shell would treat as more than one word, or that `ssh`
 * would read as an option, is refused outright instead of being escaped and
 * hoped for. What remains is the shape of a host, an alias, or `user@host`.
 */
export declare function isValidPeer(host: string): boolean;
/**
 * The overview's interaction state: what was collected, and where the cursor is.
 *
 * Kept beside the renderer because it is the same concern and equally pure —
 * it never reads a file or a socket. The app owns collection and hands the
 * result here.
 */
export declare class FleetView {
    open: boolean;
    /** True while a collection round is in flight, so the pane can say so. */
    loading: boolean;
    sessions: FleetSession[];
    sources: FleetSource[];
    selected: number;
    /**
     * Set while the pane is asking for a device to add.
     *
     * Adding a peer belongs here rather than only on the command line, because
     * the list is exactly where you notice a device is missing from it.
     */
    adding: boolean;
    /** What has been typed into that prompt so far. */
    draft: string;
    show(): void;
    hide(): void;
    /**
     * Install a freshly collected round.
     *
     * The cursor follows the session it was on rather than the position it was
     * at: rows reorder as work starts and finishes, and a refresh that moved the
     * selection onto a different machine would be a way to open the wrong thing.
     */
    setResult(sessions: readonly FleetSession[], sources: readonly FleetSource[]): void;
    move(delta: number): void;
    current(): FleetSession | undefined;
    /**
     * Drop a row the app just closed, so the list does not keep showing it until
     * the next collection round. The cursor stays put unless that was the last
     * row.
     */
    removeAt(index: number): void;
    /** Start asking for a device to add. */
    beginAdd(): void;
    /** Abandon the prompt, leaving the list as it was. */
    cancelAdd(): void;
    typeAdd(text: string): void;
    backspaceAdd(): void;
    /**
     * Finish the prompt, returning the host to add.
     *
     * A rejected name leaves the prompt open with the text intact, so a typo is
     * corrected rather than retyped.
     */
    commitAdd(): string | undefined;
    private clamp;
}
/**
 * The fleet's device list. The peers given at launch and the ones adopted
 * while running are one list once the app is up; the app remembers it across
 * restarts by persisting what this list holds.
 */
export declare class PeerList {
    private hosts;
    constructor(hosts?: string[]);
    all(): string[];
    has(host: string): boolean;
    /** Replace the whole list (the launch path, merging config and persisted). */
    replaceAll(hosts: string[]): void;
    /** The list as fleet-source configs, ready for a collection round. */
    configs(): {
        host: string;
    }[];
    /**
     * Adopt a device.
     *
     * Fails on an unusable host or one already present — the caller phrases the
     * difference, since one is a typo and the other is not an error at all.
     */
    add(host: string): {
        ok: true;
    } | {
        ok: false;
        reason: 'invalid' | 'duplicate';
    };
    /** Forget a device. `false` when it was not in the fleet. */
    remove(host: string): boolean;
}
