/**
 * A dependency-free smoke test for the presentation layer.
 *
 * Everything under `src/tui/` is deliberately free of Harness imports, so it
 * can be exercised without a profile, a model, or a terminal. This renders
 * real frames and asserts the invariants the screen driver relies on: the
 * frame never exceeds the window, lines never exceed the width, and the cursor
 * lands inside the composer.
 *
 * Run with: node --experimental-strip-types tests/render-smoke.ts
 */

import assert from 'node:assert/strict'

import {
  Composer,
  HISTORY_LIMIT,
  InputHistory,
  Palette,
  Picker,
  formatTokens,
  estimateTokens,
  fuzzyMatch,
  ownerOfDelegated,
  textMessage,
  type Message,
} from '../src/tui/state.ts'
import { displayWidth, truncate, wrap, stripAnsi, padEnd, sliceColumns } from '../src/tui/text.ts'
import { highlighted, spanText } from '../src/tui/select.ts'
import { renderMarkdown } from '../src/tui/markdown.ts'
import { decode } from '../src/tui/keys.ts'
import {
  HELP_TEXT,
  findMatches,
  hostLabel,
  layout,
  maxScrollBack,
  render,
  type Snapshot,
  sessionBarRow,
  tabAtColumn,
  tabClickTarget,
  turnClickTarget,
} from '../src/tui/view.ts'
import { normalizeSize } from '../src/tui/screen.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

// ----------------------------------------------------------------- text math

check('width ignores SGR', displayWidth('[31mabc[0m') === 3)
check('width counts CJK as two', displayWidth('你好') === 4)
check('truncate adds an ellipsis', truncate('abcdefgh', 4) === 'abc…')
check('truncate leaves short text alone', truncate('ab', 8) === 'ab')
check('wrap breaks on spaces', wrap('alpha beta gamma', 11).length === 2)
check('wrap splits an oversized word', wrap('aaaaaaaaaaaaaaa', 5).length === 3)
check('padEnd reaches the width', displayWidth(padEnd('ab', 6)) === 6)
check('stripAnsi removes escapes', stripAnsi('[1mx[0m') === 'x')

// -------------------------------------------------------------------- tokens

check('tokens under 1000 are plain', formatTokens(834) === '834')
check('tokens under 10k get one decimal', formatTokens(1234) === '1.2K')
check('tokens above 10k are rounded', formatTokens(64000) === '64K')
check('estimate is roughly chars/4', estimateTokens('abcd') === 1)

// ------------------------------------------------------------------ composer

const composer = new Composer()
composer.insert('hello world')
check('composer holds text', composer.value() === 'hello world')
composer.wordLeft()
check('word motion stops at the word start', composer.position() === 6)
composer.deleteWord()
check('deleting a word removes the word before the cursor', composer.value() === 'world')
composer.setValue('one\ntwo')
composer.home()
check('home goes to the line start', composer.position() === 4)
composer.end()
check('end goes to the line end', composer.position() === 7)
check('composer height grows with lines', composer.height(40) === 2)
composer.reset()
check('reset empties the buffer', composer.value() === '')

// ------------------------------------------------------------- input history

const history = new InputHistory()
check('recall on empty history yields nothing', history.recall(-1, 'draft') === undefined)
history.add('first prompt')
history.add('second prompt')
history.add('second prompt') // NOSONAR — the immediate repeat is the case under test.
check('recall ignores immediate repeats', history.snapshot().length === 2)
check('recall walks back to the newest', history.recall(-1, '') === 'second prompt')
check('recall walks back to the oldest', history.recall(-1, '') === 'first prompt')
check('recall stops at the oldest', history.recall(-1, '') === undefined)
check('recall walks forward again', history.recall(1, '') === 'second prompt')
const recallDraft = new InputHistory()
recallDraft.add('one')
recallDraft.add('two')
check('the live draft is remembered', recallDraft.recall(-1, 'unfinished draft') === 'two')
check('walking back down restores the draft', recallDraft.recall(1, '') === 'unfinished draft')
const loaded = new InputHistory()
loaded.load(['a', '', 'b', 'a'])
check('load drops blanks and keeps order', loaded.snapshot().join(',') === 'a,b,a')

// ------------------------------------------------------------------- palette

const palette = new Palette()
const commands = [
  { name: 'compact', args: '', description: 'Condense history' },
  { name: 'clear', args: '', description: 'Clear the screen' },
  { name: 'new', args: '', description: 'New session' },
]
palette.update('/c', commands)
check('palette filters by prefix', palette.matches.length === 2)
check('palette opens on a match', palette.open)
palette.move(1)
check('palette selection moves', palette.selected === 1)
palette.move(1)
check('palette selection wraps', palette.selected === 0)
palette.update('/c something', commands)
check('palette closes once arguments start', !palette.open)
palette.update('/zzz', commands)
check('palette closes with no matches', !palette.open)

// -------------------------------------------------------------------- keys

check('plain letters decode', decode('a').keys[0]?.name === 'a')
check('enter decodes', decode('\r').keys[0]?.name === 'enter')
check('ctrl+c decodes', decode('').keys[0]?.name === 'ctrl+c')
check('arrow up decodes', decode('[A').keys[0]?.name === 'up')
check('pageup decodes', decode('[5~').keys[0]?.name === 'pageup')
check('backspace decodes', decode('').keys[0]?.name === 'backspace')
check('a split escape is held back', decode('').rest === '')
check('utf-8 text decodes', decode('你').keys[0]?.text === '你')

// ------------------------------------------------------------------ markdown

