/**
 * Publishing what this device is doing, for the fleet overview.
 *
 * Each open session gets one small JSON file under `$DSH_HOME/tui-presence`,
 * refreshed on a heartbeat and deleted on exit. The file's age is the liveness
 * signal — `session.lock` in the session store is not, because it is an empty
 * flock target that outlives the process that made it.
 *
 * Nothing here listens on a port. The records are ordinary files, read by
 * another device over SSH, so the fleet overview adds no network surface and
 * no credentials of its own.
 * @module
 */

import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'

import {
  isPresenceRecord,
  PRESENCE_VERSION,
  type PresenceRecord,
  type PresenceStatus,
} from './tui/fleet.ts'

/** Directory holding this device's presence records. */
export function presenceDir(dshHome: string): string {
  return join(dshHome, 'tui-presence')
}

/** What the app tells the publisher about one session. */
export interface PresenceInput {
  sessionId: string
  title: string
  status: PresenceStatus
  model?: string
  cwd?: string
}

/**
 * Writes and refreshes this device's presence records.
 *
 * The publisher is deliberately forgiving: a read-only or missing home must
 * degrade to publishing nothing, never to failing a turn. The overview is a
 * convenience, and a device that cannot publish simply does not appear.
 */
export class PresencePublisher {
  private readonly dir: string
  private readonly host: string
  private readonly owned = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private snapshot: readonly PresenceInput[] = []
  private disabled = false

  constructor(dshHome: string, host: string = hostname()) {
    this.dir = presenceDir(dshHome)
    this.host = host
  }

  /** Begin heartbeating. `intervalMs` must be well under the stale threshold. */
  start(intervalMs = 5000): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      this.publish(this.snapshot)
    }, intervalMs)
    // A heartbeat must not be the reason the process stays alive.
    this.timer.unref?.()
  }

  /** Publish the current set of sessions, replacing whatever was there. */
  publish(sessions: readonly PresenceInput[]): void {
    if (this.disabled) return
    this.snapshot = sessions
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    } catch {
      // A home that cannot be written is a device that does not appear.
      this.disabled = true
      return
    }

    const now = Date.now()
    const live = new Set<string>()
    for (const session of sessions) {
      const record: PresenceRecord = {
        v: PRESENCE_VERSION,
        host: this.host,
        pid: process.pid,
        sessionId: session.sessionId,
        title: session.title,
        status: session.status,
        model: session.model,
        cwd: session.cwd,
        updatedAt: now,
      }
      const path = join(this.dir, `${safeName(session.sessionId)}.json`)
      try {
        writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
        live.add(path)
        this.owned.add(path)
      } catch {
        // Skip this record; the rest of the fleet view still works.
      }
    }

    // Drop records for sessions this process has closed.
    for (const path of this.owned) {
      if (live.has(path)) continue
      this.owned.delete(path)
      try {
        rmSync(path, { force: true })
      } catch {
        // Best effort: a leftover record ages out as stale.
      }
    }
  }

  /** Remove every record this process published. Safe to call repeatedly. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    for (const path of this.owned) {
      try {
        rmSync(path, { force: true })
      } catch {
        // Nothing to do; the record ages out.
      }
    }
    this.owned.clear()
  }
}

/** Read every presence record in a directory, skipping anything malformed. */
export function readPresenceDir(dir: string): PresenceRecord[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const records: PresenceRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (isPresenceRecord(parsed)) records.push(parsed)
    } catch {
      // A half-written or foreign file is not a reason to lose the rest.
    }
  }
  return records
}

/** Keep a session id usable as a filename. */
function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}
