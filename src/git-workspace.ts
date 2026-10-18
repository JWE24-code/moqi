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

import { execFile } from 'node:child_process'
import { existsSync, rmdirSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { dshHome, slugify } from './memory.ts'
import { projectKey } from './sessions-store.ts'

/** How a new session in a repository isolates its changes. */
export type Isolation = 'off' | 'branch' | 'worktree'
export const ISOLATIONS: readonly Isolation[] = ['off', 'branch', 'worktree']

/** Every branch moqi creates starts with this. */
export const BRANCH_PREFIX = 'moqi/'

/** The outcome of giving a session somewhere to work. */
export type StartResult =
  | { kind: 'branch'; cwd: string; branch: string; base: string; created: boolean }
  | { kind: 'worktree'; cwd: string; branch: string; base: string }
  | { kind: 'skipped'; cwd: string; reason: string }

/** The outcome of closing a session's branch or worktree. */
export type FinishResult =
  | { kind: 'removed'; branch: string }
  | { kind: 'kept'; branch: string; reason: string; path?: string }
  | { kind: 'none' }

export function isIsolation(value: string): value is Isolation {
  return (ISOLATIONS as readonly string[]).includes(value)
}

/** Run git in `cwd`; resolves with trimmed stdout, rejects with git's own message. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        done(stdout.trim())
        return
      }
      const message = stderr.trim() !== '' ? stderr.trim() : error.message
      fail(new Error(`git ${args[0] ?? ''}: ${message}`))
    })
  })
}

/** git, answering undefined instead of throwing — for probes. */
async function probe(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args)
  } catch {
    return undefined
  }
}

/** The top of the work tree containing `cwd`, or undefined outside a repository. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  return await probe(cwd, ['rev-parse', '--show-toplevel'])
}

/** The checked-out branch, or undefined on a detached HEAD or outside a repository. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  const name = await probe(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return name === undefined || name === '' ? undefined : name
}

/** A rebase, merge, cherry-pick, revert, or bisect is in progress. */
async function operationInProgress(cwd: string): Promise<string | undefined> {
  const gitDir = await probe(cwd, ['rev-parse', '--absolute-git-dir'])
  if (gitDir === undefined) return undefined
  const markers: [string, string][] = [
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['MERGE_HEAD', 'a merge'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['BISECT_LOG', 'a bisect'],
  ]
  for (const [marker, label] of markers) {
    if (existsSync(join(gitDir, marker))) return label
  }
  return undefined
}

/** Uncommitted changes, untracked files included. */
export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])) !== ''
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await probe(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) !== undefined
}

/** Turn a user-typed name into `moqi/<slug>`, accepting one that already has the prefix. */
export function branchName(name: string): string {
  const bare = name.startsWith(BRANCH_PREFIX) ? name.slice(BRANCH_PREFIX.length) : name
  let slug: string
  try {
    slug = slugify(bare)
  } catch {
    throw new Error(`branch name has no usable characters: ${JSON.stringify(name)}`)
  }
  return BRANCH_PREFIX + slug
}

/** A default name for a session's branch: the date and a short random tail. */
export function defaultBranchName(now: Date = new Date(), random: () => number = Math.random): string {
  const date = now.toISOString().slice(0, 10)
  const tail = Math.floor(random() * 0x10000).toString(16).padStart(4, '0')
  return `${BRANCH_PREFIX}${date}-${tail}`
}

/** Where worktrees for the repository at `root` live. */
export function worktreesDir(root: string): string {
  return join(dshHome(), 'worktrees', projectKey(resolve(root)))
}

