/**
 * A test for session isolation against real throwaway git repositories.
 *
 * `$DSH_HOME` and every repository are mkdtemp directories, git's identity and
 * config are pinned through the environment so the user's own config cannot
 * change an outcome, and everything is removed at the end.
 *
 * Run with: node --experimental-strip-types tests/git-workspace-smoke.ts
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'moqi-git-home-'))
const work = realpathSync(mkdtempSync(join(tmpdir(), 'moqi-git-work-')))
process.env['DSH_HOME'] = home
process.env['GIT_CONFIG_GLOBAL'] = '/dev/null'
process.env['GIT_CONFIG_NOSYSTEM'] = '1'
process.env['GIT_AUTHOR_NAME'] = 'moqi test'
process.env['GIT_AUTHOR_EMAIL'] = 'test@example.invalid'
process.env['GIT_COMMITTER_NAME'] = 'moqi test'
process.env['GIT_COMMITTER_EMAIL'] = 'test@example.invalid'

const ws = await import('../src/git-workspace.ts')

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

/** A repository on `main` with one commit. */
function repo(name: string): string {
  const dir = join(work, name)
  mkdirSync(dir)
  sh(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

try {
  // ---------------------------------------------------------------- names
  assert.equal(ws.branchName('Fix the Footer'), 'moqi/fix-the-footer')
  assert.equal(ws.branchName('moqi/already'), 'moqi/already')
  assert.equal(ws.branchName('../../etc'), 'moqi/etc')
  assert.throws(() => ws.branchName('***'), /no usable characters/)
  assert.match(ws.defaultBranchName(new Date('2026-10-18T12:00:00Z'), () => 0.5), /^moqi\/2026-10-18-8000$/)
  assert.ok(ws.isIsolation('branch') && !ws.isIsolation('sandbox'))

  // ---------------------------------------------------------------- not a repo
  const plain = join(work, 'plain')
  mkdirSync(plain)
  const skipped = await ws.startBranch(plain)
  assert.equal(skipped.kind, 'skipped')
  assert.equal(await ws.repoRoot(plain), undefined)

  // ---------------------------------------------------------------- branch in place
  const r = repo('r')
  writeFileSync(join(r, 'a.txt'), 'dirty\n')
  const started = await ws.startBranch(r)
  assert.equal(started.kind, 'branch')
  if (started.kind !== 'branch') throw new Error('unreachable')
  assert.ok(started.created)
  assert.equal(started.base, 'main')
  assert.equal(await ws.currentBranch(r), started.branch)
  assert.ok(await ws.isDirty(r), 'uncommitted changes travel onto the new branch')
  assert.equal(sh(r, 'config', `branch.${started.branch}.moqiBase`), 'main')

  // A second start in the same checkout reuses the moqi branch, never stacks.
  const again = await ws.startBranch(r)
  assert.equal(again.kind === 'branch' && again.branch, started.branch)
  assert.equal(again.kind === 'branch' && again.created, false)

  // No commits of its own: finishing switches back and deletes it, changes kept.
  const finished = await ws.finishBranch(r, started.branch)
  assert.equal(finished.kind, 'removed')
  assert.equal(await ws.currentBranch(r), 'main')
  assert.ok(await ws.isDirty(r), 'uncommitted changes travel back to the base')
  assert.equal(sh(r, 'branch', '--list', started.branch), '')

  // With a commit of its own, the branch is kept.
  const named = await ws.startBranch(r, 'one file')
  assert.equal(named.kind === 'branch' && named.branch, 'moqi/one-file')
  sh(r, 'commit', '-q', '-am', 'edit')
  const kept = await ws.finishBranch(r, 'moqi/one-file')
  assert.equal(kept.kind, 'kept')
  assert.equal(await ws.currentBranch(r), 'moqi/one-file')

  // Switching to an existing branch by name does not recreate it.
  sh(r, 'switch', '-q', 'main')
  const back = await ws.startBranch(r, 'one-file')
  assert.equal(back.kind === 'branch' && back.created, false)
  assert.equal(await ws.currentBranch(r), 'moqi/one-file')

  // A branch that is not moqi's is never touched.
  assert.equal((await ws.finishBranch(r, 'main')).kind, 'none')

  // ---------------------------------------------------------------- refusals
  const d = repo('detached')
  sh(d, 'switch', '-q', '--detach', 'HEAD')
  const det = await ws.startBranch(d)
  assert.equal(det.kind === 'skipped' && det.reason, 'HEAD is detached')

  const m = repo('merging')
  sh(m, 'switch', '-q', '-c', 'side')
  writeFileSync(join(m, 'a.txt'), 'side\n')
  sh(m, 'commit', '-q', '-am', 'side')
  sh(m, 'switch', '-q', 'main')
  writeFileSync(join(m, 'a.txt'), 'main\n')
  sh(m, 'commit', '-q', '-am', 'main')
  try {
    sh(m, 'merge', '-q', 'side')
  } catch {
    // the conflict is the point
  }
  const merging = await ws.startBranch(m)
  assert.equal(merging.kind === 'skipped' && merging.reason, 'a merge is in progress')

  // ---------------------------------------------------------------- worktrees
  const w = repo('w')
  sh(w, 'commit', '-q', '--allow-empty', '-m', 'unpushed')
  const tree = await ws.startWorktree(w, 'Big Refactor')
  assert.equal(tree.kind, 'worktree')
  if (tree.kind !== 'worktree') throw new Error('unreachable')
  assert.equal(tree.branch, 'moqi/big-refactor')
  assert.equal(tree.base, 'main')
  assert.ok(tree.cwd.startsWith(join(home, 'worktrees')), 'worktrees live outside the repository')
  assert.ok(ws.isMoqiWorktree(tree.cwd))
  assert.ok(!ws.isMoqiWorktree(w))
  assert.equal(sh(tree.cwd, 'log', '-1', '--format=%s'), 'unpushed', 'based on local HEAD, not the remote')
  assert.equal(await ws.currentBranch(w), 'main', 'the main checkout is left alone')
  await assert.rejects(ws.startWorktree(w, 'big refactor'), /already exists/)

  // Dirty: kept.
  writeFileSync(join(tree.cwd, 'new.txt'), 'x\n')
  const dirty = await ws.finishWorktree(tree.cwd)
  assert.equal(dirty.kind === 'kept' && dirty.reason, 'it has uncommitted changes')
  // Committed: kept.
  sh(tree.cwd, 'add', '.')
  sh(tree.cwd, 'commit', '-q', '-m', 'work')
  assert.equal((await ws.finishWorktree(tree.cwd)).kind, 'kept')
  assert.ok(existsSync(tree.cwd))

  // Untouched: removed, branch and all.
  const idle = await ws.startWorktree(w, 'idle', 'main')
  if (idle.kind !== 'worktree') throw new Error('expected a worktree')
  const removed = await ws.finishWorktree(idle.cwd)
  assert.equal(removed.kind, 'removed')
  assert.ok(!existsSync(idle.cwd))
  assert.equal(sh(w, 'branch', '--list', 'moqi/idle'), '')
  assert.equal((await ws.finishWorktree(idle.cwd)).kind, 'none')

  // ---------------------------------------------------------------- guidance
  const inPlace = ws.workspaceGuidance({ isolation: 'branch', branch: 'moqi/x', base: 'main', cwd: '/repo' })
  assert.match(inPlace, /on branch `moqi\/x`, which moqi created for this session from `main`/)
  assert.match(inPlace, /Do not switch branches/)
  assert.match(inPlace, /push `main` unless the user asks/)
  assert.doesNotMatch(inPlace, /fresh checkout/)
  const isolated = ws.workspaceGuidance({ isolation: 'worktree', branch: 'moqi/y', base: 'main', cwd: '/wt/y' })
  assert.match(isolated, /dedicated git worktree at \/wt\/y/)
  assert.match(isolated, /fresh checkout/)
  assert.doesNotMatch(isolated, /Do not switch branches/)
  // Not moqi's branch, or no isolation: nothing at all.
  assert.equal(ws.workspaceGuidance({ isolation: 'branch', branch: 'main', base: undefined, cwd: '/r' }), '')
  assert.equal(ws.workspaceGuidance({ isolation: undefined, branch: 'moqi/x', base: 'main', cwd: '/r' }), '')
  // Unknown base still reads as a sentence, and the text is stable call to call.
  assert.match(ws.workspaceGuidance({ isolation: 'branch', branch: 'moqi/x', base: undefined, cwd: '/r' }), /push the branch it was started from/)
  assert.equal(inPlace, ws.workspaceGuidance({ isolation: 'branch', branch: 'moqi/x', base: 'main', cwd: '/repo' }))
  assert.equal(await ws.recordedBase(r, 'moqi/one-file'), 'main')

  // ---------------------------------------------------------------- pruning
  const p = repo('prune')
  sh(p, 'branch', 'moqi/empty')            // no work: pruned
  sh(p, 'branch', 'moqi/kept-by-session')  // no work, but checked out below by a live session
  sh(p, 'switch', '-q', '-c', 'moqi/has-work')
  sh(p, 'commit', '-q', '--allow-empty', '-m', 'work')
  sh(p, 'switch', '-q', 'main')
  sh(p, 'branch', 'feature')               // not moqi's: never touched
  const idleTree = await ws.startWorktree(p, 'idle-tree')
  const liveTree = await ws.startWorktree(p, 'live-tree')
  if (idleTree.kind !== 'worktree' || liveTree.kind !== 'worktree') throw new Error('expected worktrees')
  sh(p, 'switch', '-q', 'moqi/kept-by-session')
  const prunedNames = await ws.pruneLeftovers(p, [p, liveTree.cwd])
  assert.deepEqual(prunedNames.sort(), ['moqi/empty', 'moqi/idle-tree'])
  assert.ok(!existsSync(idleTree.cwd))
  assert.ok(existsSync(liveTree.cwd), 'a worktree an open session uses is left alone')
  const left = sh(p, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').sort()
  assert.deepEqual(left, ['feature', 'main', 'moqi/has-work', 'moqi/kept-by-session', 'moqi/live-tree'])
  assert.deepEqual(await ws.pruneLeftovers(plain, []), [], 'outside a repository there is nothing to prune')

  // A worktree locked by another moqi that is still running is not ours to prune;
  // one whose owner is gone is.
  const elsewhere = await ws.startWorktree(p, 'elsewhere')
  const orphan = await ws.startWorktree(p, 'orphan')
  if (elsewhere.kind !== 'worktree' || orphan.kind !== 'worktree') throw new Error('expected worktrees')
  sh(p, 'worktree', 'unlock', elsewhere.cwd)
  sh(p, 'worktree', 'lock', '--reason', `moqi session pid ${String(process.ppid)}`, elsewhere.cwd)
  sh(p, 'worktree', 'unlock', orphan.cwd)
  sh(p, 'worktree', 'lock', '--reason', 'moqi session pid 2147483646', orphan.cwd)
  assert.deepEqual(await ws.pruneLeftovers(p, [p, liveTree.cwd]), ['moqi/orphan'])
  assert.ok(existsSync(elsewhere.cwd))

  console.log('git-workspace-smoke: ok')
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}
