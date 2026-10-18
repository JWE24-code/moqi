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
 * Harness-free: node builtins and `git` on PATH only.
 */
/** How a new session in a repository isolates its changes. */
export type Isolation = 'off' | 'branch' | 'worktree';
export declare const ISOLATIONS: readonly Isolation[];
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