/** Whether `cwd` is inside one of moqi's worktrees. */
export function isMoqiWorktree(cwd: string): boolean {
  const rel = relative(join(dshHome(), 'worktrees'), resolve(cwd))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function recordBase(cwd: string, branch: string, base: string): Promise<void> {
  await git(cwd, ['config', `branch.${branch}.moqiBase`, base])
}

async function recordedBase(cwd: string, branch: string): Promise<string | undefined> {
  const base = await probe(cwd, ['config', '--get', `branch.${branch}.moqiBase`])
  return base === '' ? undefined : base
}

/**
 * Commits on `branch` that no other branch (local or remote) reaches.
 * Zero means deleting the branch loses nothing.
 */
async function uniqueCommits(cwd: string, branch: string): Promise<number> {
  const count = await git(cwd, [
    'rev-list', '--count', `refs/heads/${branch}`,
    '--not', `--exclude=${branch}`, '--branches', '--remotes',
  ])
  return Number.parseInt(count, 10) || 0
}

/** Why a new branch cannot be started here right now, or undefined when it can. */
async function cannotBranch(cwd: string): Promise<string | undefined> {
  if ((await repoRoot(cwd)) === undefined) return 'not a git repository'
  const busy = await operationInProgress(cwd)
  if (busy !== undefined) return `${busy} is in progress`
  if ((await currentBranch(cwd)) === undefined) return 'HEAD is detached'
  return undefined
}

/**
 * Put the session at `cwd` on a branch of its own, in place.
 *
 * Already on a `moqi/` branch — a restart, or a second tab in the same
 * checkout — means that branch is reused rather than stacked on. Uncommitted
 * changes travel with the switch, as `git switch -c` does.
 */
export async function startBranch(cwd: string, name?: string): Promise<StartResult> {
  const blocked = await cannotBranch(cwd)
  if (blocked !== undefined) return { kind: 'skipped', cwd, reason: blocked }
  const current = (await currentBranch(cwd)) as string
  if (name === undefined && current.startsWith(BRANCH_PREFIX)) {
    const base = (await recordedBase(cwd, current)) ?? current
    return { kind: 'branch', cwd, branch: current, base, created: false }
  }
  const branch = name === undefined ? defaultBranchName() : branchName(name)
  if (branch === current) {
    return { kind: 'branch', cwd, branch, base: (await recordedBase(cwd, branch)) ?? current, created: false }
  }
  if (await branchExists(cwd, branch)) {
    await git(cwd, ['switch', branch])
    return { kind: 'branch', cwd, branch, base: (await recordedBase(cwd, branch)) ?? current, created: false }
  }
  await git(cwd, ['switch', '-c', branch])
  await recordBase(cwd, branch, current)
  return { kind: 'branch', cwd, branch, base: current, created: true }
}

/**
 * Create a worktree for a new session, on a new `moqi/<name>` branch.
 *
 * `base` defaults to the current HEAD — including commits not yet pushed —
 * rather than the remote's default branch.
 */
export async function startWorktree(cwd: string, name: string, base = 'HEAD'): Promise<StartResult> {
  const root = await repoRoot(cwd)
  if (root === undefined) return { kind: 'skipped', cwd, reason: 'not a git repository' }
  const branch = branchName(name)
  if (await branchExists(root, branch)) throw new Error(`branch ${branch} already exists`)
  const path = join(worktreesDir(root), branch.slice(BRANCH_PREFIX.length))
  if (existsSync(path)) throw new Error(`${path} already exists`)
  const baseLabel = base === 'HEAD' ? ((await currentBranch(root)) ?? (await git(root, ['rev-parse', '--short', 'HEAD']))) : base
  await git(root, ['worktree', 'add', '-b', branch, path, base])
  await recordBase(root, branch, baseLabel)
  return { kind: 'worktree', cwd: path, branch, base: baseLabel }
}

/**
 * Close out the branch a session worked on in place.
 *
 * Removed only when it is still checked out at `cwd`, carries no commit of its
 * own, and its recorded base still exists: then HEAD goes back to the base
 * (uncommitted changes travel back with it) and the branch is deleted.
 */
export async function finishBranch(cwd: string, branch: string): Promise<FinishResult> {
  if (!branch.startsWith(BRANCH_PREFIX)) return { kind: 'none' }
  if (!(await branchExists(cwd, branch))) return { kind: 'none' }
  if ((await currentBranch(cwd)) !== branch) return { kind: 'kept', branch, reason: 'no longer checked out' }
  if ((await uniqueCommits(cwd, branch)) > 0) return { kind: 'kept', branch, reason: 'it has commits' }
  const base = await recordedBase(cwd, branch)
  if (base === undefined || !(await branchExists(cwd, base))) {
    return { kind: 'kept', branch, reason: 'its base branch is unknown' }
  }
  try {
    await git(cwd, ['switch', base])
  } catch (error) {
    return { kind: 'kept', branch, reason: (error as Error).message }
  }
  await git(cwd, ['branch', '-D', branch])
  await probe(cwd, ['config', '--remove-section', `branch.${branch}`])
  return { kind: 'removed', branch }
}

/**
 * Close out a session's worktree: removed with its branch when clean and
 * without commits of its own, otherwise kept where it is.
 */
export async function finishWorktree(path: string): Promise<FinishResult> {
  if (!existsSync(path)) return { kind: 'none' }
  const branch = await currentBranch(path)
  if (branch === undefined) return { kind: 'kept', branch: '(detached)', reason: 'HEAD is detached', path }
  if (await isDirty(path)) return { kind: 'kept', branch, reason: 'it has uncommitted changes', path }
  if ((await uniqueCommits(path, branch)) > 0) return { kind: 'kept', branch, reason: 'it has commits', path }
  const common = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const mainRoot = resolve(common, '..')
  await git(mainRoot, ['worktree', 'remove', path])
  await git(mainRoot, ['branch', '-D', branch])
  await probe(mainRoot, ['config', '--remove-section', `branch.${branch}`])
  // The per-project directory goes with its last worktree; rmdir refuses a non-empty one.
  try {
    rmdirSync(dirname(path))
  } catch {
    // other worktrees of this project are still there
  }
  return { kind: 'removed', branch }
}
