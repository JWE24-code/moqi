/**
 * Where a session's code changes land: its own branch in place, or its own
 * worktree.
 *
 * A session's working directory is fixed when the Harness creates it, so the
 * choice is made at session start, not at the first edit. `branch` is the
 * cheap default — the same files, a fresh `moqi/<name>` branch — and suits a
 * one-file change. `worktree` is a full second checkout for work that must
 * not collide with anything else open in the repo. Worktrees live under
 * `$DSH_HOME/worktrees/<projectKey>/`, outside the repository, so Node never
 * walks up from one into the main checkout's `node_modules`.
 *
 * The branch a session started from is recorded in the repo's own config
 * (`branch.<name>.moqiBase`), so cleanup still knows where to return after a
 * restart. Cleanup only ever deletes a branch whose commits are all reachable
 * from some other branch, and only removes a worktree that is clean — anything
 * else is kept and reported.
 *
 * Harness-free: node builtins and `git` (found on PATH once, then run by its
 * absolute path) only.
 */
/** How a new session in a repository isolates its changes. */
export type Isolation = 'off' | 'branch' | 'worktree';
export declare const ISOLATIONS: readonly Isolation[];
/** How an isolated session was placed: every {@link Isolation} but `off`. */
export type ActiveIsolation = Exclude<Isolation, 'off'>;
/** Every branch moqi creates starts with this. */
export declare const BRANCH_PREFIX = "moqi/";
/** The outcome of giving a session somewhere to work. */
export type StartResult = {
    kind: 'branch';
    cwd: string;
    branch: string;
    base: string;
    created: boolean;
} | {
    kind: 'worktree';
    cwd: string;
    branch: string;
    base: string;
} | {
    kind: 'skipped';
    cwd: string;
    reason: string;
};
/** The outcome of closing a session's branch or worktree. */
export type FinishResult = {
    kind: 'removed';
    branch: string;
} | {
    kind: 'kept';
    branch: string;
    reason: string;
    path?: string;
} | {
    kind: 'none';
};
export declare function isIsolation(value: string): value is Isolation;
/** The top of the work tree containing `cwd`, or undefined outside a repository. */
export declare function repoRoot(cwd: string): Promise<string | undefined>;
/** The checked-out branch, or undefined on a detached HEAD or outside a repository. */
export declare function currentBranch(cwd: string): Promise<string | undefined>;
/** Uncommitted changes, untracked files included. */
export declare function isDirty(cwd: string): Promise<boolean>;
/** Turn a user-typed name into `moqi/<slug>`, accepting one that already has the prefix. */
export declare function branchName(name: string): string;
/** A default name for a session's branch: the date and a short random tail. */
export declare function defaultBranchName(now?: Date, random?: () => number): string;
/** Where worktrees for the repository at `root` live. */
export declare function worktreesDir(root: string): string;
/** Whether `cwd` is inside one of moqi's worktrees. */
export declare function isMoqiWorktree(cwd: string): boolean;
/** The branch a moqi branch was started from, as recorded when it was created. */
export declare function recordedBase(cwd: string, branch: string): Promise<string | undefined>;
/**
 * Put the session at `cwd` on a branch of its own, in place.
 *
 * Already on a `moqi/` branch — a restart, or a second tab in the same
 * checkout — means that branch is reused rather than stacked on. Uncommitted
 * changes travel with the switch, as `git switch -c` does.
 */
export declare function startBranch(cwd: string, name?: string): Promise<StartResult>;
/**
 * Create a worktree for a new session, on a new `moqi/<name>` branch.
 *
 * `base` defaults to the current HEAD — including commits not yet pushed —
 * rather than the remote's default branch.
 */
export declare function startWorktree(cwd: string, name: string, base?: string): Promise<StartResult>;
/**
 * Remove moqi's own leftovers in the repository at `cwd`: worktrees and
 * branches that hold no work and that no open session is using.
 *
 * Quitting keeps a session's branch so the session can come back on it; a
 * session that never comes back would otherwise leave an empty `moqi/` branch
 * behind forever. "Holds no work" is the same rule `/close` uses — no commit
 * of its own, and for a worktree, nothing uncommitted — so a pruned branch
 * loses nothing. `inUse` is every directory an open session works in.
 */
