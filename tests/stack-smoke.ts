/**
 * A dependency-free smoke test for the stacked view.
 *
 * Covers the tiling math (`tileGrid`, `tiles`, `focusNeighbor`), the frame
 * stitcher (`stackFrame`), and a full `render` of a stacked snapshot: every
 * session's title on screen, pane bodies drawn, and the frame invariants the
 * screen driver relies on holding just as they do in the tabbed view.
 *
 * Run with: node --experimental-strip-types tests/stack-smoke.ts
 */

import assert from 'node:assert/strict'

import { Composer, Palette, Picker, textMessage } from '../src/tui/state.ts'
import { displayWidth, stripAnsi } from '../src/tui/text.ts'
import { focusNeighbor, stackFrame, tileGrid, tiles } from '../src/tui/stack.ts'
import { render, type Snapshot } from '../src/tui/view.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

// ------------------------------------------------------------------- geometry

check('one pane fills the grid', JSON.stringify(tileGrid(1)) === '{"columns":1,"rows":1}')
check('two panes sit side by side', JSON.stringify(tileGrid(2)) === '{"columns":2,"rows":1}')
check('three panes make two rows', JSON.stringify(tileGrid(3)) === '{"columns":2,"rows":2}')
check('four panes square off', JSON.stringify(tileGrid(4)) === '{"columns":2,"rows":2}')

{
  // Every layout covers the region exactly once: cells sum to the whole,
  // no tile is degenerate, and none reaches past the edge.
  for (const count of [1, 2, 3, 4, 5, 6, 7]) {
    for (const width of [20, 37, 80]) {
      for (const height of [5, 11, 24]) {
        const rects = tiles(count, width, height)
        check(`tiles(${count}) fill the width`, rects.every((t) => t.x + t.width <= width))
        check(`tiles(${count}) fill the height`, rects.every((t) => t.y + t.height <= height))
        check(`tiles(${count}) are non-empty`, rects.every((t) => t.width > 0 && t.height > 0))
        const lastColumn = Math.max(...rects.map((t) => t.x + t.width))
        const lastRow = Math.max(...rects.map((t) => t.y + t.height))
        check(`tiles(${count}) touch the right edge`, lastColumn === width)
        check(`tiles(${count}) touch the bottom edge`, lastRow === height)
      }
    }
  }
}

check('left stops at the first column', focusNeighbor(4, 0, 'left') === undefined)
check('left reaches the neighbor', focusNeighbor(4, 1, 'left') === 0)
check('right stops at the last column', focusNeighbor(4, 3, 'right') === undefined)
check('up jumps a row', focusNeighbor(4, 2, 'up') === 0)
check('down jumps a row', focusNeighbor(4, 0, 'down') === 2)
check('down respects the pane count', focusNeighbor(3, 1, 'down') === undefined)
check('down reaches the second row', focusNeighbor(3, 0, 'down') === 2)
check('up respects the top edge', focusNeighbor(3, 2, 'up') === 0 && focusNeighbor(4, 0, 'up') === undefined)

// ------------------------------------------------------------------ stitching

{
  const lines = stackFrame({
    count: 2,
    width: 40,
    height: 6,
    focused: 1,
    title: (index) => (index === 0 ? 'alpha' : 'beta'),
    renderBody: (index, width, height) =>
      Array.from({ length: height }, (unused, row) => `s${index}r${row}w${width}`),
  })
  check('stack frame has one line per row', lines.length === 6)
  check('stack frame fills the width', lines.every((line) => displayWidth(line) === 40))
  check('both panes show their title', stripAnsi(lines[0] ?? '').includes('alpha') && stripAnsi(lines[0] ?? '').includes('beta'))
  check('left pane draws its body', (lines[1] ?? '').includes('s0'))
  check('right pane draws its body', (lines[1] ?? '').includes('s1'))
  check('each pane sizes its body to its tile', (lines[1] ?? '').includes('w18') && !(lines[1] ?? '').includes('w40'))
  check('every pane is boxed on top and bottom', stripAnsi(lines[0] ?? '').includes('┌') && stripAnsi(lines[5] ?? '').includes('└'))
  check('panes are walled on the sides', stripAnsi(lines[2] ?? '').includes('│'))
  check(
    'focus changes the border without changing the text',
    (() => {
      const frame = (at: number): string[] =>
        stackFrame({ count: 2, width: 40, height: 6, focused: at, title: (index) => (index === 0 ? 'alpha' : 'beta'), renderBody: () => ['x'] })
      const a = frame(0)
      const b = frame(1)
      return stripAnsi(a.join('\n')) === stripAnsi(b.join('\n')) && a.join('\n') !== b.join('\n')
    })(),
  )
  check('the panes do not share a wall', (() => {
    const row = stripAnsi(lines[2] ?? '')
    return row.includes('││') || row.includes('│ │')
  })())
}

{
  // A body taller than its tile shows the tail; a shorter one is anchored to
  // the tile's bottom edge.
  const lines = stackFrame({
    count: 1,
    width: 20,
    height: 4,
    focused: 0,
    title: () => 't',
    renderBody: () => ['one', 'two', 'three', 'four', 'five'],
  })
  check('a tall body is clipped to the tail', stripAnsi(lines.slice(1).join(' ')).includes('five'))
  check('a tall body drops its head', !stripAnsi(lines.join(' ')).includes('one'))
  const short = stackFrame({
    count: 1,
    width: 20,
    height: 4,
    focused: 0,
    title: () => 't',
    renderBody: () => ['only'],
  })
  check(
    'a short body sits above the lower border',
    (short[2] ?? '').includes('only') && !(short[1] ?? '').includes('only') && stripAnsi(short[3] ?? '').startsWith('└'),
  )
}

