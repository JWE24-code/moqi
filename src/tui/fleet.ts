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

import { displayWidth, padEnd, truncate } from './text.ts'
import {
  colGold,
  colGreen,
  colMuted,
  colText,
  muted,
  ok,
  selected,
  style,
  warn,
} from './theme.ts'

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
  v: number
  /** Device name, as the overview labels it. */
  host: string
  /** Process that owns the session, for diagnosis only. */
  pid: number
  sessionId: string
  title: string
  status: PresenceStatus
  /** Model the session is using, when known. */
  model?: string
  /** Working directory the session was created in. */
  cwd?: string
  /** Epoch millis of the last heartbeat. */
  updatedAt: number
}

/**
 * What a session is doing, as a device reports it.
 *
 * Deliberately declared here rather than imported from the session state: the
 * overview's wire format must not move when the local UI's types do, and it
 * keeps this module dependency-free apart from rendering helpers.
 */
export type PresenceStatus = 'idle' | 'running' | 'ready'

/** The record version this build writes and accepts. */
export const PRESENCE_VERSION = 1

/**
 * How long a record may go unrefreshed before its device is presumed gone.
 *
 * Generous relative to the heartbeat: a laptop that sleeps mid-turn should
 * read as `stale` rather than flapping, and a slow SSH round trip must not
 * make a healthy device look dead.
 */
export const DEFAULT_STALE_AFTER_MS = 30_000

/** A session's state in the overview, including the one presence cannot claim. */
export type FleetStatus = PresenceStatus | 'stale'

/** One row of the overview. */
export interface FleetSession {
  host: string
  sessionId: string
  title: string
  status: FleetStatus
  model?: string
  cwd?: string
  updatedAt: number
  /** True when this row is the device the overview is running on. */
  local: boolean
  /** Seconds since the last heartbeat, for display. */
  ageSeconds: number
}

/** What a device's collector returned, including the failure case. */
export interface FleetSource {
  host: string
  local: boolean
  /** Records read from the device, or an empty list when it could not be read. */
  records: readonly PresenceRecord[]
  /** Set when the device could not be reached or read. */
  error?: string
}

/** Rank for sorting: what is running matters most, what is gone matters least. */
const STATUS_RANK: Record<FleetStatus, number> = {
  running: 0,
  ready: 1,
  idle: 2,
  stale: 3,
}

/** Whether a record is well-formed enough to display. */
export function isPresenceRecord(value: unknown): value is PresenceRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Partial<PresenceRecord>
  return (
    record.v === PRESENCE_VERSION &&
    typeof record.host === 'string' &&
    record.host !== '' &&
    typeof record.sessionId === 'string' &&
    record.sessionId !== '' &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt) &&
    (record.status === 'running' || record.status === 'ready' || record.status === 'idle')
  )
}

/**
 * Merge every device's records into one ordered list.
 *
 * A record older than `staleAfterMs` is reported `stale` whatever it claimed:
 * a device that stopped heartbeating mid-turn would otherwise sit in the
 * overview claiming to be running forever.
 */
export function mergeFleet(
  sources: readonly FleetSource[],
  now: number,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): FleetSession[] {
  const rows: FleetSession[] = []
  const seen = new Set<string>()

  for (const source of sources) {
    for (const record of source.records) {
      if (!isPresenceRecord(record)) continue
      // One session is owned by one device; a duplicate id is a stale copy.
      const key = `${record.host}\u0000${record.sessionId}`
      if (seen.has(key)) continue
      seen.add(key)

      const age = Math.max(now - record.updatedAt, 0)
      rows.push({
        host: record.host,
        sessionId: record.sessionId,
        title: record.title,
        status: age > staleAfterMs ? 'stale' : record.status,
        model: record.model,
        cwd: record.cwd,
        updatedAt: record.updatedAt,
        local: source.local,
        ageSeconds: Math.floor(age / 1000),
      })
    }
  }

  // Grouped by device, because "which machine is this on" is the question the
  // overview exists to answer, and the renderer prints a heading per device.
  // Inside a device the most urgent comes first. The global "what needs me"
  // question is answered by fleetSummary, not by interleaving hosts here.
  rows.sort((left, right) => {
    if (left.local !== right.local) return left.local ? -1 : 1
    const byHost = left.host.localeCompare(right.host)
    if (byHost !== 0) return byHost
    const byStatus = (STATUS_RANK[left.status] ?? 9) - (STATUS_RANK[right.status] ?? 9)
    if (byStatus !== 0) return byStatus
    return right.updatedAt - left.updatedAt
  })
  return rows
}

/** A compact age: 8s, 4m, 2h, 3d. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h`
  return `${String(Math.floor(seconds / 86_400))}d`
}

/** The status mark, matching the marks the session bar already uses. */
function statusMark(status: FleetStatus, spinner: string): string {
  switch (status) {
    case 'running':
      return style(spinner, { fg: colGreen })
    case 'ready':
      return style('●', { fg: colGold })
    case 'idle':
      return muted('·')
    case 'stale':
      return muted('✗')
  }
}