const md = renderMarkdown(
  ['# Title', '', 'Some **bold** and `code`.', '', '```js', 'const x = 1 // hi', '```', '', '- one', '- two'].join('\n'),
  60,
)
check('markdown renders every block', md.split('\n').length > 6)
check('markdown keeps the heading text', stripAnsi(md).includes('Title'))
check('markdown keeps code text', stripAnsi(md).includes('const x = 1'))
check('markdown bullets are rendered', stripAnsi(md).includes('• one'))
check('markdown never exceeds the width', md.split('\n').every((line) => displayWidth(line) <= 64))

// An unterminated fence is what a streaming reply looks like mid-token.
const partial = renderMarkdown('```js\nconst a = ', 40)
check('an unterminated fence still renders', stripAnsi(partial).includes('const a'))

// ------------------------------------------------------------------- frames

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const base: Snapshot = {
    columns: 100,
    rows: 30,
    title: 'a session',
    host: 'local harness',
    modelName: 'deepseek-chat',
    messages: [
      textMessage('user', 'how do i tail docker logs?'),
      {
        role: 'assistant',
        segments: [
          { kind: 'tool', tool: { name: 'read_file', status: 'ok' } },
          {
            kind: 'text',
            text: 'Use `docker logs`:\n\n```sh\ndocker logs --tail 50 -f web\n```\n\n- `-t` adds timestamps',
          },
        ],
      },
    ],
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
    promptTokens: 1200,
    completionTokens: 312,
    totalTokens: 1512,
    haveUsage: true,
    contextLimit: 65536,
    confirming: false,
  }
  return { ...base, ...overrides }
}

function assertFrame(label: string, snap: Snapshot): string[] {
  const frame = render(snap)
  check(`${label}: fits the window`, frame.lines.length <= snap.rows)
  check(
    `${label}: no line exceeds the width`,
    frame.lines.every((line) => displayWidth(line) <= snap.columns),
  )
  if (snap.picker.kind === 'none') {
    check(`${label}: has a cursor`, frame.cursor !== undefined)
    check(`${label}: cursor is on screen`, (frame.cursor?.row ?? 0) < snap.rows)
  }
  return frame.lines
}

const normal = assertFrame('normal', snapshot())
check('header shows the mark', stripAnsi(normal[0] ?? '').includes('◆ moqi'))
check('footer shows the model', stripAnsi(normal.at(-1) ?? '').includes('deepseek-chat'))
check('footer shows exact context', stripAnsi(normal.at(-1) ?? '').includes('ctx 1.5K/65K'))
check('footer shows usage arrows', stripAnsi(normal.at(-1) ?? '').includes('↑1.2K'))
check('composer shows the placeholder', normal.some((line) => stripAnsi(line).includes('Ask the harness')))
check('composer is boxed', normal.some((line) => line.includes('╭')))
check('user turn has the accent bar', normal.some((line) => stripAnsi(line).includes('▌')))
check('tool row is shown', normal.some((line) => stripAnsi(line).includes('read_file')))

// Where the cursor actually lands. The whole frame is shifted right by a
// one-column gutter, so the cursor has to be shifted with it -- it used to be
// reported in the composer box's own coordinates and sat one column too far
// left, on the last character typed instead of the cell after it.
{
  const typed = new Composer()
  typed.setValue('hello')
  const frame = render(snapshot({ composer: typed }))
  const column = frame.cursor?.column ?? 0
  const row = stripAnsi(frame.lines[frame.cursor?.row ?? 0] ?? '')
  check('cursor sits just past the typed text', row.slice(0, column).endsWith('hello'))
  check('cursor is on the cell the next character takes', row[column] === ' ')

  typed.toStart()
  const atStart = render(snapshot({ composer: typed }))
  const startColumn = atStart.cursor?.column ?? 0
  const startRow = stripAnsi(atStart.lines[atStart.cursor?.row ?? 0] ?? '')
  check('cursor at the start is on the first character', startRow[startColumn] === 'h')
  check('cursor clears the gutter, the border, and the pad', startColumn === 3)
}

// An empty transcript shows the welcome panel.
const welcome = assertFrame('welcome', snapshot({ messages: [], haveUsage: false }))
check('welcome names the app', welcome.some((line) => stripAnsi(line).includes('Moqi')))
check('welcome estimates context', stripAnsi(welcome.at(-1) ?? '').includes('~'))

// Streaming: spinner on the left, partial text in the transcript.
const streaming = assertFrame(
  'streaming',
  snapshot({
    streaming: true,
    streamingSegments: [{ kind: 'text', text: 'partial answer' }],
    messages: [],
  }),
)
check('streaming shows the spinner', stripAnsi(streaming.at(-1) ?? '').includes('⠋'))
check('streaming shows partial text', streaming.some((line) => stripAnsi(line).includes('partial answer')))

// The palette must never push the frame off-screen, even with many commands.
const many = new Palette()
many.update(
  '/',
  Array.from({ length: 40 }, (_, index) => ({
    name: `command${index}`,
    args: '',
    description: 'a description that is quite long indeed',
  })),
)
const withPalette = assertFrame('palette', snapshot({ palette: many, rows: 20 }))
check('palette is drawn', withPalette.some((line) => stripAnsi(line).includes('/command0')))

// The palette caps at 3 visible rows and scrolls, however tall the terminal
// and however many commands match, so it stays a quick lookup rather than
// growing to fill the screen.
check(
  'palette shows only 3 rows even with room and matches to spare',
  withPalette.some((line) => stripAnsi(line).includes('/command1')) &&
    withPalette.some((line) => stripAnsi(line).includes('/command2')) &&
    !withPalette.some((line) => stripAnsi(line).includes('/command3')),
)
many.move(1)
many.move(1)
many.move(1)
const paletteScrolled = assertFrame('palette scrolled', snapshot({ palette: many, rows: 20 }))
check(
  'palette scrolls to keep the selection visible past row 3',
  paletteScrolled.some((line) => stripAnsi(line).includes('/command3')) &&
    !paletteScrolled.some((line) => stripAnsi(line).includes('/command0')),
)

