/**
 * Smoke tests for transcript selection: the pure cursor rule and the gold bar
 * the renderer draws on the selected turn.
 */
import assert from 'node:assert/strict'
import { Composer, moveSelection, Palette, Picker, textMessage } from '../src/tui/state.ts'
import { displayWidth } from '../src/tui/text.ts'
import { render, type Snapshot } from '../src/tui/view.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

// ------------------------------------------------------------- the rule

check('nothing is selectable in an empty transcript', moveSelection(undefined, 1, 0) === undefined)
check('the first move lands on the newest turn', moveSelection(undefined, -1, 5) === 4)
check('moving up walks towards older turns', moveSelection(4, -1, 5) === 3)
check('moving down walks back to the newest', moveSelection(3, 1, 5) === 4)
check('the top clamps', moveSelection(0, -1, 5) === 0)
check('the bottom clamps', moveSelection(4, 1, 5) === 4)
check('a jump beyond the end clamps', moveSelection(1, 99, 5) === 4)
check('a jump before the start clamps', moveSelection(1, -99, 5) === 0)

// ------------------------------------------------------------ the render

function base(): Snapshot {
  return {
    columns: 80,
    rows: 24,
    title: 't',
    host: 'local harness',
    modelName: 'deepseek-chat',
    messages: [
      textMessage('user', 'first question'),
      textMessage('assistant', 'first answer'),
      textMessage('user', 'second question'),
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
    expandTools: true,
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
}

const plain = render(base()).lines
check('no selection means no gold bar', !plain.some((line) => line.includes('▏')))
const marked = render({ ...base(), selectedTurn: 1 }).lines
check('a selection draws the bar', marked.some((line) => line.includes('▏')))
const twoLine = render({
  ...base(),
  messages: [textMessage('assistant', 'line one\n\nline two')],
  selectedTurn: 0,
}).lines
check(
  'every rendered line of the selected turn carries the bar',
  twoLine.filter((line) => line.includes('line one') || line.includes('line two')).every((line) => line.includes('▏')) &&
    twoLine.filter((line) => !line.includes('▏') && (line.includes('line one') || line.includes('line two'))).length === 0,
)
check('the window is still respected', marked.every((line) => displayWidth(line) <= 81))
check('selection keeps the composer cursor visible', render({ ...base(), selectedTurn: 2 }).cursor !== undefined)

console.log(`ok - ${String(checks)} selection checks passed`)