check('degenerate regions render nothing', stackFrame({ count: 0, width: 10, height: 5, focused: 0, title: () => '', renderBody: () => [] }).length === 0)
check('zero height renders nothing', stackFrame({ count: 1, width: 10, height: 0, focused: 0, title: () => '', renderBody: () => [] }).length === 0)

// --------------------------------------------------------------------- render

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const base: Snapshot = {
    columns: 100,
    rows: 30,
    title: 'a session',
    host: 'local harness',
    modelName: 'deepseek-chat',
    messages: [textMessage('user', 'hello from a pane')],
    streamingSegments: [],
    streamingReasoning: '',
    streaming: false,
    spinner: '⠋',
    status: '',
    statusIsError: false,
    overlay: '',
    showThinking: false,
    composer: new Composer(),
    palette: new Palette(),
    picker: new Picker(),
    scrollBack: 0,
    expandTools: false,
    sessions: [],
    background: [],
    expandBackground: false,
    elapsedSeconds: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    haveUsage: false,
    contextLimit: 0,
    confirming: false,
  }
  return { ...base, ...overrides }
}

{
  const panes = ['alpha session', 'beta session', 'gamma session'].map((title) => ({
    title,
    snapshot: snapshot({ title }),
  }))
  const snap = snapshot({ stack: { panes, focused: 1, blinkOn: false } })
  const frame = render(snap)
  const text = stripAnsi(frame.lines.join('\n'))
  check('stacked frame fits the window', frame.lines.length <= snap.rows)
  check('stacked lines fit the width', frame.lines.every((line) => displayWidth(line) <= snap.columns))
  for (const pane of panes) check(`pane shown: ${pane.title}`, text.includes(pane.title))
  check('pane body is drawn', text.includes('hello from a pane'))
  check('the tab strip yields its row to the tiles', !frame.lines.some((line) => line.includes('● alpha session ●')))
}

{
  // A picker opened from the stacked view (`/model`, `/theme`, `/resume`, …)
  // must paint over the tiles: its keys already go to the picker, so a stack
  // that still draws makes every picker command look dead.
  const panes = ['alpha session', 'beta session'].map((title) => ({ title, snapshot: snapshot({ title }) }))
  const picker = new Picker()
  picker.show('models', 'Models', [{ id: 'deepseek-chat', title: 'deepseek-chat', subtitle: '' }])
  const snap = snapshot({ stack: { panes, focused: 0, blinkOn: false }, picker })
  const text = stripAnsi(render(snap).lines.join('\n'))
  check('an open picker paints over the stacked tiles', text.includes('Models') && !text.includes('alpha session'))
}

{
  // A tile whose session wants the user carries the highlight border and the
  // marker glyph, and blinks: the border trades the highlight for dim on the
  // off phase while the focused pane's own border never dims.
  const panes = ['alpha session', 'beta session'].map((title) => ({ title, snapshot: snapshot({ title }) }))
  // The waiting pane is the unfocused one: a focused tile keeps a steady
  // highlight (you are already looking at it), so the blink needs distance.
  const base = { panes: panes.map((pane, index) => (index === 1 ? { ...pane, attention: 'input' as const } : pane)), focused: 0 }
  const on = render(snapshot({ stack: { ...base, blinkOn: true } })).lines
  const off = render(snapshot({ stack: { ...base, blinkOn: false } })).lines
  const onText = stripAnsi(on.join('\n'))
  check('a waiting tile is marked in its border', onText.includes('! beta session'))
  check('the blinking tile changes between phases', JSON.stringify(on) !== JSON.stringify(off))
  const styled = on.filter((line) => line.includes('! beta session'))
  check('the on phase styles the waiting border', styled.length > 0 && styled.some((line) => line !== stripAnsi(line)))
  const done = render(
    snapshot({ stack: { panes: panes.map((pane, index) => (index === 1 ? { ...pane, attention: 'done' as const } : pane)), focused: 0, blinkOn: true } }),
  ).lines
  check('a finished tile is marked done', stripAnsi(done.join('\n')).includes('✓ beta session'))
}

{
  // A panel a pane's own session raised draws inside that tile only: the
  // permission window names its session, the other panes keep their feed.
  const approvalPane = snapshot({ title: 'alpha session' })
  approvalPane.panel = {
    kind: 'approval',
    title: 'Allow bash?',
    detail: 'rm -rf /tmp/x',
    rows: [{ label: 'Allow once', selected: true }, { label: 'Deny', selected: false }],
    hint: 'enter choose',
  }
  const panes = [
    { title: 'alpha session', snapshot: approvalPane },
    { title: 'beta session', snapshot: snapshot({ title: 'beta session' }) },
  ]
  const text = stripAnsi(render(snapshot({ stack: { panes, focused: 1, blinkOn: false } })).lines.join('\n'))
  check('the approval paints inside its own tile', text.includes('Allow bash?') && text.includes('rm -rf /tmp/x'))
  check('the other pane keeps its transcript', text.includes('hello from a pane'))
}

console.log(`stack-smoke: ${checks} checks passed`)