/**
 * The command that opens a session on the device that owns it.
 *
 * A remote session is reached the same way the device itself is: over SSH,
 * with a TTY, resuming by id. Nothing new is exposed to do it.
 */
export function jumpCommand(session: FleetSession, profile = 'tui'): string {
  const resume = `dsh --profile ${profile} --resume ${session.sessionId}`
  return session.local ? resume : `ssh -t ${session.host} '${resume}'`
}

/**
 * The argv to actually run {@link jumpCommand}'s remote half, for spawning
 * directly rather than copying to a clipboard.
 *
 * The session id is quoted for the remote shell the same way a dispatched
 * prompt is: a presence record names the id, and a presence record can come
 * from a compromised or merely buggy peer, so nothing here trusts it to be
 * shell-safe on its own.
 */
export function jumpArgv(session: FleetSession, profile = 'tui'): string[] {
  return ['-t', session.host, `dsh --profile ${profile} --resume ${shellQuote(session.sessionId)}`]
}

/**
 * Quote one argument for a POSIX shell.
 *
 * A prompt is arbitrary text and is about to travel through `ssh`, which hands
 * it to the remote shell — so it is single-quoted with the one escape a single
 * quoted string has. Nothing here trusts the caller.
 */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", String.raw`'\''`)}'`
}

/**
 * The argv for dispatching a task to a peer's headless profile.
 *
 * The prompt is quoted for the remote shell; the profile name and host are
 * passed as separate argv words so the local shell never interprets them.
 */
export function dispatchArgv(host: string, profile: string, prompt: string): string[] {
  return ['-o', 'BatchMode=yes', host, `dsh --profile ${profile} ${shellQuote(prompt)}`]
}

/** Options for {@link renderFleet}. */
export interface FleetRenderOptions {
  width: number
  /** Index of the highlighted row, or -1 for none. */
  selectedIndex?: number
  spinner?: string
  /** Devices that could not be read, reported under the list. */
  sources?: readonly FleetSource[]
}

/**
 * Render the overview to styled lines.
 *
 * Grouped by device, because "which machine is this on" is the question the
 * overview exists to answer; an unreachable device is named rather than
 * silently contributing nothing.
 */
export function renderFleet(
  sessions: readonly FleetSession[],
  options: FleetRenderOptions,
): string[] {
  const width = Math.max(options.width, 20)
  // Not the same glyph as `ready`: a caller that forgets to pass an animation
  // frame must not make a running session look like a finished one.
  const spinner = options.spinner ?? '⠋'
  const selectedIndex = options.selectedIndex ?? -1
  const out: string[] = []

  if (sessions.length === 0) {
    out.push(muted('  no sessions on any device'))
  }

  let host = ''
  sessions.forEach((session, index) => {
    if (session.host !== host) {
      host = session.host
      if (out.length > 0) out.push('')
      const label = session.local ? `${host}  (this device)` : host
      out.push(style(label, { fg: colText, bold: true }))
    }

    const mark = statusMark(session.status, spinner)
    const age = muted(formatAge(session.ageSeconds))
    const model = session.model === undefined ? '' : muted(`  ${session.model}`)
    const title = session.title === '' ? 'new session' : session.title
    const head = ` ${mark} ${truncate(title, Math.max(width - 22, 8))}${model}`
    const pad = Math.max(width - displayWidth(head) - displayWidth(age) - 1, 1)
    const row = `${head}${' '.repeat(pad)}${age}`
    out.push(index === selectedIndex ? selected(padEnd(row, width)) : row)
  })

  for (const source of options.sources ?? []) {
    if (source.error === undefined) continue
    out.push(warn(`  ${source.host}: ${truncate(source.error, Math.max(width - 4, 8))}`))
  }

  return out
}

/** A one-line summary for the status bar: how much is running where. */
export function fleetSummary(sessions: readonly FleetSession[]): string {
  const running = sessions.filter((session) => session.status === 'running').length
  const ready = sessions.filter((session) => session.status === 'ready').length
  const hosts = new Set(sessions.map((session) => session.host)).size
  const parts: string[] = []
  if (running > 0) parts.push(`${String(running)} running`)
  if (ready > 0) parts.push(`${String(ready)} ready`)
  if (parts.length === 0) parts.push(`${String(sessions.length)} idle`)
  return `${parts.join(', ')} across ${String(hosts)} device${hosts === 1 ? '' : 's'}`
}

/** Colors re-exported so a caller can match the overview's palette. */
export const FLEET_COLORS = { colGreen, colGold, colMuted, colText, ok } as const

/**
 * Which rendered line carries row `index`.
 *
 * {@link renderFleet} inserts a heading per device and a blank line between
 * groups, so the selected row's index is not its line. The pane needs the
 * line to scroll, and duplicating the rule here rather than returning it from
 * the renderer keeps the renderer a plain function of its inputs. The two must
 * agree, which is what the smoke test pins.
 */
