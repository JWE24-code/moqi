/**
 * Smoke tests for `toQuestionSpec`: the Harness question → questions-panel
 * adapter. dsh 0.2.2 added the `approval` intent; the panel renders only
 * `plan-review`, so anything else must fall back to the generic option list
 * and stay answerable by its labels.
 */
import assert from 'node:assert/strict'
import { toQuestionSpec } from '../src/tui/panels.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

const plain = toQuestionSpec({ id: 'q1', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] })
check('a question without intent passes through', plain.intent === undefined && plain.options?.length === 2)

const plan = toQuestionSpec({
  id: 'q2',
  question: 'Approve the plan?',
  options: [{ label: 'Approve' }, { label: 'Keep planning' }],
  intent: { kind: 'plan-review', approve: 'Approve' },
})
check('plan-review keeps its intent', plan.intent?.kind === 'plan-review' && plan.intent.approve === 'Approve')

const bare = toQuestionSpec({
  id: 'q3',
  question: 'Allow bash?',
  intent: { kind: 'approval', approve: 'Allow once', reject: 'Deny', always: 'Always allow' },
})
check('approval drops the intent the panel does not know', bare.intent === undefined)
check(
  'approval without options gets its labels as options',
  JSON.stringify(bare.options?.map((option) => option.label)) === JSON.stringify(['Allow once', 'Always allow', 'Deny']),
)

const noAlways = toQuestionSpec({ id: 'q4', question: 'Allow?', intent: { kind: 'approval', approve: 'Yes', reject: 'No' } })
check('approval without always offers approve and reject', noAlways.options?.length === 2)

const listed = toQuestionSpec({
  id: 'q5',
  question: 'Allow?',
  options: [{ label: 'Yes' }, { label: 'No' }],
  intent: { kind: 'approval', approve: 'Yes', reject: 'No' },
})
check('approval with its own options keeps them', listed.options?.length === 2 && listed.intent === undefined)

console.log(`ok - ${String(checks)} question-spec checks passed`)
