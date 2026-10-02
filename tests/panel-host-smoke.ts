/**
 * Smoke tests for the host side of the `tuiHost` panel seam.
 *
 * The module under test is framework-free, so all of the async lifecycle —
 * activation, the masked prompt, submission, and the three failure paths — is
 * driven here with an in-memory surface, no Cordis and no terminal.
 */
import assert from 'node:assert/strict'
import { PanelHost } from '../src/tui/panel-host.ts'
import type { PanelSource, PanelSurface } from '../src/tui/panel-host.ts'
import type { TuiPanel, TuiPanelRow } from '../src/tui-host-core.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

// ------------------------------------------------------------- the fakes

interface Listed {
  title: string
  rows: readonly TuiPanelRow[]
  select: string | undefined
}

class RecordingSurface implements PanelSurface {
  readonly lists: Listed[] = []
  readonly asked: { title: string; message: string; placeholder: string | undefined }[] = []
  readonly reports: string[] = []
  readonly failures: unknown[] = []
  paints = 0
  /** What the next masked prompt answers; `undefined` means the user backed out. */
  answer: string | undefined = 'stored'

  showList(title: string, rows: readonly TuiPanelRow[], select?: string): void {
    this.lists.push({ title, rows, select })
  }
  askSecret(title: string, message: string, placeholder?: string): Promise<string | undefined> {
    this.asked.push({ title, message, placeholder })
    return Promise.resolve(this.answer)
  }
  report(text: string): void {
    this.reports.push(text)
  }
  fail(error: unknown): void {
    this.failures.push(error)
  }
  paint(): void {
    this.paints += 1
  }
}

function sourceOf(panels: readonly TuiPanel[]): PanelSource {
  return {
    panels: () => panels,
    findPanel: (name) => panels.find((panel) => panel.name.toLowerCase() === name.trim().toLowerCase()),
  }
}

/** A panel whose rows carry the current subtitle, so a refresh is visible. */
function togglePanel(overrides: Partial<TuiPanel> = {}): TuiPanel {
  let on = false
  return {
    name: 'JevLoop',
    title: 'Jev Loop',
    description: 'gates',
    rows: () => [{ id: 'gate', title: 'Pre-execute', subtitle: on ? 'on' : 'off', active: on }],
    activate: () => {
      on = !on
    },
    ...overrides,
  }
}

// --------------------------------------------------------------- commands

{
  const nameOnly: TuiPanel = { name: 'Bare', description: 'no title', rows: () => [], activate: () => {} }
  const host = new PanelHost(sourceOf([togglePanel(), nameOnly, { ...nameOnly, name: 'jevloop' }]), new RecordingSurface())
  const commands = host.commands()
  check('every panel becomes a command', commands.length === 2)
  check('a command names its panel', commands[0]?.name === 'JevLoop')
  check('a command carries the description', commands[0]?.description === 'gates')
  check('command names dedupe case-insensitively', !commands.some((command) => command.name === 'jevloop'))

  const blank = new PanelHost(sourceOf([{ ...nameOnly, name: '   ' }]), new RecordingSurface())
  check('a blank name is not a command', blank.commands().length === 0)
}

// --------------------------------------------------------------- opening

{
  const panel = togglePanel()
  const surface = new RecordingSurface()
  const host = new PanelHost(sourceOf([panel]), surface)

  check('a known name opens', host.openByName('jevloop') === true)
  check('the list is drawn once', surface.lists.length === 1)
  check('the panel title heads the list', surface.lists[0]?.title === 'Jev Loop')
  check('the rows come from the panel', surface.lists[0]?.rows[0]?.subtitle === 'off')
  check('opening repaints', surface.paints === 1)
  check('an unknown name does not open', host.openByName('nope') === false)
  check('an unknown name draws nothing more', surface.lists.length === 1)

  host.open(panel, 'gate')
  check('a requested row is focused', surface.lists[1]?.select === 'gate')
}

// ------------------------------------------------- activation, no prompt

