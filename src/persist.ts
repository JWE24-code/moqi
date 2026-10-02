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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { ProviderUsage, TokenBuckets, UsageEntry, UsageLedger } from './usage.ts'

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
  id: string
  /** Label of the model that session was using; empty means "use the default". */
  model: string
  /** The tab's title, normally the opening prompt; empty until one is sent. */
  title: string
  /** Color palette that session was using; absent means "use the default". */
  theme?: string
}

/** What survives a restart of the app. */
export interface PersistedState {
  /** Previously sent prompts, oldest first, for composer recall. */
  inputHistory: string[]
  /** Whether reasoning output was visible when the app last ran. */
  thinking: boolean
  /** Name of the chosen color palette; absent means the app's default. */
  theme?: string
  /** Interface language: `en` or `zh-CN`. */
  lang?: string
  /** Whether the first-run setup list has been seen; it returns until it has. */
  setupDone?: boolean
  /**
   * Whether tool calls were listed rather than summarized when the app last
   * ran; absent means the default, which is to list them.
   */
  expandTools?: boolean
  /**
   * Whether the stacked view was open when the app last ran; absent means the
   * default. The profile's `view` config only fills a first run — the last
   * view you switched to wins.
   */
  stackView?: boolean
  /** Devices to include in the fleet overview, as `ssh` destinations. */
  peers: string[]
  /** Sessions that were open at the last exit, in tab order. */
  sessions: PersistedSession[]
  /** Index into {@link PersistedState.sessions} of the tab that was on screen. */
  activeSession: number
  /** Per-provider token usage, accumulated across every session so far. */
  usage: UsageLedger
  /**
   * The rolling-window log `/usage`'s session (5h) and week (7d) views are
   * computed from — bounded to the last 7 days, unlike `usage` itself, which
   * never forgets.
   */
  usageEntries: UsageEntry[]
}

/**
 * Version of the on-disk shape, so a future change can migrate or discard.
 *
 * Bumped to 5 when the usage ledger moved from a two-number `promptTokens`/
 * `completionTokens` pair to the provider's own four billed buckets. The old
 * numbers are not convertible: they were differences between context sizes, not
 * billed totals, so they are discarded rather than carried forward under names
 * that would imply they had ever been right.
 */
const STATE_VERSION = 5

/**
 * How many sessions a single restore will bring back.
 *
 * Every restored tab costs one session-store lookup and one agent adoption,
 * both of them I/O before the first paint. A state file that has grown a long
 * tail — or been hand-edited — must not turn a launch into a multi-second
 * stall, and nobody navigates more tabs than this by hand anyway.
 */
export const MAX_RESTORED_SESSIONS = 16

type OnDisk = PersistedState & { version?: number }

/** The state used when there is nothing readable on disk. */
function fallbackState(): PersistedState {
  return { inputHistory: [], thinking: false, peers: [], sessions: [], activeSession: 0, usage: {}, usageEntries: [] }
}

/** A finite number at `key`, or undefined when it is missing or another type. */
function finite(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Coerce the four billed buckets, or reject the row outright.
 *
 * All four must be present and finite. A row missing one is a row whose total
 * would silently understate the spend it claims to record, which is worse than
 * no row at all.
 */
function readBuckets(record: Record<string, unknown>): TokenBuckets | undefined {
  const uncachedInputTokens = finite(record, 'uncachedInputTokens')
  const outputTokens = finite(record, 'outputTokens')
  const cacheReadTokens = finite(record, 'cacheReadTokens')
  const cacheWriteTokens = finite(record, 'cacheWriteTokens')
  if (
    uncachedInputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return undefined
  }
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

/** Coerce one on-disk usage row, or reject it outright. */
function readUsageRow(value: unknown): ProviderUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const buckets = readBuckets(record)
  const turns = finite(record, 'turns')
  if (buckets === undefined || turns === undefined) return undefined
  return { ...buckets, turns }
}

/** Coerce the on-disk usage ledger, dropping any row that does not parse. */
function readUsage(value: unknown): UsageLedger {
  if (typeof value !== 'object' || value === null) return {}
  const ledger: UsageLedger = {}
  for (const [provider, entry] of Object.entries(value as Record<string, unknown>)) {
    const row = readUsageRow(entry)
    if (row !== undefined) ledger[provider] = row
  }
  return ledger
}

/** Coerce one on-disk rolling-window entry, or reject it outright. */
function readUsageEntry(value: unknown): UsageEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const provider = record['provider']
  const buckets = readBuckets(record)
  const at = finite(record, 'at')
  if (typeof provider !== 'string' || provider === '' || buckets === undefined || at === undefined) {
    return undefined
  }
  return { provider, ...buckets, at }
}

