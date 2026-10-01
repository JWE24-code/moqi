/**
 * Session-store smoke: the path encoding and deletion behind `/delete`.
 *
 * The encoding rules are the security boundary — a session id must never
 * traverse out of the store — so they are asserted directly. The fs round trip
 * runs against a mkdtemp directory via the `DSH_HOME` env override and is
 * removed however the run turns out.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  deleteStoredSession,
  encodeSegment,
  findStoredSessionDir,
  projectKey,
  sessionsRoot,
  storedSessionDir,
} from '../src/sessions-store.ts'

let checks = 0
function check(name: string, condition: boolean): void {
  checks += 1
  assert.ok(condition, name)
}

function throws(action: () => unknown): boolean {
  try {
    action()
    return false
  } catch {
    return true
  }
}

// ------------------------------------------------------------ encodeSegment

check('a safe id passes through', encodeSegment('session-abc123') === 'session-abc123')
check('a dot is escaped', encodeSegment('.') === '~002E')
check('dot-dot is escaped', encodeSegment('..') === '~002E~002E')
check('a path separator is escaped', encodeSegment('a/b') === 'a~002Fb')
check('a tilde is escaped', encodeSegment('~') === '~007E')
check('an empty segment is rejected', throws(() => encodeSegment('')))

// -------------------------------------------------------------- projectKey

check('separators fold to dashes', projectKey('/home/me/proj') === '--home-me-proj--')
check('a key is fenced with dashes', projectKey('proj').startsWith('--') && projectKey('proj').endsWith('--'))
check('a bare separator folds to the root name', projectKey('/') === '--root--')
check('an empty project path is rejected', throws(() => projectKey('')))

// ---------------------------------------------------------- storedSessionDir

const composed = storedSessionDir('/home/me/proj', 'session-1')
check('a stored dir composes root + project + id', composed === join(sessionsRoot(), '--home-me-proj--', 'session-1'))

// ------------------------------------------------------------- fs round trip

const sandbox = await mkdtemp(join(tmpdir(), 'moqi-sessions-'))
const savedHome = process.env['DSH_HOME']
process.env['DSH_HOME'] = sandbox
try {
  const cwd = '/home/me/proj'
  const id = 'session-xyz'
  const target = storedSessionDir(cwd, id)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'session.jsonl'), '{"type":"meta"}\n', 'utf8')

  check('find locates the stored directory', (await findStoredSessionDir(id)) === target)
  check('find misses an unknown id', (await findStoredSessionDir('session-nope')) === undefined)

  check('delete removes a stored session', (await deleteStoredSession(cwd, id)) === true)
  check('a second delete reports false', (await deleteStoredSession(cwd, id)) === false)
} finally {
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(sandbox, { recursive: true, force: true })
}

// eslint-disable-next-line no-console
console.log(`ok - ${String(checks)} checks passed`)