export declare function pruneLeftovers(cwd: string, inUse: readonly string[]): Promise<string[]>;
/**
 * The working rules the model gets for an isolated session — an AGENTS.md
 * block written from the session's real state rather than by hand.
 *
 * Empty unless the session is on one of moqi's own branches, so a session the
 * user put on their own branch (or ran with isolation off) gets nothing. The
 * text depends only on mode, branch, base, and directory, so it stays
 * byte-stable for the life of a branch and never disturbs the prompt cache.
 */
export declare function workspaceGuidance(input: {
    isolation?: ActiveIsolation;
    branch?: string;
    base?: string;
    cwd: string;
}): string;
/**
 * Where one session works, and every rule about it.
 *
 * The app holds one of these per session and only ever asks it questions or
 * hands it the other open workspaces; the git commands, the "which failures
 * are worth saying" choices, the shared-checkout rule, and the fork guard all
 * live here, so they are tested here. A fork shares its parent's instance:
 * same directory, same branch, and `finish` sees the twin and keeps it.
 */
export declare class Workspace {
    /** The directory the session works in; fixed for the session's life. */
    readonly cwd: string;
    /** The checkout `cwd` belongs to (a worktree is its own); undefined outside a repo. */
    readonly root: string | undefined;
    /** How moqi isolated this session; undefined when it works where it was opened. */
    isolation: ActiveIsolation | undefined;
    /** The branch checked out at `cwd`, as of the last `refresh`. */
    branch: string | undefined;
    /** The branch an isolated session's branch was started from. */
    base: string | undefined;
    /** What to tell the user about how the session was placed, if anything. */
    readonly notice: string | undefined;
    private constructor();
    /** A placeholder for a session not yet placed: `cwd`, nothing known. */
    static unplaced(cwd: string): Workspace;
    /**
     * Place a new session opened in `cwd` per the isolation choice. Never
     * throws: a git failure means working in place, with the reason as the notice.
     */
    static place(cwd: string, mode: Isolation): Promise<Workspace>;
    /** A new session in its own worktree, by request: failures throw rather than fall back. */
    static worktree(cwd: string, name: string, base?: string): Promise<Workspace>;
    /** A resumed session's workspace, inferred from disk; creates nothing. */
    static adopt(cwd: string): Promise<Workspace>;
    private static from;
    /** Re-read the checked-out branch; true when it changed. */
    refresh(): Promise<boolean>;
    /** Whether `other` works in the same checkout, so a branch switch here moves its files too. */
    sharesCheckoutWith(other: Workspace): boolean;
    /**
     * `/branch <name>`: create or switch to `moqi/<name>` here. Returns what to
     * say; throws with git's message when git refuses. The caller decides
     * whether switching is safe right now (who is mid-reply is app state).
     */
    useBranch(name: string): Promise<string>;
    /** The model's workspace rules for this session; see {@link workspaceGuidance}. */
    guidance(): string;
    /**
     * Close out this session's branch or worktree, given the workspaces of the
     * sessions still open — not including the one closing. Left alone while any
     * of them works in the same place: a second tab, or a fork, which holds this
     * very instance. Otherwise removed only when it changed nothing, per
     * {@link finishBranch} / {@link finishWorktree}.
     */
    finish(stillOpen: readonly Workspace[]): Promise<FinishResult>;
}
/** The status line for a finish, or undefined when there is nothing to say. */
export declare function describeFinish(result: FinishResult): string | undefined;
/**
 * Close out the branch a session worked on in place.
 *
 * Removed only when it is still checked out at `cwd`, carries no commit of its
 * own, and its recorded base still exists: then HEAD goes back to the base
 * (uncommitted changes travel back with it) and the branch is deleted.
 */
export declare function finishBranch(cwd: string, branch: string): Promise<FinishResult>;
/**
 * Close out a session's worktree: removed with its branch when clean and
 * without commits of its own, otherwise kept where it is.
 */
export declare function finishWorktree(path: string): Promise<FinishResult>;