/** Coerce the on-disk rolling-window log, dropping any entry that does not parse. */
function readUsageEntries(value: unknown): UsageEntry[] {
  if (!Array.isArray(value)) return []
  const entries: UsageEntry[] = []
  for (const item of value) {
    const entry = readUsageEntry(item)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

/** Where the state file lives: `$DSH_HOME/tui-state.json`, default `~/.dsh`. */
export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['DSH_HOME'] !== undefined && env['DSH_HOME'] !== ''
    ? env['DSH_HOME']
    : join(homedir(), '.dsh')
  return join(home, 'tui-state.json')
}

/** Coerce one on-disk session entry, or reject it outright. */
function readSession(value: unknown): PersistedSession | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const id = record['id']
  // Without an id there is nothing to re-adopt, so the entry is worthless.
  if (typeof id !== 'string' || id === '') return undefined
  return {
    id,
    model: typeof record['model'] === 'string' ? record['model'] : '',
    title: typeof record['title'] === 'string' ? record['title'] : '',
    theme: typeof record['theme'] === 'string' ? record['theme'] : undefined,
  }
}

/**
 * Turn the raw file contents into state, without touching the filesystem.
 *
 * Parsing is separated from reading so the whole degrade-gracefully contract
 * — bad JSON, a version from another release, a half-written array of
 * sessions — can be exercised as a pure function. It never throws: an input
 * it cannot make sense of yields the fallback, which is always usable.
 */
export function decodeState(raw: string): PersistedState {
  let parsed: OnDisk
  try {
    parsed = JSON.parse(raw) as OnDisk
  } catch {
    return fallbackState()
  }
  if (typeof parsed !== 'object' || parsed === null) return fallbackState()
  // An entry from a different version is discarded rather than guessed at:
  // the fields it does share may well have meant something else.
  if (parsed.version !== STATE_VERSION) return fallbackState()
  return adoptState(parsed)
}

/** Trust the envelope: turn an on-disk record into usable state. */
function adoptState(parsed: OnDisk): PersistedState {
  const sessions = readSessions(parsed.sessions)
  // A malformed index would otherwise select a tab that is not there.
  const rawActive = parsed.activeSession
  const activeSession =
    typeof rawActive === 'number' && Number.isInteger(rawActive) && rawActive >= 0 && rawActive < sessions.length
      ? rawActive
      : 0

  return {
    inputHistory: stringsOf(parsed.inputHistory),
    thinking: parsed.thinking === true,
    peers: stringsOf(parsed.peers),
    theme: typeof parsed.theme === 'string' ? parsed.theme : undefined,
    // `lang` is written on every save but was never read back here, which
    // quietly reset the interface to English on every restart — the choice
    // only lasted as long as the process did.
    lang: typeof parsed.lang === 'string' ? parsed.lang : undefined,
    setupDone: parsed.setupDone === true ? true : undefined,
    // Either explicit choice round-trips. The tool view used to store only the
    // non-default side, which was harmless while the default was "expanded" —
    // flipping the default would have silently dropped a chosen expansion.
    expandTools: typeof parsed.expandTools === 'boolean' ? parsed.expandTools : undefined,
    stackView: parsed.stackView === true ? true : undefined,
    sessions,
    activeSession,
    usage: readUsage(parsed.usage),
    usageEntries: readUsageEntries(parsed.usageEntries),
  }
}

