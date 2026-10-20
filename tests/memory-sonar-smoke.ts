/**
 * Pins the behavior of the memory code that the Sonar cleanup refactored:
 * slug trimming, the order of unindexed memories, the instruction chain's
 * root-first order, and saveNote's numbered titles. (`memory-tools.ts` is
 * not covered here: it imports the Harness, which no `npm test` suite may.)
 *
 * `$DSH_HOME` is a mkdtemp directory set before anything is imported, so
 * nothing here touches the real home.
 *
 * Run with: node --experimental-strip-types tests/memory-sonar-smoke.ts
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'moqi-memsonar-home-'))
const work = mkdtempSync(join(tmpdir(), 'moqi-memsonar-work-'))
process.env['DSH_HOME'] = home

const memory = await import('../src/memory.ts')
const { slugify, save, list, memoryDir, instructionChain, MemoryStore } = memory

try {
  const project = join(work, 'proj')
  mkdirSync(join(project, '.git'), { recursive: true })

  // --- slugify: dash trimming --------------------------------------------
  assert.equal(slugify('-a-'), 'a')
  assert.equal(slugify('---a---b---'), 'a-b')
  assert.equal(slugify('!!!x'), 'x')
  assert.equal(slugify('x!!!'), 'x')
  assert.equal(slugify(`${'a'.repeat(63)}!b`), 'a'.repeat(63), 'a dash cut at the length limit is trimmed')
  assert.equal(slugify(`!${'a'.repeat(70)}`), 'a'.repeat(63), 'trim happens after the cut')
  for (const bad of ['-', '---', '!!!', ' ']) assert.throws(() => slugify(bad), /no usable characters/)
  // A long run of dashes must stay fast (was the super-linear regex).
  const started = Date.now()
  assert.throws(() => slugify(`${'-'.repeat(50_000)}`), /no usable characters/)
  assert.ok(Date.now() - started < 1000)

  // --- list: memories missing from the index come in sorted order --------
  for (const name of ['b', 'a-b', 'ab', 'a0', 'a10', 'a2', '1a', 'z']) {
    save('project', project, { name, description: name, type: 'project', body: name })
  }
  // Drop the index so every memory is "unindexed" and falls to the sort.
  writeFileSync(join(memoryDir('project', project), 'MEMORY.md'), '')
  assert.deepEqual(
    list('project', project).map((m) => m.name),
    ['1a', 'a-b', 'a0', 'a10', 'a2', 'ab', 'b', 'z'],
  )

  // --- instructionChain: root first, then each level down ----------------
  const deep = join(project, 'one', 'two')
  mkdirSync(deep, { recursive: true })
  const dirsInOrder = [
    ...new Set(
      instructionChain(deep)
        .filter((f) => f.scope === 'project')
        .map((f) => f.path.slice(0, f.path.lastIndexOf('/'))),
    ),
  ]
  assert.deepEqual(dirsInOrder, [project, join(project, 'one'), deep])

  // --- saveNote: numbered titles count up past 2 -------------------------
  const store = new MemoryStore(project)
  const titles = [1, 2, 3, 4].map(() => store.saveNote('project', 'run make check').title)
  assert.deepEqual(titles, ['run make check', 'run make check 2', 'run make check 3', 'run make check 4'])

  console.log('memory-sonar-smoke: ok')
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}
