/**
 * Cross-session search: `/find --sessions`.
 *
 * Stored sessions live under `$DSH_HOME/sessions/<projectKey>/<sessionId>/` as
 * either a plain `.jsonl` log or a zstd-compressed one. This module walks them,
 * reads whichever form it finds, and returns the matching lines with enough
 * context to recognize the conversation — no index, no cache, and nothing
 * written, so it can never corrupt a log another process is appending to.
 *
 * The zstd decoder is feature-detected: on a Node without it, compressed logs
 * are skipped and reported as such rather than silently ignored.
 * @module
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** One matching line in one stored session. */
export interface SessionHit {
  sessionId: string
  /** The project directory key, for orientation. */
  project: string
  /** The matched line, trimmed and truncated for a picker row. */
  line: string
  /** Whether the line came from the human or the model, when determinable. */
  role?: 'user' | 'assistant'
  /** Absolute path of the log the match came from. */
  path: string
}

/** Limits that keep a search from walking an unbounded store. */
export interface SearchLimits {
  /** Sessions scanned, newest-first by directory mtime. */
  maxSessions: number
  /** Hits returned overall. */
  maxHits: number
  /** Bytes of an uncompressed log read per session. */
  maxBytes: number
}

export const DEFAULT_LIMITS: SearchLimits = {
  maxSessions: 400,
  maxHits: 80,
  maxBytes: 4_000_000,
}

/** Whether this build of Node can decompress a zstd log. */
export function zstdAvailable(): boolean {
  return typeof zstdDecompressSync === 'function'
}

/** Extract printable message text from one JSONL record, or `''`. */
function textOfRecord(raw: string): { text: string; role?: 'user' | 'assistant' } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { text: '' }
  }
  const record = parsed as { type?: unknown; data?: { message?: { content?: unknown } } }
  const type = String(record.type ?? '')
  const role = type === 'user/message' ? 'user' : type === 'assistant/message' ? 'assistant' : undefined
  if (role === undefined) return { text: '' }
  const blocks = record.data?.message?.content
  if (!Array.isArray(blocks)) return { text: '' }
  const text = blocks
    .filter((block): block is { type: string; text: string } => {
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string'
    })
    .map((block) => block.text)
    .join(' ')
  return { text, role }
}

/** One readable message from a stored session log. */
export interface LogMessage {
  role: 'user' | 'assistant'
  text: string
}

/**
 * Parse a whole JSONL session body into its visible messages.
 *
 * Shared by cross-session search and the fleet preview, so both read a log the
 * same way — including a foreign device's log, which may be an older format
 * whose unknown records are simply skipped.
 */
export function parseLogMessages(body: string): LogMessage[] {
  const messages: LogMessage[] = []
  for (const raw of body.split('\n')) {
    if (!raw.includes('"')) continue
    const { text, role } = textOfRecord(raw)
    if (text === '' || role === undefined) continue
    messages.push({ role, text })
  }
  return messages
}

/** Whether a buffer carries the zstd frame magic. */
export function isZstdFrame(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd
}

/** Decode raw log bytes, whichever form they arrived in. */
export function decodeLogBytes(bytes: Uint8Array): string | undefined {
  if (!isZstdFrame(bytes)) return Buffer.from(bytes).toString('utf8')
  if (!zstdAvailable()) return undefined
  try {
    return zstdDecompressSync(bytes).toString('utf8')
  } catch {
    return undefined
  }
}

/** Read one log file, decompressing when it is zstd, bounded by `maxBytes`. */
function readLog(path: string, maxBytes: number): string | undefined {
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch {
    return undefined
  }
  // A compressed frame cannot be decoded from a prefix, so the whole file is
  // decoded — but a log beyond the byte ceiling is skipped rather than held
  // in memory twice. A plain log has no such constraint: it truncates.
  if (path.endsWith('.zstd') && raw.byteLength > maxBytes) return undefined
  return decodeLogBytes(raw.byteLength > maxBytes ? raw.subarray(0, maxBytes) : raw)
}

/** Session directories under the store root, most recently modified first. */
function sessionDirs(root: string): { project: string; dir: string; id: string; mtime: number }[] {
  const found: { project: string; dir: string; id: string; mtime: number }[] = []
  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return found
  }
  for (const project of projects) {
    const projectDir = join(root, project)
    let entries: string[]
    try {
      entries = readdirSync(projectDir)
    } catch {
      continue
    }
    for (const id of entries) {
      if (!id.startsWith('session-')) continue
      const dir = join(projectDir, id)
      try {
        if (!statSync(dir).isDirectory()) continue
        found.push({ project, dir, id, mtime: statSync(dir).mtimeMs })
      } catch {
        continue
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found
}

/** The log file inside a session directory, whichever format it is. */
function logFile(dir: string): string | undefined {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  const zstd = entries.find((name) => name.endsWith('.jsonl.zstd'))
  if (zstd !== undefined) return join(dir, zstd)
  const plain = entries.find((name) => name.endsWith('.jsonl'))
  return plain === undefined ? undefined : join(dir, plain)
}

/**
 * Search every stored session for a case-insensitive substring.
 *
 * @returns matching lines in session order (newest session first), capped by
 *   the limits. Skipped compressed logs on a Node without zstd mean fewer
 *   results, never wrong ones.
 */
export function searchSessions(
  root: string,
  query: string,
  limits: SearchLimits = DEFAULT_LIMITS,
): { hits: SessionHit[]; scanned: number; skippedCompressed: number } {
  const needle = query.trim().toLowerCase()
  if (needle === '') return { hits: [], scanned: 0, skippedCompressed: 0 }
  const hits: SessionHit[] = []
  let scanned = 0
  let skippedCompressed = 0
  for (const candidate of sessionDirs(root)) {
    if (scanned >= limits.maxSessions || hits.length >= limits.maxHits) break
    const found = searchableLog(candidate.dir, limits)
    if (found.skipped === true) skippedCompressed += 1
    if (found.path === undefined) continue
    scanned += 1
    searchLog(found.path, candidate, needle, limits, hits)
  }
  return { hits, scanned, skippedCompressed }
}

/** The one log file a session directory contributes, or why it contributes none. */
function searchableLog(dir: string, limits: SearchLimits): { path?: string; skipped?: boolean } {
  const path = logFile(dir)
  if (path === undefined) return {}
  if (path.endsWith('.zstd') && !zstdAvailable()) return { skipped: true }
  if (readLog(path, limits.maxBytes) === undefined) return {}
  return { path }
}

/** Scan one session log's lines into hit rows, up to the hit cap. */
function searchLog(
  path: string,
  candidate: { id: string; project: string },
  needle: string,
  limits: SearchLimits,
  hits: SessionHit[],
): void {
  const body = readLog(path, limits.maxBytes) ?? ''
  for (const raw of body.split('\n')) {
    if (hits.length >= limits.maxHits) break
    if (!raw.includes('"')) continue
    const { text, role } = textOfRecord(raw)
    if (text === '') continue
    const context = text.replace(/\s+/g, ' ').trim()
    const index = context.toLowerCase().indexOf(needle)
    if (index === -1) continue
    const at = Math.max(index - 30, 0)
    const snippet = context.slice(at, at + 140)
    hits.push({
      sessionId: candidate.id,
      project: candidate.project.replace(/^--|--$/g, ''),
      line: at > 0 ? `…${snippet}` : snippet,
      ...(role === undefined ? {} : { role }),
      path,
    })
  }
}
