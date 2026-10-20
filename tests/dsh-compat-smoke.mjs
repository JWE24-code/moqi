/**
 * The dsh compatibility watch's pure half: version picking, the job matrix,
 * the tracking issue's state round trip, and failure-issue decisions.
 */
import assert from 'node:assert/strict'
import {
  buildMatrix,
  compareVersions,
  failureActions,
  failureMatches,
  failureTitle,
  parseState,
  pickVersions,
  recordResults,
  renderBody,
} from '../scripts/dsh-compat/state.mjs'

let checks = 0
const check = (name, fn) => {
  fn()
  checks += 1
  console.log(`ok - ${name}`)
}

const distTags = { latest: '0.2.1-rc.2', next: '0.2.1-rc.2', alpha: '0.2.1-alpha.5' }

check('a version on two tags is tested once, carrying both tags', () => {
  assert.deepEqual(pickVersions({ distTags, tags: ['latest', 'next'], tested: {} }), [
    { version: '0.2.1-rc.2', tags: ['latest', 'next'] },
  ])
})

check('already-tested versions are skipped unless forced', () => {
  const tested = { '0.2.1-rc.2': {} }
  assert.deepEqual(pickVersions({ distTags, tags: ['latest', 'next'], tested }), [])
  assert.equal(pickVersions({ distTags, tags: ['latest'], tested, force: true }).length, 1)
})

check('exact versions and unknown tags', () => {
  const picked = pickVersions({ distTags, tags: ['latest', 'nope'], versions: ['0.1.5-rc.3', '0.2.1-rc.2'], tested: {} })
  assert.deepEqual(picked, [
    { version: '0.2.1-rc.2', tags: ['latest'] },
    { version: '0.1.5-rc.3', tags: [] },
  ])
})

check('macOS only for latest; manual versions are labelled', () => {
  const matrix = buildMatrix([
    { version: '1.0.0', tags: ['latest'] },
    { version: '1.1.0-rc.1', tags: ['next'] },
    { version: '0.9.0', tags: [] },
  ])
  assert.deepEqual(
    matrix.include.map((j) => `${j.version}/${j.os}/${j.tags}`),
    [
      '1.0.0/ubuntu-latest/latest',
      '1.0.0/windows-latest/latest',
      '1.0.0/macos-latest/latest',
      '1.1.0-rc.1/ubuntu-latest/next',
      '1.1.0-rc.1/windows-latest/next',
      '0.9.0/ubuntu-latest/manual',
      '0.9.0/windows-latest/manual',
    ],
  )
})

check('versions sort newest first, a release after its prereleases', () => {
  const sorted = ['0.2.1-rc.2', '0.2.1', '0.1.5-rc.3', '0.2.1-alpha.5', '0.2.1-rc.10', '0.10.0'].sort(compareVersions)
  assert.deepEqual(sorted, ['0.10.0', '0.2.1', '0.2.1-rc.10', '0.2.1-rc.2', '0.2.1-alpha.5', '0.1.5-rc.3'])
})

const results = [
  { version: '0.2.1-rc.2', os: 'ubuntu-latest', source: 'published', target: 'moqi-tui', ok: true },
  { version: '0.2.1-rc.2', os: 'windows-latest', source: 'published', target: 'moqi-tui', ok: false, step: 'moqi install', detail: 'boom' },
  { version: '0.2.1-rc.2', os: 'ubuntu-latest', source: 'main', target: 'all', ok: true },
]

check('state survives the issue body round trip, without step detail', () => {
  const state = recordResults({ versions: {} }, results, { run: '42', at: 'now', tagsByVersion: { '0.2.1-rc.2': 'latest,next' } })
  const body = renderBody(state, 'https://github.com/o/r')
  const back = parseState(body)
  assert.deepEqual(back, state)
  assert.equal(back.versions['0.2.1-rc.2'].results.length, 3)
  assert.ok(!body.includes('boom'))
  assert.ok(body.includes('❌ windows'))
  assert.ok(body.includes('[run](https://github.com/o/r/actions/runs/42)'))
})

check('a rerun replaces a cell instead of adding a second one', () => {
  const first = recordResults({ versions: {} }, results, { run: '1', at: 'a' })
  const fixed = { ...results[1], ok: true }
  const second = recordResults(first, [fixed], { run: '2', at: 'b' })
  const cells = second.versions['0.2.1-rc.2'].results.filter((r) => r.target === 'moqi-tui' && r.os === 'windows-latest')
  assert.deepEqual(cells.map((r) => r.ok), [true])
})

check('a missing or broken state reads as empty', () => {
  assert.deepEqual(parseState(undefined), { versions: {} })
  assert.deepEqual(parseState('no state here'), { versions: {} })
  assert.deepEqual(parseState('<!-- dsh-compat-state {not json -->'), { versions: {} })
})

check('failure actions: open when any system failed, close when all passed', () => {
  const actions = failureActions(results)
  const open = actions.find((a) => a.target === 'moqi-tui')
  assert.equal(open.kind, 'open')
  assert.deepEqual(open.failed.map((r) => r.os), ['windows-latest'])
  assert.equal(actions.find((a) => a.target === 'all').kind, 'close')
})

check('failure issue titles match by target and source, across versions', () => {
  const title = failureTitle('0.3.0', 'moqi-jev-loop', 'main')
  assert.equal(title, 'dsh 0.3.0 breaks moqi-jev-loop (main)')
  assert.ok(failureMatches(title, 'moqi-jev-loop', 'main'))
  assert.ok(!failureMatches(title, 'moqi-jev-loop', 'published'))
  assert.ok(!failureMatches(title, 'jev-loop', 'main'))
})

console.log(`dsh-compat-smoke: ${String(checks)} checks passed`)
