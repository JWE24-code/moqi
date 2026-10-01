/**
 * Smoke tests for cross-session search: a temporary session store is written
 * in both log forms and searched.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { projectKey, encodeSegment } from '../src/sessions-store.ts'
import {
  decodeLogBytes,
  isZstdFrame,
  parseLogMessages,
  searchSessions,
  zstdAvailable,
} from '../src/cross-find.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

const root = mkdtempSync(join(tmpdir(), 'dsh-find-'))
const cwd = '/home/someone/project'
const project = projectKey(cwd)

function record(type: string, text: string): string {
  return JSON.stringify({
    type,
    data: { message: { content: [{ type: 'text', text }] } },
  })
}

function writeSession(store: string, id: string, lines: string[], zstd: boolean): string {
  const dir = join(store, project, encodeSegment(id))
  mkdirSync(dir, { recursive: true })
  const body = `${lines.join('\n')}\n`
  const path = join(dir, zstd ? 'session.v3.jsonl.zstd' : 'session.v3.jsonl')
  writeFileSync(path, zstd ? zstdCompressSync(Buffer.from(body, 'utf8')) : body)
  return dir
}

writeSession(root, 'session-aaa', [record('turn/start', ''), record('user/message', 'how do I tail a container log')], false)
writeSession(
  root,
  'session-bbb',
  [record('user/message', 'unrelated'), record('assistant/message', 'the container log needs --tail')],
  false,
)
writeSession(root, 'session-ccc', [record('user/message', 'compressed needle about containers')], true)
// A log with no matching text, to prove false positives do not appear.
writeSession(root, 'session-ddd', [record('user/message', 'nothing to see')], false)
// A stray file that is not a session directory.
mkdirSync(join(root, project, 'session.lock'), { recursive: true })

const result = searchSessions(root, 'container')
check('matching lines are found', result.hits.length === 3)
check('searches report how many logs they read', result.scanned === 4)
check('the human prompt is attributed to the user', result.hits.some((hit) => hit.role === 'user'))
check('the model line is attributed to the assistant', result.hits.some((hit) => hit.role === 'assistant'))
check('the project is carried for orientation', result.hits.every((hit) => hit.project.includes('project')))
check('the session id is carried', result.hits.some((hit) => hit.sessionId === 'session-bbb'))
check('the log path is carried', result.hits.every((hit) => hit.path.endsWith('.jsonl') || hit.path.endsWith('.zstd')))
if (zstdAvailable()) {
  check(
    'a compressed log is searched when Node can decode it',
    result.hits.some((hit) => hit.sessionId === 'session-ccc'),
  )
} else {
  check('a compressed log is reported as skipped when it cannot', result.skippedCompressed >= 1)
}

const none = searchSessions(root, 'wombat')
check('no matches means no hits', none.hits.length === 0)
check('an empty query searches nothing', searchSessions(root, '   ').hits.length === 0)
const limited = searchSessions(root, 'the', { maxSessions: 100, maxHits: 1, maxBytes: 4_000_000 })
check('the hit cap is respected', limited.hits.length === 1)
const bySession = searchSessions(root, 'tail')
check('a rarer word still matches', bySession.hits.length === 2)
check('the matched text is present in the snippet', bySession.hits.every((hit) => hit.line.includes('tail')))

// ------------------------------------------------------------ read limits
//
// The byte cap is what keeps a search bounded. These checks pin what a cap
// actually does before the decode path is consolidated, so the consolidation
// is provably behaviour-preserving. They use their own stores, so they cannot
// disturb the counts above.

// A plain log is cut at maxBytes: text before the cut is searchable, text
// after it is not. The first record is ~92 bytes, so a 100-byte cap splits
// the body with margin on both sides.
const cutStore = mkdtempSync(join(tmpdir(), 'dsh-limits-'))
writeSession(cutStore, 'session-cut', [
  record('user/message', 'early-needle'),
  'x'.repeat(500),
  record('user/message', 'late-needle'),
], false)
check(
  'text before the byte cut is found',
  searchSessions(cutStore, 'early-needle', { maxSessions: 10, maxHits: 10, maxBytes: 100 }).hits.length === 1,
)
check(
  'text after the byte cut is not found',
  searchSessions(cutStore, 'late-needle', { maxSessions: 10, maxHits: 10, maxBytes: 100 }).hits.length === 0,
)
rmSync(cutStore, { recursive: true, force: true })

// One store with a matching plain log, a non-matching plain log, and a
// compressed log, so scan and skip counts have something real to count.
const capStore = mkdtempSync(join(tmpdir(), 'dsh-limits-'))
writeSession(capStore, 'session-plain-hit', [record('user/message', 'the countme line')], false)
writeSession(capStore, 'session-plain-miss', [record('user/message', 'nothing here')], false)
writeSession(capStore, 'session-zstd', [record('user/message', 'a compressed log body')], true)

const generous = searchSessions(capStore, 'countme', { maxSessions: 10, maxHits: 10, maxBytes: 4_000_000 })
check('a generous cap finds the hit', generous.hits.length === 1)
if (zstdAvailable()) {
  check('every readable log counts as scanned', generous.scanned === 3)
  check('a readable compressed log is not counted as skipped', generous.skippedCompressed === 0)
} else {
  check('an undecodable compressed log is counted as skipped', generous.scanned === 2 && generous.skippedCompressed === 1)
}

// A 5-byte cap truncates both plain logs into unparseable prefixes and skips
// the compressed log for being over the cap — and that over-cap skip is
// silent: only an *undecodable* compressed log increments skippedCompressed.
if (zstdAvailable()) {
  const capped = searchSessions(capStore, 'countme', { maxSessions: 10, maxHits: 10, maxBytes: 5 })
  check('a byte cap that truncates plain logs finds nothing', capped.hits.length === 0)
  check('truncated logs still count as scanned', capped.scanned === 2)
  check('a compressed log over the cap is skipped silently', capped.skippedCompressed === 0)
}
rmSync(capStore, { recursive: true, force: true })

// ------------------------------------------------- parsing and decoding

const parsed = parseLogMessages(
  [
    record('turn/start', 'ignored'),
    record('user/message', 'hello there'),
    record('assistant/message', 'hi back'),
    'not json',
    record('tool/result', 'ignored too'),
  ].join('\n'),
)
check('only message records parse', parsed.length === 2)
check('roles are attributed', parsed[0]?.role === 'user' && parsed[1]?.role === 'assistant')
check('text is preserved', parsed[0]?.text === 'hello there')
check('an empty body parses to nothing', parseLogMessages('').length === 0)

const plainBytes = new TextEncoder().encode(record('user/message', 'plain log'))
check('a plain log is not zstd', !isZstdFrame(plainBytes))
check('a plain log decodes as-is', decodeLogBytes(plainBytes)?.includes('plain log') === true)
const framed = new Uint8Array(zstdCompressSync(Buffer.from(record('user/message', 'compressed log'), 'utf8')))
check('a compressed log is recognised by its magic', isZstdFrame(framed))
if (zstdAvailable()) {
  check('a compressed log decodes', decodeLogBytes(framed)?.includes('compressed log') === true)
}
check('garbage bytes do not decode to text', decodeLogBytes(new Uint8Array([])) === '')

rmSync(root, { recursive: true, force: true })

console.log(`ok - ${String(checks)} cross-session checks passed`)