/** The sessions on disk that still make sense, in order. */
function readSessions(entries: unknown): PersistedSession[] {
  if (!Array.isArray(entries)) return []
  const sessions: PersistedSession[] = []
  for (const entry of entries) {
    const session = readSession(entry)
    if (session !== undefined) sessions.push(session)
  }
  return sessions
}

/** The string entries of a stored list; anything else is dropped. */
function stringsOf(entries: unknown): string[] {
  return Array.isArray(entries)
    ? entries.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/**
 * Assemble the state to write, from the live values the app holds.
 *
 * The field list lives here rather than inline in the app because listing it
 * by hand is exactly how fields get lost: `persistNow` used to rebuild the
 * object itself, and every field it forgot — `lang` and `setupDone` were both
 * dropped this way — was written as absent on every save no matter what the
 * app had set. One list, in one place, exercised by a test.
 */
export function assembleState(input: {
  inputHistory: string[]
  thinking: boolean
  theme: string
  lang: string
  setupDone: boolean | undefined
  expandTools: boolean | undefined
  stackView: boolean | undefined
  peers: string[]
  sessions: PersistedSession[]
  activeSession: number
  usage: UsageLedger
  usageEntries: UsageEntry[]
}): PersistedState {
  return {
    inputHistory: input.inputHistory,
    thinking: input.thinking,
    theme: input.theme,
    lang: input.lang,
    setupDone: input.setupDone,
    expandTools: input.expandTools,
    stackView: input.stackView,
    peers: input.peers,
    sessions: input.sessions,
    activeSession: input.activeSession,
    usage: input.usage,
    usageEntries: input.usageEntries,
  }
}

/**
 * Read the persisted state, returning the fallback when there is none or it
 * cannot be understood.
 */
export async function loadState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PersistedState> {
  let raw: string
  try {
    raw = await readFile(statePath(env), 'utf8')
  } catch {
    return fallbackState()
  }
  return decodeState(raw)
}

/** The sessions to bring back, and which of them to put on screen. */
export interface RestorePlan {
  /** Sessions worth adopting, in tab order; may be empty. */
  sessions: PersistedSession[]
  /** Index into {@link RestorePlan.sessions} to make active. */
  active: number
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
export function restorePlan(
  state: PersistedState,
  isAvailable: (id: string) => boolean,
): RestorePlan {
  const seen = new Set<string>()
  const sessions: PersistedSession[] = []
  // The id the user was last looking at, so the active tab survives the gaps
  // left by sessions that no longer exist.
  const wanted = state.sessions[state.activeSession]?.id
  for (const session of state.sessions) {
    if (seen.has(session.id)) continue
    if (!isAvailable(session.id)) continue
    seen.add(session.id)
    sessions.push(session)
    if (sessions.length >= MAX_RESTORED_SESSIONS) break
  }
  const found = sessions.findIndex((session) => session.id === wanted)
  return { sessions, active: found === -1 ? 0 : found }
}

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
export function scratchPath(target: string): string {
  return `${target}.${String(process.pid)}.tmp`
}

/**
 * Write the state atomically: a temporary file in the same directory, then a
 * rename, so a crash mid-write can never leave a half-written JSON behind.
 */
export async function saveState(
  state: PersistedState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const target = statePath(env)
  const temporary = scratchPath(target)
  const payload = JSON.stringify({ ...state, version: STATE_VERSION })
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(temporary, payload, 'utf8')
    await rename(temporary, target)
  } catch {
    // A read-only home or a missing directory is a valid environment.
  }
}

/**
 * The synchronous twin of {@link saveState}, for the teardown path: `quit()`
 * asks the launcher to exit immediately, so an in-flight async write would be
 * cut off and the last prompt lost.
 */
export function saveStateSync(state: PersistedState, env: NodeJS.ProcessEnv = process.env): void {
  const target = statePath(env)
  const temporary = scratchPath(target)
  const payload = JSON.stringify({ ...state, version: STATE_VERSION })
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(temporary, payload, 'utf8')
    renameSync(temporary, target)
  } catch {
    // A read-only home or a missing directory is a valid environment.
  }
}
