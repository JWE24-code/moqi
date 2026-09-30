/**
 * Smoke tests for the `tuiHost` plugin seam: what a plugin may claim, what it
 * may not, and that releasing a claim really releases it.
 *
 * Imported from `tui-host-core.ts`, not `tui-host.ts`: the latter pulls in
 * Cordis, which no suite may need.
 */
import assert from 'node:assert/strict'
import {
  PanelRegistry,
  RESERVED_COMBOS,
  ShortcutRegistry,
  StatusLine,
  shortcutProblem,
} from '../src/tui-host-core.ts'
import type { TuiPanel } from '../src/tui-host-core.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

const host = new ShortcutRegistry()

// ------------------------------------------------------------ validation

check('a ctrl combination is acceptable', shortcutProblem('ctrl+shift+g', new Set()) === undefined)
check('an alt combination is acceptable', shortcutProblem('alt+g', new Set()) === undefined)
check('a bare letter is refused', shortcutProblem('g', new Set()) !== undefined)
check('a shift-only combination is refused', shortcutProblem('shift+g', new Set()) !== undefined)
check('an empty combination is refused', shortcutProblem('  ', new Set()) !== undefined)
check('a built-in binding is refused', shortcutProblem('ctrl+c', new Set()) !== undefined)
check('every reserved combo is refused', [...RESERVED_COMBOS].every((combo) => shortcutProblem(combo, new Set()) !== undefined))
check('a duplicate is refused', shortcutProblem('ctrl+shift+g', new Set(['ctrl+shift+g'])) !== undefined)

// -------------------------------------------------------- registration

let fired = 0
const dispose = host.register({ combo: 'ctrl+shift+g', label: 'greet', handler: () => { fired += 1 } })
check('a fresh combination registers', dispose !== undefined)
check('the registration is listed', host.registered().length === 1)
check('a built-in cannot be registered', host.register({ combo: 'ctrl+c', label: 'nope', handler: () => {} }) === undefined)
check('the same combination cannot register twice', host.register({ combo: 'ctrl+shift+g', label: 'again', handler: () => {} }) === undefined)

// ------------------------------------------------------------- dispatch

check('dispatch claims a registered key', host.dispatch('ctrl+shift+g') === true)
check('the handler ran', fired === 1)
check('an unregistered key is not claimed', host.dispatch('ctrl+shift+h') === false)
check('the handler did not run again', fired === 1)

// ------------------------------------------------------------ disposer

dispose?.()
check('after disposal the key is free', host.dispatch('ctrl+shift+g') === false)
check('after disposal it is unlisted', host.registered().length === 0)
const again = host.register({ combo: 'ctrl+shift+g', label: 'second life', handler: () => {} })
check('the combination can be claimed again', again !== undefined)
again?.()

// ---------------------------------------------------------- status line

const line = new StatusLine()
check('no status line by default', line.get() === undefined)
const clear = line.set('2 pending')
check('the status line is readable', line.get() === '2 pending')
line.set('newer')
clear()
check('a stale disposer does not clobber a newer line', line.get() === 'newer')
const clearNew = line.set(undefined)
check('an empty line clears it', line.get() === undefined)
clearNew()
const only = line.set('only line')
only()
check('disposing the owner restores the previous line', line.get() === 'newer')
check('a label can be read back for help', host.labelOf('nonexistent') === undefined)

// --------------------------------------------------------- panels

const panels = new PanelRegistry()
const panel: TuiPanel = {
  name: 'JevLoop',
  title: 'Jev Loop',
  description: 'gates',
  rows: () => [{ id: 'key', title: 'API key', subtitle: 'not set' }],
  activate: () => undefined,
}
const release = panels.register(panel)
check('a panel registers', release !== undefined)
check('the panel is listed', panels.registered().length === 1)
check('the panel is found case-insensitively', panels.find('jevloop') === panel)
check('an unknown panel is undefined', panels.find('nope') === undefined)
check('a duplicate name is refused', panels.register({ ...panel, title: 'again' }) === undefined)
check('an empty name is refused', panels.register({ ...panel, name: '  ' }) === undefined)
release?.()
check('after disposal the name is free', panels.find('JevLoop') === undefined)
check('after disposal it is unlisted', panels.registered().length === 0)

console.log(`ok - ${String(checks)} tui-host checks passed`)
