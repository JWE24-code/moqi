/**
 * The shift+tab session-mode cycle, pure.
 *
 * Run with: node --experimental-strip-types tests/session-mode-smoke.ts
 */
import assert from 'node:assert/strict'
import { currentMode, modeBadge, nextMode } from '../src/session-mode.ts'

// The cycle: read-only → workspace-write → plan → read-only.
assert.deepEqual(nextMode('read-only'), { mode: 'workspace-write', preset: 'workspace-write', plan: false })
assert.deepEqual(nextMode('workspace-write'), { mode: 'plan', preset: 'workspace-write', plan: true })
assert.deepEqual(nextMode('plan'), { mode: 'read-only', preset: 'read-only', plan: false })
let mode = nextMode('read-only').mode as string
for (let step = 0; step < 3; step += 1) mode = nextMode(mode).mode
assert.equal(mode, 'workspace-write', 'three steps come back round')

// Plan keeps writes possible, so an approved plan can be carried out.
assert.equal(nextMode('workspace-write').preset, 'workspace-write')
// Full access is never a step, and leaving it goes to the narrow end.
for (const from of ['read-only', 'workspace-write', 'plan', 'danger-full-access', 'custom']) {
  assert.notEqual(nextMode(from).preset, 'danger-full-access' as string, `never steps into full access from ${from}`)
}
assert.equal(nextMode('danger-full-access').mode, 'read-only')
assert.equal(nextMode('custom').mode, 'read-only')

// Plan state wins over the preset, pending included.
assert.equal(currentMode('workspace-write', true), 'plan')
assert.equal(currentMode('read-only', false), 'read-only')
assert.equal(currentMode('danger-full-access', false), 'danger-full-access')

// The badge flags only what differs from the everyday default.
assert.equal(modeBadge('workspace-write'), undefined)
assert.equal(modeBadge(undefined), undefined)
assert.equal(modeBadge('read-only'), 'read-only')
assert.equal(modeBadge('plan'), 'plan')
assert.equal(modeBadge('danger-full-access'), '⚠ full access')
assert.equal(modeBadge('custom'), 'custom')

console.log('session-mode-smoke: ok')