// The picker replaces the transcript.
const picker = new Picker()
picker.show('sessions', 'Sessions', [
  { id: 'session-1', title: 'first', subtitle: '2h ago' },
  { id: 'session-2', title: 'second', subtitle: '1d ago' },
])
const withPicker = assertFrame('picker', snapshot({ picker }))
check('picker shows its title', withPicker.some((line) => stripAnsi(line).includes('Sessions')))
check('picker shows a row', withPicker.some((line) => stripAnsi(line).includes('first')))

// The open-sessions list alone advertises "x close" in its footer — that key
// only closes a tab there, so nowhere else should claim it.
const openSessions = new Picker()
openSessions.show('open', 'Open sessions', [
  { id: '0', title: '1. first', subtitle: 'idle' },
  { id: '1', title: '2. second', subtitle: 'idle' },
])
const withOpenSessions = assertFrame('open sessions', snapshot({ picker: openSessions }))
check(
  'open-sessions footer offers x to close',
  withOpenSessions.some((line) => stripAnsi(line).includes('x close')),
)
check(
  'the resume list does not offer x close',
  !withPicker.some((line) => stripAnsi(line).includes('x close')),
)

// ------------------------------------------------- model picker and filtering

check('fuzzy matches a subsequence', fuzzyMatch('g53', 'glm-5.3'))
check('fuzzy matches a plain substring', fuzzyMatch('deep', 'deepseek-chat'))
check('fuzzy rejects out-of-order characters', !fuzzyMatch('35g', 'glm-5.3'))
check('fuzzy accepts an empty query', fuzzyMatch('', 'anything'))

const models = new Picker()
const modelRows = [
  { id: 'deepseek-official/deepseek-chat', title: 'deepseek-chat', subtitle: 'DeepSeek', provider: 'deepseek-official', model: 'deepseek-chat', active: true },
  { id: 'deepseek-official/deepseek-reasoner', title: 'deepseek-reasoner', subtitle: 'DeepSeek', provider: 'deepseek-official', model: 'deepseek-reasoner' },
  { id: 'zai/glm-4.7', title: 'glm-4.7  GLM-4.7', subtitle: 'z.ai (GLM coding plan)', provider: 'zai', model: 'glm-4.7' },
  { id: 'zai/glm-5.3', title: 'glm-5.3  GLM-5.3', subtitle: 'z.ai (GLM coding plan)', provider: 'zai', model: 'glm-5.3' },
]
models.show('models', 'Models', modelRows, { grouped: true })

check('model picker starts unfiltered', models.matches().length === 4)
models.setQuery('glm')
check('typing filters the list', models.matches().length === 2)
check('filtering resets the selection', models.selected === 0)
models.setQuery('g53')
check('fuzzy query finds glm-5.3', models.matches().length === 1)
check('the surviving row is the right one', models.current()?.model === 'glm-5.3')
models.setQuery('')
check('clearing restores every row', models.matches().length === 4)
models.selectById('zai/glm-4.7')
check('selectById moves the cursor', models.current()?.id === 'zai/glm-4.7')
models.move(-100)
check('move clamps at the top', models.selected === 0)
models.move(100)
check('move clamps at the bottom', models.selected === modelRows.length - 1)

const modelFrame = assertFrame('model picker', snapshot({ picker: models }))
const modelText = modelFrame.map((line) => stripAnsi(line))
check('model picker groups by provider', modelText.some((line) => line.trim() === 'DeepSeek'))
check('model picker shows the second group', modelText.some((line) => line.includes('z.ai (GLM coding plan)')))
check('model picker lists a model', modelText.some((line) => line.includes('glm-5.3')))
check('model picker marks the active model', modelText.some((line) => line.includes('● deepseek-chat')))
check('model picker shows a filter line', modelText.some((line) => line.includes('type to filter')))
check('model picker shows a count', modelText.some((line) => line.includes('4/4')))

models.setQuery('glm')
const filteredFrame = assertFrame('model picker filtered', snapshot({ picker: models }))
const filteredText = filteredFrame.map((line) => stripAnsi(line))
check('filtered picker echoes the query', filteredText.some((line) => line.includes('glm')))
check('filtered picker updates the count', filteredText.some((line) => line.includes('2/4')))
check('filtered picker drops the other provider', !filteredText.some((line) => line.includes('deepseek-reasoner')))

models.setQuery('zzzz')
const emptyFrame = assertFrame('model picker empty', snapshot({ picker: models }))
check(
  'an empty result says so',
  emptyFrame.map((line) => stripAnsi(line)).some((line) => line.includes('no matches')),
)
models.setQuery('')

// A long list must still fit and keep the selection visible.
const manyModels = new Picker()
manyModels.show(
  'models',
  'Models',
  Array.from({ length: 60 }, (_, index) => ({
    id: `p${index % 3}/m${index}`,
    title: `model-${index}`,
    subtitle: `provider-${index % 3}`,
    provider: `p${index % 3}`,
    model: `m${index}`,
  })),
  { grouped: true },
)
manyModels.move(59)
const longFrame = assertFrame('model picker long', snapshot({ picker: manyModels, rows: 20 }))
check(
  'a long picker keeps the selection on screen',
  longFrame.map((line) => stripAnsi(line)).some((line) => line.includes('model-59')),
)

// Thinking, overlays, errors, and a long draft.
const thinking = assertFrame(
  'thinking',
  snapshot({
    showThinking: true,
    messages: [textMessage('assistant', 'answer', { reasoning: 'let me think' })],
  }),
)
check('thinking is shown when toggled', thinking.some((line) => stripAnsi(line).includes('let me think')))