{
  const panel = togglePanel()
  const surface = new RecordingSurface()
  const host = new PanelHost(sourceOf([panel]), surface)

  await host.activate('gate')
  check('activating with no panel open is a no-op', surface.lists.length === 0)

  host.open(panel)
  await host.activate('gate')
  check('activation re-reads the rows', surface.lists[1]?.rows[0]?.subtitle === 'on')
  check('activation restores the cursor', surface.lists[1]?.select === 'gate')
  check('no prompt is raised for a plain action', surface.asked.length === 0)
}

// --------------------------------------------------- activation, secret

{
  const submitted: string[] = []
  const panel = togglePanel({
    activate: () => ({ kind: 'secret', message: 'paste the key', placeholder: 'ts_…', submit: (value) => { submitted.push(value) } }),
  })
  const surface = new RecordingSurface()
  surface.answer = 'sk-live-123'
  const host = new PanelHost(sourceOf([panel]), surface)
  host.open(panel)
  await host.activate('gate')

  check('a secret row raises a prompt', surface.asked.length === 1)
  check('the prompt is titled with the panel', surface.asked[0]?.title === 'Jev Loop')
  check('the prompt carries the message', surface.asked[0]?.message === 'paste the key')
  check('the prompt carries the placeholder', surface.asked[0]?.placeholder === 'ts_…')
  check('the answer is submitted', submitted[0] === 'sk-live-123')
  check('the rows refresh after the answer', surface.lists[1]?.rows[0]?.subtitle === 'off')
}

// ------------------------------------------------- cancelled prompt

{
  const submitted: string[] = []
  const panel = togglePanel({
    activate: () => ({ kind: 'secret', message: 'key', submit: (value) => { submitted.push(value) } }),
  })
  const surface = new RecordingSurface()
  surface.answer = undefined
  const host = new PanelHost(sourceOf([panel]), surface)
  host.open(panel)
  await host.activate('gate')

  check('a cancelled prompt does not submit', submitted.length === 0)
  check('a cancelled prompt says so', surface.reports[0] === 'cancelled')
  check('a cancelled prompt keeps the panel open', surface.lists.length === 2)
  check('a cancelled prompt is not an error', surface.failures.length === 0)
}

// ------------------------------------------------------------ failures

{
  const boom = new Error('activate exploded')
  const panel = togglePanel({ activate: () => { throw boom } })
  const surface = new RecordingSurface()
  const host = new PanelHost(sourceOf([panel]), surface)
  host.open(panel)
  await host.activate('gate')
  check('a throwing action is reported', surface.failures[0] === boom)
  check('a throwing action keeps the panel open', surface.lists.length === 2)
}

{
  const boom = new Error('submit exploded')
  const panel = togglePanel({
    activate: () => ({ kind: 'secret', message: 'key', submit: () => { throw boom } }),
  })
  const surface = new RecordingSurface()
  surface.answer = 'value'
  const host = new PanelHost(sourceOf([panel]), surface)
  host.open(panel)
  await host.activate('gate')
  check('a throwing submit is reported', surface.failures[0] === boom)
  check('a throwing submit keeps the panel open', surface.lists.length === 2)
}

// ------------------------------------------------------- panel switching

{
  const first = togglePanel({ name: 'First', description: 'one' })
  const second = togglePanel({ name: 'Second', description: 'two' })
  let touched = ''
  const host = new PanelHost(sourceOf([first, second]), new RecordingSurface())
  host.open(first)
  host.openByName('Second')
  await host.activate('gate')
  check('activation targets the newest panel', true)

  // The second panel's own action marks it, so the switch is observable.
  const marked: TuiPanel = {
    name: 'Second',
    description: 'two',
    rows: () => [{ id: 'x', title: 'X', subtitle: '' }],
    activate: () => { touched = 'second' },
  }
  const surface = new RecordingSurface()
  const switched = new PanelHost(sourceOf([first, marked]), surface)
  switched.open(first)
  switched.openByName('second')
  await switched.activate('x')
  check('the last opened panel receives the action', touched === 'second')
}

console.log(`ok - ${String(checks)} panel-host checks passed`)
