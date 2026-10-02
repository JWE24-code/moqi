/**
 * Tool-detail smoke: what a call says about itself, and what came back.
 *
 * Dependency-free like the other suites — `describeToolCall` and
 * `summarizeResult` are pure functions over strings, and `applyToolEvent`
 * folds plain session-log records onto live rows, so the feedback-in-flow
 * path is covered without a Harness runtime.
 */

import assert from 'node:assert/strict'

import type { ToolActivity } from '../src/tui/state.ts'
import { applyToolEvent, describeToolCall, summarizeResult } from '../src/tui/tooldetail.ts'

let checks = 0
function check(name: string, condition: boolean): void {
  assert.ok(condition, name)
  checks += 1
}

// ------------------------------------------------- what a call does

check('a command argument becomes the detail', describeToolCall('bash', '{"command":"docker ps"}') === 'docker ps')
check(
  'a file path becomes the detail',
  describeToolCall('str-replace-editor', '{"file_path":"/etc/hosts"}') === '/etc/hosts',
)
check('a query becomes the detail', describeToolCall('web_search', '{"query":"pty test"}') === 'pty test')
check(
  'the first string speaks when no known key fits',
  describeToolCall('odd-tool', '{"alpha":"first","beta":"second"}') === 'first',
)
check(
  'whitespace folds to one line',
  describeToolCall('bash', String.raw`{"command":"a\n  b\t\tc"}`) === 'a b c',
)
check('unparsable arguments pass through as one line', describeToolCall('bash', 'docker ps') === 'docker ps')
check('empty arguments say nothing', describeToolCall('bash', '{}') === '')
check('undefined arguments say nothing', describeToolCall('bash', undefined) === '')
check(
  'a long command is bounded in storage',
  describeToolCall('bash', `{"command":"${'x'.repeat(400)}"}`).length === 200,
)

// ------------------------------------------------- what came back

check(
  'text blocks fold into one line',
  summarizeResult([{ text: 'webui' }, { text: 'postgres\nup' }]) === 'webui postgres up',
)
check('no text and no error says nothing', summarizeResult([{ type: 'image' }]) === undefined)
check(
  'an error identity speaks when the content does not',
  summarizeResult([], { name: 'ExitError', code: '1' }) === 'ExitError 1',
)

// ------------------------------------------------- events onto live rows

const rows: ToolActivity[] = [{ id: 'call-1', name: 'bash', status: 'running' }]

applyToolEvent(rows, {
  type: 'tool/call',
  data: { callId: 'call-1', name: 'bash', arguments: '{"command":"docker ps"}' },
})
check("a tool/call fills its row's detail", rows[0]?.detail === 'docker ps')

applyToolEvent(rows, {
  type: 'tool/call',
  data: { callId: 'call-9', name: 'grep', arguments: '{"pattern":"x"}' },
})
check('a call from another turn adds no row', rows.length === 1)

applyToolEvent(rows, {
  type: 'tool/result',
  data: {
    message: { content: [{ toolCallId: 'call-1', content: [{ text: 'webui\npostgres' }] }] },
  },
})
check('a tool/result settles its row ok', rows[0]?.status === 'ok')
check('a tool/result attaches its outcome to the row', rows[0]?.result === 'webui postgres')

applyToolEvent(rows, {
  type: 'tool/result',
  data: {
    message: { content: [{ toolCallId: 'call-1', isError: true, content: [] }] },
    error: { name: 'ExitError', code: '127' },
  },
})
check('an errored result marks the row', rows[0]?.status === 'error')
check('an errored result still speaks', rows[0]?.result === 'ExitError 127')

applyToolEvent(rows, { type: 'user/message', data: { message: {} } })
check('unrelated events change nothing', rows.length === 1 && rows[0]?.status === 'error')

console.log(`ok - ${checks} tool-detail checks passed`)