export function fleetLineOf(sessions: readonly FleetSession[], index: number): number {
  let line = 0
  let host = ''
  for (const [position, session] of sessions.entries()) {
    if (session.host !== host) {
      host = session.host
      // Mirrors renderFleet: a separator before every group but the first.
      if (line > 0) line += 1
      line += 1
    }
    if (position === index) return line
    line += 1
  }
  return 0
}

/**
 * Whether a string is safe and sensible to use as a peer.
 *
 * The value ends up on an `ssh` command line, so this is a gate rather than a
 * tidy-up: anything a shell would treat as more than one word, or that `ssh`
 * would read as an option, is refused outright instead of being escaped and
 * hoped for. What remains is the shape of a host, an alias, or `user@host`.
 */
export function isValidPeer(host: string): boolean {
  const trimmed = host.trim()
  if (trimmed === '' || trimmed.length > 255) return false
  // A leading dash would be parsed by ssh as a flag, not a destination.
  if (trimmed.startsWith('-')) return false
  return /^[A-Za-z0-9_.@:[\]-]+$/.test(trimmed)
}

/**
 * The overview's interaction state: what was collected, and where the cursor is.
 *
 * Kept beside the renderer because it is the same concern and equally pure —
 * it never reads a file or a socket. The app owns collection and hands the
 * result here.
 */
export class FleetView {
  open = false
  /** True while a collection round is in flight, so the pane can say so. */
  loading = false
  sessions: FleetSession[] = []
  sources: FleetSource[] = []
  selected = 0
  /**
   * Set while the pane is asking for a device to add.
   *
   * Adding a peer belongs here rather than only on the command line, because
   * the list is exactly where you notice a device is missing from it.
   */
  adding = false
  /** What has been typed into that prompt so far. */
  draft = ''

  show(): void {
    this.open = true
    this.loading = true
  }

  hide(): void {
    this.open = false
    this.loading = false
  }

  /**
   * Install a freshly collected round.
   *
   * The cursor follows the session it was on rather than the position it was
   * at: rows reorder as work starts and finishes, and a refresh that moved the
   * selection onto a different machine would be a way to open the wrong thing.
   */
  setResult(sessions: readonly FleetSession[], sources: readonly FleetSource[]): void {
    const anchor = this.current()?.sessionId
    this.loading = false
    this.sessions = [...sessions]
    this.sources = [...sources]
    if (anchor !== undefined) {
      const found = this.sessions.findIndex((session) => session.sessionId === anchor)
      this.selected = found === -1 ? 0 : found
    }
    this.clamp()
  }

  move(delta: number): void {
    if (this.sessions.length === 0) return
    this.selected += delta
    this.clamp()
  }

  current(): FleetSession | undefined {
    return this.sessions[this.selected]
  }

  /** Start asking for a device to add. */
  beginAdd(): void {
    this.adding = true
    this.draft = ''
  }

  /** Abandon the prompt, leaving the list as it was. */
  cancelAdd(): void {
    this.adding = false
    this.draft = ''
  }

  typeAdd(text: string): void {
    if (!this.adding) return
    this.draft += text
  }

  backspaceAdd(): void {
    if (!this.adding) return
    this.draft = this.draft.slice(0, -1)
  }

  /**
   * Finish the prompt, returning the host to add.
   *
   * A rejected name leaves the prompt open with the text intact, so a typo is
   * corrected rather than retyped.
   */
  commitAdd(): string | undefined {
    if (!this.adding) return undefined
    const host = this.draft.trim()
    if (!isValidPeer(host)) return undefined
    this.adding = false
    this.draft = ''
    return host
  }

  private clamp(): void {
    const last = this.sessions.length - 1
    this.selected = last < 0 ? 0 : Math.min(Math.max(this.selected, 0), last)
  }
}

/**
 * The fleet's device list. The peers given at launch and the ones adopted
 * while running are one list once the app is up; the app remembers it across
 * restarts by persisting what this list holds.
 */
export class PeerList {
  private hosts: string[]

  constructor(hosts: string[] = []) {
    this.hosts = hosts
  }

  all(): string[] {
    return this.hosts
  }

  has(host: string): boolean {
    return this.hosts.includes(host)
  }

  /** Replace the whole list (the launch path, merging config and persisted). */
  replaceAll(hosts: string[]): void {
    this.hosts = hosts
  }

  /** The list as fleet-source configs, ready for a collection round. */
  configs(): { host: string }[] {
    return this.hosts.map((host) => ({ host }))
  }

  /**
   * Adopt a device.
   *
   * Fails on an unusable host or one already present — the caller phrases the
   * difference, since one is a typo and the other is not an error at all.
   */
  add(host: string): { ok: true } | { ok: false; reason: 'invalid' | 'duplicate' } {
    const trimmed = host.trim()
    if (!isValidPeer(trimmed)) return { ok: false, reason: 'invalid' }
    if (this.has(trimmed)) return { ok: false, reason: 'duplicate' }
    this.hosts = [...this.hosts, trimmed]
    return { ok: true }
  }

  /** Forget a device. `false` when it was not in the fleet. */
  remove(host: string): boolean {
    if (!this.has(host)) return false
    this.hosts = this.hosts.filter((entry) => entry !== host)
    return true
  }
}