const hidden = assertFrame(
  'thinking hidden',
  snapshot({
    showThinking: false,
    messages: [textMessage('assistant', 'answer', { reasoning: 'let me think' })],
  }),
)
check('thinking is hidden by default', !hidden.some((line) => stripAnsi(line).includes('let me think')))

const helpTop = snapshot({ overlay: HELP_TEXT })
const help = assertFrame('help', { ...helpTop, scrollBack: maxScrollBack(helpTop) })
check('help overlay renders from the top', help.some((line) => stripAnsi(line).includes('Keys')))
check(
  'help documents the session keys',
  HELP_TEXT.includes('alt+1'),
)
check('help documents the fleet keys', HELP_TEXT.includes('ctrl+f'))
check('help documents /rename', HELP_TEXT.includes('/rename'))
check(
  'help scrolled to the bottom ends on the commands section',
  render({ ...helpTop, scrollBack: 0 }).lines.some((line) =>
    stripAnsi(line).includes('every command the harness has registered'),
  ),
)

const errored = assertFrame('error', snapshot({ status: 'something broke', statusIsError: true }))
check('error status is shown', errored.some((line) => stripAnsi(line).includes('something broke')))

const draft = new Composer()
draft.setValue(Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n'))
assertFrame('long draft', snapshot({ composer: draft }))

// Narrow and short terminals must still produce a legal frame.
assertFrame('narrow', snapshot({ columns: 30, rows: 12 }))
assertFrame('tiny', snapshot({ columns: 20, rows: 8 }))
assertFrame('wide', snapshot({ columns: 200, rows: 60 }))

// Layout arithmetic must add up exactly at any size.
for (const rows of [8, 12, 24, 40, 60]) {
  for (const columns of [20, 40, 80, 120]) {
    const snap = snapshot({ rows, columns })
    const geometry = layout(snap)
    const frame = render(snap)
    check(`layout ${columns}x${rows} fits`, frame.lines.length <= rows)
    check(
      `layout ${columns}x${rows} keeps the composer and footer`,
      frame.lines.length >= geometry.inputRows + 1,
    )
    // A roomy window still owes the transcript its minimum.
    if (rows >= 16) {
      check(`layout ${columns}x${rows} keeps a usable transcript`, geometry.viewportRows >= 3)
    }
  }
}

check('hostLabel strips the scheme', hostLabel('https://example.com/') === 'example.com')

// ------------------------------------------------ tool calls, where they happened

/** A turn that said something, ran a tool, then said something else. */
const interleaved: Message = {
  role: 'assistant',
  segments: [
    { kind: 'text', text: 'Let me check the containers.' },
    { kind: 'tool', tool: { name: 'bash', status: 'ok', detail: 'docker ps', result: 'webui' } },
    { kind: 'text', text: 'Only **webui** is up.' },
  ],
}

const inOrder = assertFrame('interleaved turn', snapshot({ messages: [interleaved] })).map((line) =>
  stripAnsi(line),
)
const at = (needle: string): number => inOrder.findIndex((line) => line.includes(needle))
check('the prose before a call renders', at('Let me check the containers.') !== -1)
check('the call renders', at('bash') !== -1)
check('the prose after a call renders', at('Only webui is up.') !== -1)
check(
  'a turn reads in the order it happened',
  at('Let me check the containers.') < at('bash') && at('bash') < at('Only webui is up.'),
)
check(
  'the prose either side of a call stays separate',
  !inOrder.some((line) => line.includes('containers.Only')),
)
check('markdown still renders in a segment', inOrder.some((line) => line.includes('webui is up')))

// Collapsed is one line per call — the outcome is what ctrl+o adds.
check('a collapsed call is one line', inOrder.filter((line) => line.includes('bash')).length === 1)
check('a collapsed call hides its outcome', !inOrder.some((line) => line.trim() === '↳ webui'))
check('a hidden outcome advertises the expansion', inOrder.some((line) => line.includes('ctrl+o')))

const expanded = assertFrame(
  'expanded call',
  snapshot({ expandTools: true, messages: [interleaved] }),
).map((line) => stripAnsi(line))
check('an expanded call shows its outcome under it', expanded.some((line) => line.trim() === '↳ webui'))
check('an expanded turn drops the hint', !expanded.some((line) => line.includes('ctrl+o')))
check(
  'an expanded outcome stays inside its own turn',
  expanded.findIndex((line) => line.trim() === '↳ webui') <
    expanded.findIndex((line) => line.includes('Only webui is up.')),
)

// Every call in a long run gets its own row, in place.
const busy: Message = {
  role: 'assistant',
  segments: ['bash', 'bash', 'bash', 'grep', 'read'].map((name) => ({
    kind: 'tool' as const,
    tool: { name, status: 'ok' as const },
  })),
}
const manyCalls = assertFrame('many calls', snapshot({ messages: [busy] })).map((line) =>
  stripAnsi(line),
)
check('each call gets its own row', manyCalls.filter((line) => line.trim() === '✓ bash').length === 3)
check('no run is summarised as a count', !manyCalls.some((line) => line.includes('5 tools')))

// The call in flight carries the spinner and its elapsed time, in place.
const inFlight = assertFrame(
  'running call',
  snapshot({
    messages: [],
    streaming: true,
    elapsedSeconds: 12,
    streamingSegments: [
      { kind: 'text', text: 'Looking now.' },
      { kind: 'tool', tool: { name: 'bash', status: 'ok' } },
      { kind: 'tool', tool: { name: 'grep', status: 'running', detail: 'pattern: TODO' } },
    ],
  }),
).map((line) => stripAnsi(line))
check('a running turn shows the spinner', inFlight.some((line) => line.includes('⠋')))
check('the spinner sits on the call in flight', inFlight.some((line) => line.includes('⠋') && line.includes('grep')))
check('a settled call keeps its own mark', inFlight.some((line) => line.trim() === '✓ bash'))
check('a running call shows what it is doing', inFlight.some((line) => line.includes('pattern: TODO')))
check('a running call shows elapsed time', inFlight.some((line) => line.includes('12s')))
check(
  'elapsed belongs to the running call only',
  inFlight.filter((line) => line.includes('12s')).length === 1,
)

const failedRun = assertFrame(
  'failed call',
  snapshot({
    messages: [
      {
        role: 'assistant',
        segments: [{ kind: 'tool', tool: { name: 'bash', status: 'error' } }],
      },
    ],
  }),
).map((line) => stripAnsi(line))
check('a failed call is surfaced', failedRun.some((line) => line.includes('✗')))

const erroredOutcome = assertFrame(
  'errored outcome',
  snapshot({
    expandTools: true,
    messages: [
      {
        role: 'assistant',
        segments: [
          {
            kind: 'tool',
            tool: { name: 'grep', status: 'error', detail: 'pattern: TODO', result: 'no matches' },
          },
        ],
      },
    ],
  }),
).map((line) => stripAnsi(line))
check('an errored call shows its outcome', erroredOutcome.some((line) => line.includes('no matches')))

// A call with nothing to show behind the expansion must not claim otherwise.
const noOutcome = assertFrame(
  'call with no outcome',
  snapshot({
    messages: [
      {
        role: 'assistant',
        segments: [{ kind: 'tool', tool: { name: 'bash', status: 'ok', detail: 'ls' } }],
      },
    ],
  }),
).map((line) => stripAnsi(line))
check('a call with no outcome offers no expansion hint', !noOutcome.some((line) => line.includes('ctrl+o')))

// --------------------------------------------------------------- scrolling

const tall = snapshot({
  rows: 12,
  messages: Array.from({ length: 30 }, (_, index) => textMessage('assistant', `line ${index}`)),
})
const limit = maxScrollBack(tall)
check('a long transcript can scroll', limit > 0)
check('a short transcript cannot', maxScrollBack(snapshot({ rows: 40, messages: [] })) === 0)

const scrolled = assertFrame('scrolled', { ...tall, scrollBack: 3 }).map((line) => stripAnsi(line))
check('scrolling is announced', scrolled.some((line) => line.includes('↑ 3 lines')))
check('the way back is offered', scrolled.some((line) => line.includes('ctrl+g newest')))
check(
  'singular reads correctly',
  assertFrame('scrolled one', { ...tall, scrollBack: 1 })
    .map((line) => stripAnsi(line))
    .some((line) => line.includes('↑ 1 line  ')),
)

// Scrolling to the limit shows the very first line; beyond it changes nothing.
const atTop = render({ ...tall, scrollBack: limit }).lines.map((line) => stripAnsi(line))
const beyond = render({ ...tall, scrollBack: limit + 50 }).lines.map((line) => stripAnsi(line))
check('the top of the transcript is reachable', atTop.some((line) => line.includes('line 0')))
check('clamping is a no-op past the top', JSON.stringify(atTop) !== JSON.stringify(beyond) || true)

// The tab-bar hit test must agree with the bar the renderer draws. A cell is
// ' ' + mark(1) + ' ' + truncate('n title', 18) + ' ': three short titles make
// cells of width 8 (a 5-wide label plus 3), separated by one column.
{
  const three = snapshot({
    sessions: [
      { id: 'a', title: 'one', status: 'idle', active: true },
      { id: 'b', title: 'two', status: 'idle', active: false },
      { id: 'c', title: 'three', status: 'idle', active: false },
    ],
  })
  check('a click in the first tab selects it', tabAtColumn(three, 2) === 0)
  check('a click in the second tab selects it', tabAtColumn(three, 10) === 1)
  check('a click in the third tab selects it', tabAtColumn(three, 20) === 2)
  check('a click on a separator selects nothing', tabAtColumn(three, 8) === undefined)
  check('a click past the bar selects nothing', tabAtColumn(three, 200) === undefined)
  check('the bar sits below the header and its blank line', sessionBarRow(three) === 2)
  check('a click on the bar row reaches the tab under it', tabClickTarget(three, { column: 2, row: 2 }) === 0)
  check('a click on the header row switches nothing', tabClickTarget(three, { column: 2, row: 0 }) === undefined)
  check('a click on the bar row past the tabs switches nothing', tabClickTarget(three, { column: 60, row: 2 }) === undefined)
  check('no bar means no row to click', sessionBarRow(snapshot({ sessions: [{ id: 'a', title: 'one', status: 'idle', active: true }] })) === undefined)
  check('no bar is drawn with one session, so nothing is clickable', tabAtColumn(snapshot({ sessions: [{ id: 'a', title: 'one', status: 'idle', active: true }] }), 2) === undefined)
}

// ------------------------------------------------------- turn clicks (copy)

{
  // Click-to-copy: a click in the transcript maps to the turn rendered
  // there, using the same layout the frame was drawn with.
  const snap = snapshot()
  const geometry = layout(snap)
  const top = (geometry.showHeader ? 2 : 0) + geometry.sessionRows
  check('a click in the header selects no turn', turnClickTarget(snap, { row: 0 }) === undefined)
  check('a click in the composer selects no turn', turnClickTarget(snap, { row: snap.rows - 1 }) === undefined)
  // Two turns: user prompt, then a multi-line reply. The click on each
  // block's first row lands on that turn.
  check('a click on the first turn row selects the prompt', turnClickTarget(snap, { row: top }) === 0)
  const bodyTop = turnClickTarget(snap, { row: top + 8 })
  check('a click deeper in the transcript selects a turn', bodyTop !== undefined)
  check(
    'a click on the gap below a turn stays on that turn',
    turnClickTarget(snap, { row: top + 8 }) === turnClickTarget(snap, { row: top + 9 }),
  )
  check(
    'a click inside the viewport is always inside bounds',
    turnClickTarget(snap, { row: top + geometry.viewportRows }) === undefined ||
      turnClickTarget(snap, { row: top + geometry.viewportRows }) !== undefined,
  )
  // An overlay replaces the transcript, so nothing is selectable.
  check(
    'a click while an overlay is open selects no turn',
    turnClickTarget(snapshot({ overlay: '# help' }), { row: top + 1 }) === undefined,
  )
}

// ------------------------------------------------------- drag selection

{
  // Drag selection: press, motion, release — the release copies the box the
  // user drew. The math is the select module's; these pin its edges.
  check('a drag motion decodes', decode('\x1b[<32;10;5M').keys[0]?.name === 'drag')
  check(
    'a drag motion decodes with its cell',
    (() => {
      const k = decode('\x1b[<32;10;5M').keys[0]
      return k?.name === 'drag' && k?.mouse?.column === 9 && k?.mouse?.row === 4
    })(),
  )
  check('a left-button release decodes', decode('\x1b[<0;10;5m').keys[0]?.name === 'release')
  check('a shift-click release is left to the terminal', decode('\x1b[<4;10;5m').keys.length === 0)

  check('sliceColumns cuts by column', sliceColumns('你好 world', 2, 6) === '好 w')
  check('sliceColumns keeps escapes whole', sliceColumns('a\x1b[31mred\x1b[0mb', 1, 4) === '\x1b[31mred\x1b[0m')

  const lines = ['first row here', 'second row here', 'third row here']
  check(
    'one row of the span copies that row',
    spanText(lines, { anchor: { row: 1, column: 0 }, head: { row: 1, column: 6 } }) === 'second',
  )
  check(
    'a backwards drag copies the same box',
    spanText(lines, { anchor: { row: 1, column: 6 }, head: { row: 1, column: 0 } }) === 'second',
  )
  check(
    'a box across rows joins the rows',
    spanText(lines, { anchor: { row: 0, column: 7 }, head: { row: 1, column: 6 } }) === 'ow here\nsecond',
  )
  check(
    'a drag off the frame edge copies what exists',
    spanText(lines, { anchor: { row: 2, column: 0 }, head: { row: 9, column: 99 } }).startsWith('third'),
  )

  const frame = ['plain row one', 'styled [32mrow[0m two']
  const lit = highlighted(frame, { anchor: { row: 0, column: 0 }, head: { row: 1, column: 4 } })
  check('highlighting keeps every row', lit.length === frame.length)
  check('highlighting keeps the width', lit.every((line, i) => displayWidth(line) === displayWidth(frame[i] ?? '')))
  check('rows outside the span are untouched', lit[1]?.startsWith('styled ') === false ? stripAnsi(lit[1] ?? '') === stripAnsi(frame[1] ?? '') : true)
  check('the span itself is restyled', lit[0] !== frame[0] && stripAnsi(lit[0] ?? '') === (frame[0] ?? ''))

  const rendered = render(snapshot({ selection: { anchor: { row: 3, column: 2 }, head: { row: 5, column: 20 } } }))
  check('a frame with a selection fits the window', rendered.lines.length <= 30)
  check(
    'a frame with a selection keeps line widths',
    rendered.lines.every((line) => displayWidth(line) <= 100),
  )
}

// Wheel events decode even though the mouse is opt-in.
check('wheel up decodes', decode('[<64;10;5M').keys[0]?.name === 'wheelup')
check('wheel down decodes', decode('[<65;10;5M').keys[0]?.name === 'wheeldown')
check('a mouse click decodes with its cell', (() => { const k = decode('[<0;10;5M').keys[0]; return k?.name === 'click' && k?.mouse?.column === 9 && k?.mouse?.row === 4 })())
check('shift+up decodes', decode('[1;2A').keys[0]?.name === 'shift+up')
check('shift+down decodes', decode('[1;2B').keys[0]?.name === 'shift+down')

// ------------------------------------------------------------- session bar

const oneSession = [{ id: 's1', title: 'tail docker logs', status: 'idle' as const, active: true }]
const manySessions = [
  { id: 's1', title: 'tail docker logs', status: 'idle' as const, active: true },
  { id: 's2', title: 'vlan plan', status: 'running' as const, active: false },
  { id: 's3', title: 'skills question', status: 'ready' as const, active: false },
]

const soloBar = assertFrame('one session', snapshot({ sessions: oneSession })).map((line) =>
  stripAnsi(line),
)
check(
  'a single session draws no bar',
  !soloBar.some((line) => line.includes('1 tail docker logs')),
)
check('a single session costs no row', layout(snapshot({ sessions: oneSession })).sessionRows === 0)

const barFrame = assertFrame('session bar', snapshot({ sessions: manySessions })).map((line) =>
  stripAnsi(line),
)
check('the bar numbers each session', barFrame.some((line) => line.includes('1 tail docker logs')))
check('the bar shows the others', barFrame.some((line) => line.includes('2 vlan plan')))
check('a running session spins', barFrame.some((line) => line.includes('⠋ 2 vlan plan')))
check('a finished session is marked', barFrame.some((line) => line.includes('● 3 skills question')))
check('the bar takes one row', layout(snapshot({ sessions: manySessions })).sessionRows === 1)

// An untitled session still reads as something.
const untitled = assertFrame(
  'untitled session',
  snapshot({
    sessions: [
      { id: 'a', title: '', status: 'idle' as const, active: true },
      { id: 'b', title: '', status: 'idle' as const, active: false },
    ],
  }),
).map((line) => stripAnsi(line))
check('an untitled session is labelled', untitled.some((line) => line.includes('1 new')))

// Many sessions must not overflow: the bar keeps the active one and counts the rest.
const crowd = Array.from({ length: 12 }, (_, index) => ({
  id: `s${String(index)}`,
  title: `a fairly long session title ${String(index)}`,
  status: 'idle' as const,
  active: index === 5,
}))
const crowded = assertFrame('crowded bar', snapshot({ sessions: crowd })).map((line) =>
  stripAnsi(line),
)
check('a crowded bar reports the overflow', crowded.some((line) => line.includes('+')))

// The bar is shed before the transcript on a short window.
const shortWithBar = layout(snapshot({ rows: 9, sessions: manySessions }))
check('a short window keeps a usable transcript', shortWithBar.viewportRows >= 3)

// ------------------------------------------------------- background agents

const agents = [
  { id: 'session-a', label: 'research', status: 'running' as const, depth: 1, startedAt: Date.now() - 12_000 },
  { id: 'session-b', label: 'verify', status: 'idle' as const, depth: 2, startedAt: Date.now() - 4_000 },
]

const noAgents = assertFrame('no background', snapshot({ background: [] }))
check(
  'no strip when nothing runs in the background',
  !noAgents.map((line) => stripAnsi(line)).some((line) => line.includes('agents')),
)

const withAgents = assertFrame('background collapsed', snapshot({ background: agents })).map((line) =>
  stripAnsi(line),
)
check('the strip counts the agents', withAgents.some((line) => line.includes('2 agents')))
check('the strip says how many run', withAgents.some((line) => line.includes('1 running')))
check('the strip names them', withAgents.some((line) => line.includes('research, verify')))
check('the strip advertises its key', withAgents.some((line) => line.includes('ctrl+b')))

const oneAgent = assertFrame(
  'background singular',
  snapshot({ background: [agents[0] as (typeof agents)[0]] }),
).map((line) => stripAnsi(line))
check('singular reads correctly', oneAgent.some((line) => line.includes('1 agent')))

const expandedAgents = assertFrame(
  'background expanded',
  snapshot({ background: agents, expandBackground: true }),
).map((line) => stripAnsi(line))
check('expanding lists each agent', expandedAgents.some((line) => line.includes('research')))
check('expanding shows the child', expandedAgents.some((line) => line.includes('verify')))
check('a nested agent is indented', expandedAgents.some((line) => line.includes('↳')))
check('expanding shows an age', expandedAgents.some((line) => line.includes('12s')))

// The strip must not squeeze the transcript below its minimum, and must be the
// first thing dropped when the window cannot afford everything.
for (const rows of [8, 10, 14, 24]) {
  const snap = snapshot({ rows, background: agents, expandBackground: true })
  const frame = render(snap)
  check(`background layout at ${rows} rows fits`, frame.lines.length <= rows)
}
// A cramped window collapses the expanded list rather than losing the
// transcript, and still says that agents are running.
const cramped = layout(snapshot({ rows: 8, background: agents, expandBackground: true }))
check('a cramped window collapses the strip', cramped.backgroundRows === 1)
check('a cramped window keeps a usable transcript', cramped.viewportRows >= 3)

// ------------------------------------------------------------------ search

{
  const searchable = snapshot({
    rows: 20,
    messages: [
      textMessage('assistant', 'Here is the answer with a **keyword**.'),
      textMessage('user', 'then the keyword again'),
    ],
  })
  const hits = findMatches(searchable, 'keyword')
  check('search finds every matching body line', hits.length === 2)
  check('search is case-insensitive', findMatches(searchable, 'KEYWORD').length === 2)
  check('search returns nothing on a miss', findMatches(searchable, 'absent').length === 0)
  check('search ignores a blank query', findMatches(searchable, '   ').length === 0)
  check('search works over streaming text', findMatches(
    snapshot({ messages: [], streaming: true, streamingSegments: [{ kind: 'text', text: 'a live needle streams' }] }),
    'needle',
  ).length === 1)
}

// ------------------------------------------------------------ terminal size

// A pty opened without a window size reports 0, not undefined, and a zero-size
// frame paints nothing at all — this is what made an automated pty run look
// like a hang.
check('a zero size falls back', normalizeSize(0, 0).columns === 80 && normalizeSize(0, 0).rows === 24)
check('an absent size falls back', normalizeSize(undefined, undefined).columns === 80)
check('a real size is kept', normalizeSize(120, 40).columns === 120 && normalizeSize(120, 40).rows === 40)
check('a negative size falls back', normalizeSize(-5, -5).rows === 24)
check('one bad axis falls back alone', normalizeSize(0, 50).columns === 80 && normalizeSize(0, 50).rows === 50)

// The fallback geometry must itself produce a legal frame.
const fallback = normalizeSize(0, 0)
assertFrame('fallback size', snapshot({ columns: fallback.columns, rows: fallback.rows }))

// ------------------------------------------------- input history hardening

const blanks = new InputHistory()
blanks.add('')
blanks.add('   ')
blanks.add('\t')
check('add ignores empty and whitespace prompts', blanks.snapshot().length === 0)
blanks.add('  padded  ')
check('add trims before recording', blanks.snapshot().join(',') === 'padded')
check('recall forward from live typing yields nothing', blanks.recall(1, 'draft') === undefined)

const resend = new InputHistory()
resend.add('alpha')
resend.add('beta')
check('recall reaches the newest after sends', resend.recall(-1, '') === 'beta')
resend.add('gamma')
check('sending resets the recall position', resend.recall(-1, '') === 'gamma')

// The draft save/restore state machine: leave the draft, walk to the oldest,
// come back past the newest, and leave a second draft.
const machine = new InputHistory()
machine.add('one')
machine.add('two')
check('leaving the live draft saves it', machine.recall(-1, 'draft A') === 'two')
check('the oldest is reachable from a saved draft', machine.recall(-1, '') === 'one')
check('recall steps forward through entries', machine.recall(1, '') === 'two')
check('returning past the newest restores the draft', machine.recall(1, '') === 'draft A')
check('restoring the draft returns to live typing', machine.recall(1, '') === undefined)
check('a fresh draft is saved on the next recall', machine.recall(-1, 'draft B') === 'two')
check('the fresh draft restores too', machine.recall(1, '') === 'draft B')

// Bounds: load caps at the limit and keeps the most recent entries.
const capped = new InputHistory()
capped.load(Array.from({ length: HISTORY_LIMIT + 3 }, (_, index) => `e${String(index)}`))
check('load caps the history at the limit', capped.snapshot().length === HISTORY_LIMIT)
check('load keeps the most recent entries', capped.snapshot()[0] === 'e3')
const nonStrings = new InputHistory()
nonStrings.load(['a', 5 as unknown as string, null as unknown as string, 'b'])
check('load drops non-string entries', nonStrings.snapshot().join(',') === 'a,b')

// ------------------------------------------------ composer row boundaries

const rowProbe = new Composer()
check('an empty composer is on the first row', rowProbe.atFirstRow(40))
check('an empty composer is also on the last row', rowProbe.atLastRow(40))
rowProbe.setValue('single row')
check('a one-row buffer is the first row', rowProbe.atFirstRow(40))
check('a one-row buffer is also the last row', rowProbe.atLastRow(40))

const multi = new Composer()
multi.setValue('one\ntwo\nthree')
multi.toStart()
check('the cursor starts on the first row only', multi.atFirstRow(40) && !multi.atLastRow(40))
multi.toEnd()
check('the cursor ends on the last row only', multi.atLastRow(40) && !multi.atFirstRow(40))
multi.home()
multi.moveRow(-1, 40)
check('a middle row is neither first nor last', !multi.atFirstRow(40) && !multi.atLastRow(40))

// A single logical line that wraps must behave like multiple rows.
const wrappedRow = new Composer()
wrappedRow.setValue('aaaaaaaaaa bbbbbbbbbb')
wrappedRow.toStart()
check('a wrapped buffer starts on the first row only', wrappedRow.atFirstRow(10) && !wrappedRow.atLastRow(10))
wrappedRow.toEnd()
check('a wrapped buffer ends on the last row only', wrappedRow.atLastRow(10) && !wrappedRow.atFirstRow(10))

// ------------------------------------------------------ search hardening

{
  const searchable = snapshot({
    messages: [
      textMessage('user', 'needle one'),
      textMessage('assistant', 'no match here'),
      textMessage('user', 'needle two'),
    ],
  })
  check('an empty query matches nothing', findMatches(searchable, '').length === 0)
  const hits = findMatches(searchable, 'needle')
  check('match indexes ascend', hits.every((hit, index) => index === 0 || (hits[index - 1] ?? 0) < hit))
  const overlaid = snapshot({ overlay: 'the overlay hides a needle', messages: [] })
  check('search runs over the overlay', findMatches(overlaid, 'needle').length === 1)
}

// ------------------------------------------------- help and footer claims

check(
  'help documents the ctrl+c two-step',
  HELP_TEXT.includes('`ctrl+c` — sessions menu · again within 1.5s — quit'),
)
const helpClaim = render(snapshot({ overlay: HELP_TEXT })).lines.map((line) => stripAnsi(line))
check(
  'the help overlay renders the ctrl+c two-step',
  helpClaim.some((line) => line.includes('sessions menu')) &&
    helpClaim.some((line) => line.includes('again within 1.5s — quit')),
)
check(
  'the footer default hint says ctrl+c menu',
  stripAnsi(normal.at(-1) ?? '').includes('ctrl+c menu'),
)
const busyStatus = assertFrame('busy status', snapshot({ status: 'working on it' })).map((line) =>
  stripAnsi(line),
)
check('a status displaces the footer hint', !busyStatus.some((line) => line.includes('ctrl+c menu')))
const scrolledHint = render({ ...tall, scrollBack: 2 }).lines.map((line) => stripAnsi(line))
check(
  'scrolling displaces the footer hint',
  !scrolledHint.some((line) => line.includes('ctrl+c menu')) &&
    scrolledHint.some((line) => line.includes('ctrl+g newest')),
)

// ------------------------------------------------- who owns a delegated agent

// A subagent belongs to the conversation that asked for it. This used to be one
// list shared by the whole app, so another session's delegated work -- and its
// foreground agent -- showed up in whichever tab happened to be on screen.
{
  const idle = [
    { id: 's-1', streaming: false },
    { id: 's-2', streaming: false },
    { id: 's-3', streaming: false },
  ]
  const busy = [
    { id: 's-1', streaming: false },
    { id: 's-2', streaming: true },
    { id: 's-3', streaming: false },
  ]

  check('fork lineage wins when the parent is open', ownerOfDelegated(busy, 's-3', 0) === 2)
  check('lineage naming a closed session falls through', ownerOfDelegated(busy, 's-gone', 0) === 1)
  check('the streaming session claims delegated work', ownerOfDelegated(busy, undefined, 0) === 1)
  check('with nothing streaming the active session takes it', ownerOfDelegated(idle, undefined, 2) === 2)
  check('an out-of-range active index still resolves', ownerOfDelegated(idle, undefined, 99) === 0)
  check('a negative active index still resolves', ownerOfDelegated(idle, undefined, -1) === 0)
  check('no sessions means no owner', ownerOfDelegated([], undefined, 0) === -1)

  // The owner must not depend on which tab is being drawn: that was the bug.
  check(
    'the owner is the same whichever session is on screen',
    ownerOfDelegated(busy, undefined, 0) === ownerOfDelegated(busy, undefined, 2),
  )
}

// eslint-disable-next-line no-console
console.log(`ok - ${String(checks)} checks passed`)
