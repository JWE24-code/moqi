/**
 * A dependency-free test for the persistence layer.
 *
 * `src/persist.ts` is async (fs/promises), so it gets its own script rather
 * than an async section inside the synchronous render-smoke suite. Every
 * write goes to a mkdtemp temp directory via the `DSH_HOME` env override,
 * and the directory is removed at the end however the run turns out.
 *
 * `decodeState` and `restorePlan` are pure, so the cases that matter most —
 * a file from another version, a half-written one, an id the session store no
 * longer holds — are exercised directly rather than through a terminal.
 *
 * Run with: node --experimental-strip-types tests/persist.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assembleState,
  decodeState,
  loadState,
  MAX_RESTORED_SESSIONS,
  restorePlan,
  saveState,
  saveStateSync,
  scratchPath,
  statePath,
  type PersistedSession,
  type PersistedState,
} from '../src/persist.ts'
import type { TokenBuckets } from '../src/usage.ts'

/** The current on-disk version, as the writer stamps it. */
const VERSION = 5

/** A bucket set, spelled positionally so a fixture row stays readable. */
function buckets(uncached: number, output: number, cacheRead = 0, cacheWrite = 0): TokenBuckets {
  return {
    uncachedInputTokens: uncached,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

/** A state with only the fields a case cares about spelled out. */
function state(partial: Partial<PersistedState> = {}): PersistedState {
  return {
    inputHistory: [],
    thinking: false,
    peers: [],
    sessions: [],
    activeSession: 0,
    usage: {},
    usageEntries: [],
    ...partial,
  }
}

/** A remembered session, defaulting the fields a case is not about. */
function session(id: string, model = 'model-a', title = ''): PersistedSession {
  return { id, model, title }
}

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

const sandbox = await mkdtemp(join(tmpdir(), 'moqi-persist-'))
const env = { DSH_HOME: sandbox }

try {
  // ----------------------------------------------------------- statePath

  check('statePath honors DSH_HOME', statePath(env) === join(sandbox, 'tui-state.json'))
  check(
    'statePath falls back to ~/.dsh when DSH_HOME is unset',
    statePath({}) === join(homedir(), '.dsh', 'tui-state.json'),
  )
  check(
    'statePath treats an empty DSH_HOME as unset',
    statePath({ DSH_HOME: '' }) === join(homedir(), '.dsh', 'tui-state.json'),
  )

  // ------------------------------------------------- load with no state

  const empty = await loadState(env)
  check('load returns the fallback when nothing is saved', empty.inputHistory.length === 0 && empty.thinking === false)

  // -------------------------------------------------------- round trip

  await saveState(state({ inputHistory: ['first prompt', 'second prompt'], thinking: true }), env)
  const restored = await loadState(env)
  check('save/load round-trips the history', restored.inputHistory.join(',') === 'first prompt,second prompt')
  check('save/load round-trips the thinking flag', restored.thinking === true)
  check('an unset tool view reads as the default (expanded)', restored.expandTools === undefined)
  await saveState(state({ expandTools: false }), env)
  check('save/load round-trips a collapsed tool view', (await loadState(env)).expandTools === false)
  const dirEntries = await readdir(sandbox)
  check('the atomic write leaves no temp file behind', !dirEntries.some((name) => name.endsWith('.tmp')))

  // ------------------------------------------ round trip: open sessions

  await saveState(
    state({
      sessions: [session('session-a', 'model-a', 'first'), session('session-b', 'model-b', 'second')],
      activeSession: 1,
    }),
    env,
  )
  const tabs = await loadState(env)
  check('save/load round-trips the session ids', tabs.sessions.map((s) => s.id).join(',') === 'session-a,session-b')
  check('save/load round-trips each session model', tabs.sessions.map((s) => s.model).join(',') === 'model-a,model-b')
  check('save/load round-trips each session title', tabs.sessions.map((s) => s.title).join(',') === 'first,second')
  check('save/load round-trips the active tab', tabs.activeSession === 1)
  check('a session with no theme saved round-trips to undefined', tabs.sessions[0]?.theme === undefined)

  // ---------------------------------------------- round trip: session theme

  await saveState(
    state({ sessions: [{ id: 'session-a', model: '', title: '', theme: 'gruvbox' }], activeSession: 0 }),
    env,
  )
  const withTheme = await loadState(env)
  check('save/load round-trips a session\'s own theme', withTheme.sessions[0]?.theme === 'gruvbox')

  const { writeFile: writeThemeFixture } = await import('node:fs/promises')
  await writeThemeFixture(
    statePath(env),
    JSON.stringify({
      ...state(),
      version: VERSION,
      sessions: [
        { id: 'session-a', theme: 'nord' },
        { id: 'session-b', theme: 42 },
      ],
    }),
    'utf8',
  )
  const mixedTheme = await loadState(env)
  check('a well-formed session theme survives', mixedTheme.sessions[0]?.theme === 'nord')
  check('a non-string session theme reads as undefined rather than throwing', mixedTheme.sessions[1]?.theme === undefined)
  check('the fallback carries no sessions', (await loadState({ DSH_HOME: join(sandbox, 'nothing') })).sessions.length === 0)
  check('the fallback carries no usage', (await loadState({ DSH_HOME: join(sandbox, 'nothing') })).usage['anthropic'] === undefined)

  // -------------------------------------------------- round trip: usage

  await saveState(
    state({ usage: { anthropic: { ...buckets(1200, 300, 40, 10), turns: 2 } } }),
    env,
  )
  const withUsage = await loadState(env)
  check('save/load round-trips a usage row', withUsage.usage['anthropic']?.uncachedInputTokens === 1200)
  check('save/load round-trips every bucket, not just the prompt side', withUsage.usage['anthropic']?.cacheReadTokens === 40)
  check('save/load round-trips the turn count', withUsage.usage['anthropic']?.turns === 2)

  const { writeFile: writeUsageFixture } = await import('node:fs/promises')
  await writeUsageFixture(
    statePath(env),
    JSON.stringify({
      ...state(),
      version: VERSION,
      usage: {
        anthropic: { ...buckets(10, 5), turns: 1 },
        broken: { ...buckets(10, 5), cacheReadTokens: 'nope', turns: 1 },
        partial: { uncachedInputTokens: 10, outputTokens: 5, turns: 1 },
        alsoBroken: 'not even an object',
      },
    }),
    'utf8',
  )
  const mixedUsage = await loadState(env)
  check('a well-formed usage row survives', mixedUsage.usage['anthropic']?.uncachedInputTokens === 10)
  check('a usage row with a non-numeric field is dropped', mixedUsage.usage['broken'] === undefined)
  check('a usage row missing a bucket entirely is dropped rather than read as zero', mixedUsage.usage['partial'] === undefined)
  check('a usage row that is not an object is dropped', mixedUsage.usage['alsoBroken'] === undefined)

  // ---------------------------------------------- round trip: usageEntries

  await saveState(
    state({ usageEntries: [{ provider: 'anthropic', ...buckets(100, 20, 5), at: 1_700_000_000_000 }] }),
    env,
  )
  const withEntries = await loadState(env)
  check('save/load round-trips a usage entry', withEntries.usageEntries[0]?.provider === 'anthropic')
  check('save/load round-trips an entry\'s timestamp', withEntries.usageEntries[0]?.at === 1_700_000_000_000)
  check('save/load round-trips an entry\'s cache buckets', withEntries.usageEntries[0]?.cacheReadTokens === 5)
  check('the fallback carries no usage entries', (await loadState({ DSH_HOME: join(sandbox, 'nothing') })).usageEntries.length === 0)

  await writeUsageFixture(
    statePath(env),
    JSON.stringify({
      ...state(),
      version: VERSION,
      usageEntries: [
        { provider: 'anthropic', ...buckets(10, 5), at: 1 },
        { provider: 'broken', ...buckets(10, 5), outputTokens: 'nope', at: 1 },
        { ...buckets(10, 5), at: 1 },
        { provider: 'noBuckets', at: 1 },
        'not even an object',
      ],
    }),
    'utf8',
  )
  const mixedEntries = await loadState(env)
  check('a well-formed usage entry survives', mixedEntries.usageEntries.length === 1)
  check('the surviving entry is the well-formed one', mixedEntries.usageEntries[0]?.provider === 'anthropic')

  // ------------------------------------------------- unreadable states

  const { writeFile } = await import('node:fs/promises')
  await writeFile(statePath(env), JSON.stringify({ version: 99, inputHistory: ['x'], thinking: true }), 'utf8')
  const future = await loadState(env)
  check('a future version is ignored', future.inputHistory.length === 0 && future.thinking === false)
  // The shape before sessions existed. It shares field names with the current
  // one, which is exactly why it must be discarded rather than half-adopted.
  await writeFile(
    statePath(env),
    JSON.stringify({ version: 1, inputHistory: ['old'], thinking: true, sessions: [{ id: 'session-a' }] }),
    'utf8',
  )
  const previous = await loadState(env)
  check(
    'the previous version degrades to the fallback',
    previous.inputHistory.length === 0 && previous.thinking === false && previous.sessions.length === 0,
  )
  await writeFile(statePath(env), '{not json at all', 'utf8')
  const corrupt = await loadState(env)
  check('corrupt json falls back', corrupt.inputHistory.length === 0 && corrupt.thinking === false)
  await writeFile(
    statePath(env),
    JSON.stringify({ version: VERSION, inputHistory: ['keep', 7, null, 'also keep'], thinking: undefined }),
    'utf8',
  )
  const cleaned = await loadState(env)
  check('non-string entries are dropped on load', cleaned.inputHistory.join(',') === 'keep,also keep')
  check('a missing thinking flag reads as false', cleaned.thinking === false)
  check('a missing sessions array reads as empty', cleaned.sessions.length === 0)
  await writeFile(statePath(env), JSON.stringify({ version: VERSION, thinking: true }), 'utf8')
  const noHistory = await loadState(env)
  check('a missing inputHistory reads as empty', noHistory.inputHistory.length === 0 && noHistory.thinking === true)

  // -------------------------------------------- partial session entries

  // Exactly what a truncated or hand-edited file looks like: some entries are
  // whole, some are junk, and none of it may throw on the way to a usable app.
  await writeFile(
    statePath(env),
    JSON.stringify({
      version: VERSION,
      sessions: [
        { id: 'session-a', model: 'model-a', title: 'kept' },
        { id: '', model: 'model-b' },
        { model: 'model-c', title: 'no id' },
        null,
        'session-d',
        42,
        { id: 'session-e', model: 7, title: null },
      ],
      activeSession: 4,
    }),
    'utf8',
  )
  const partial = await loadState(env)
  check('entries without a usable id are dropped', partial.sessions.map((s) => s.id).join(',') === 'session-a,session-e')
  check('a non-string model reads as empty', partial.sessions[1]?.model === '')
  check('a non-string title reads as empty', partial.sessions[1]?.title === '')
  check('an out-of-range active index reads as zero', partial.activeSession === 0)

  // decodeState is the same code path without the filesystem, so the shapes a
  // file cannot easily hold get checked directly.
  check('decode survives a bare array', decodeState('[]').sessions.length === 0)
  check('decode survives a JSON null', decodeState('null').sessions.length === 0)
  check('decode survives an empty string', decodeState('').activeSession === 0)
  check(
    'decode rejects a fractional active index',
    decodeState(JSON.stringify({ version: VERSION, sessions: [session('a')], activeSession: 0.5 })).activeSession === 0,
  )
  check(
    'decode rejects a negative active index',
    decodeState(JSON.stringify({ version: VERSION, sessions: [session('a')], activeSession: -1 })).activeSession === 0,
  )

  // ------------------------------------------------------- restore plan

  const three = state({
    sessions: [session('a'), session('b'), session('c')],
    activeSession: 2,
  })
  const all = restorePlan(three, () => true)
  check('every available session is planned', all.sessions.map((s) => s.id).join(',') === 'a,b,c')
  check('the active tab survives a full restore', all.active === 2)

  // The store can be pruned between runs, so a missing id is routine.
  const pruned = restorePlan(three, (id) => id !== 'b')
  check('an unknown session id is skipped', pruned.sessions.map((s) => s.id).join(',') === 'a,c')
  check('the active index follows its session, not its old position', pruned.active === 1)

  const lostActive = restorePlan(three, (id) => id !== 'c')
  check('a vanished active tab falls back to the first', lostActive.active === 0)
  check('the surviving tabs are still planned', lostActive.sessions.map((s) => s.id).join(',') === 'a,b')

  const none = restorePlan(three, () => false)
  check('nothing available plans nothing', none.sessions.length === 0 && none.active === 0)
  check('an empty state plans nothing', restorePlan(state(), () => true).sessions.length === 0)

  // A duplicated id would otherwise adopt the same conversation twice.
  const duplicated = state({ sessions: [session('a'), session('a'), session('b')], activeSession: 1 })
  check('a duplicated id is planned once', restorePlan(duplicated, () => true).sessions.length === 2)

  const many = state({
    sessions: Array.from({ length: MAX_RESTORED_SESSIONS + 5 }, (_, index) => session(`s${String(index)}`)),
    activeSession: MAX_RESTORED_SESSIONS + 2,
  })
  const capped = restorePlan(many, () => true)
  check('the plan is capped', capped.sessions.length === MAX_RESTORED_SESSIONS)
  check('an active tab beyond the cap falls back to the first', capped.active === 0)

  // ------------------------------------- save creates its own directory

  const nested = { DSH_HOME: join(sandbox, 'does', 'not', 'exist') }
  await saveState(state({ inputHistory: ['nested'], sessions: [session('session-n')] }), nested)
  const nestedRestored = await loadState(nested)
  check('saveState creates a missing DSH_HOME', nestedRestored.inputHistory.join(',') === 'nested')
  check('the nested write kept the sessions', nestedRestored.sessions[0]?.id === 'session-n')
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

// --------------------------------------------------------------- fleet peers

// Peers are remembered so the overview works without repeating --peer on every
// launch, which is the whole reason they became editable in the pane.
{
  const encoded = JSON.stringify({ ...state({ peers: ['host1', 'user@host2'] }), version: VERSION })
  const back = decodeState(encoded)
  check('peers round-trip', back.peers.join(',') === 'host1,user@host2')

  check('a file with no peers decodes to none', decodeState(
    JSON.stringify({ ...state(), version: VERSION }),
  ).peers.length === 0)

  // A hand-edited file should not be able to put a non-string on a command line.
  const dirty = JSON.stringify({
    ...state(),
    peers: ['ok', 42, null, { host: 'nope' }, 'also-ok'],
    version: VERSION,
  })
  check('non-string peers are dropped', decodeState(dirty).peers.join(',') === 'ok,also-ok')

  check('peers absent entirely is not fatal', decodeState(
    JSON.stringify({ inputHistory: [], thinking: false, sessions: [], activeSession: 0, version: VERSION }),
  ).peers.length === 0)
}

// ------------------------------------------------- concurrent saves are safe

// Several sessions of this app run at once, and when two saved at the same
// moment they wrote the same tui-state.json.tmp on top of each other and
// renamed the interleaved result into place. The file that came out was one
// complete document followed by a fragment of another, and every later read
// discarded it, silently losing the remembered sessions, peers and theme.
// Observed on a real machine, so it is pinned here.
{
  const home = mkdtempSync(join(tmpdir(), 'dsh-persist-race-'))
  const env = { DSH_HOME: home } as NodeJS.ProcessEnv

  saveStateSync(state({ peers: ['one'] }), env)
  const written = readFileSync(statePath(env), 'utf8')
  check('a save leaves parseable JSON', decodeState(written).peers.join(',') === 'one')

  check('the rename leaves no scratch file behind', readdirSync(home).every((n) => !n.endsWith('.tmp')))

  // The property that actually prevents the corruption: the scratch path is
  // this process's alone. The old code used `${target}.tmp` for everybody,
  // which is what let two writers land in the same file. Asserting on the
  // directory after a save cannot see this -- the rename removes the evidence
  // either way -- so assert on the path itself.
  const scratch = scratchPath(statePath(env))
  check('the scratch path is not the bare .tmp every process would share', scratch !== `${statePath(env)}.tmp`)
  check('the scratch path carries this process id', scratch.includes(String(process.pid)))
  check('the scratch path still sits beside the target', scratch.startsWith(statePath(env)))

  // Whatever a second writer leaves lying around must not affect a read.
  writeFileSync(join(home, 'tui-state.json.99999.tmp'), 'half a document {', 'utf8')
  check('a foreign scratch file is ignored', decodeState(readFileSync(statePath(env), 'utf8')).peers.join(',') === 'one')

  // And the shape the bug produced must still decode to the fallback rather
  // than throwing, which is what kept the app usable while this went unnoticed.
  const doubled = `${written}${written}`
  check('a doubled document degrades to the fallback', decodeState(doubled).sessions.length === 0)

  rmSync(home, { recursive: true, force: true })
}

// eslint-disable-next-line no-console

// ------------------------------------------------- language & setup flag

// `lang` was written on every save but never read back, quietly resetting the
// interface to English on every restart; `setupDone` keeps the first-run list
// from nagging. Both must survive a save/decode round trip.
{
  const blank: PersistedState = {
    inputHistory: [],
    thinking: false,
    peers: [],
    sessions: [],
    activeSession: 0,
    usage: {},
    usageEntries: [],
  }
  // Assemble the way the app does, rather than hand-building the object:
  // the fields were being dropped by the app's own assembly, which a test
  // that constructs its own input could never have caught.
  const chosen = assembleState({
    inputHistory: [],
    thinking: false,
    theme: 'moqi',
    lang: 'zh-CN',
    setupDone: true,
    expandTools: undefined,
    stackView: true,
    peers: [],
    sessions: [],
    activeSession: 0,
    usage: {},
    usageEntries: [],
  })
  const restored = decodeState(JSON.stringify({ ...chosen, version: VERSION }))
  check('the language survives a round trip', restored.lang === 'zh-CN')
  check('the setup-done flag survives a round trip', restored.setupDone === true)
  check('the stacked-view choice survives a round trip', restored.stackView === true)
  const fresh = decodeState(JSON.stringify({ ...blank, version: VERSION }))
  check('neither field appears when never set', fresh.lang === undefined && fresh.setupDone === undefined)
}

console.log(`ok - ${String(checks)} checks passed`)
