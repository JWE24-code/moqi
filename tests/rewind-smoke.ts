/**
 * Smoke tests for rewind and fork boundaries: a fork may only inherit a
 * balanced completed-turn prefix, so these rules decide what is legal.
 */
import assert from 'node:assert/strict'
import {
  forkCut,
  lineage,
  projectUserTurns,
  rewindTarget,
  type MessageEventLike,
} from '../src/rewind.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

function userEvent(seq: number, text: string): MessageEventLike {
  return { seq, type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } }
}

// The shape a real log has: turn/start, user/message, step/start, assistant
// message, step/end, turn/end — repeated per exchange.
const LOG: MessageEventLike[] = [
  { seq: 0, type: 'turn/start' },
  userEvent(1, 'first prompt'),
  { seq: 2, type: 'step/start' },
  { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first answer' }] } } },
  { seq: 4, type: 'step/end' },
  { seq: 5, type: 'turn/end' },
  { seq: 6, type: 'turn/start' },
  userEvent(7, 'second prompt'),
  { seq: 8, type: 'step/start' },
  { seq: 9, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'second answer' }] } } },
  { seq: 10, type: 'step/end' },
  { seq: 11, type: 'turn/end' },
  { seq: 12, type: 'turn/start' },
  userEvent(13, 'third prompt — still running'),
  { seq: 14, type: 'step/start' },
]

// ------------------------------------------------------------ user turns

const turns = projectUserTurns(LOG)
check('every human prompt is projected', turns.length === 3)
check('prompt text comes through', turns[0]?.text === 'first prompt')
check('each prompt remembers its turn start', turns[1]?.turnStartSeq === 6)
check('a running prompt still has a turn start', turns[2]?.turnStartSeq === 12)
check('assistant messages are not prompts', turns.every((turn) => !turn.text.startsWith('first answer')))
check(
  'a prompt outside any turn is unrewindable',
  projectUserTurns([userEvent(0, 'orphan')])[0]?.turnStartSeq === undefined,
)
check('tool-result-only user messages are skipped', projectUserTurns([{ seq: 0, type: 'user/message' }]).length === 0)

// --------------------------------------------------------------- rewind

check('the first prompt cannot be rewound past', rewindTarget(turns, 0) === undefined)
check('the second rewinds to the start of its turn', rewindTarget(turns, 1)?.cutSeq === 6)
check('the text returns to the composer', rewindTarget(turns, 1)?.text === 'second prompt')
check('the running prompt can be rewound too', rewindTarget(turns, 2)?.cutSeq === 12)
check('an out-of-range index rewinds nothing', rewindTarget(turns, 99) === undefined)
check('a negative index rewinds nothing', rewindTarget(turns, -1) === undefined)

// ----------------------------------------------------------- fork cut

check('a fork of a settled log keeps every turn', forkCut(LOG, 12) === 12)
check('a fork with a running turn cuts back to the last turn end', forkCut(LOG, 15) === 12)
check('a log with no finished turn folds to nothing', forkCut(LOG, 5) === 0)
check('an empty log has nothing to fork', forkCut([], 0) === 0)
check('the cut never exceeds the log', forkCut(LOG, 999) === 12)

// ------------------------------------------------------------- lineage

const SESSIONS = [
  { id: 'a', title: 'root' },
  { id: 'b', title: 'fork of a', parentSession: 'a' },
  { id: 'c', title: 'fork of b', parentSession: 'b' },
  { id: 'z', title: 'unrelated' },
]
const path = lineage(SESSIONS, 'c')
check('lineage runs oldest ancestor first', path[0]?.id === 'a' && path[2]?.id === 'c')
check('lineage carries titles', path[0]?.title === 'root')
check('a root session is its own lineage', lineage(SESSIONS, 'a').length === 1)
check('an unknown session has no lineage', lineage(SESSIONS, 'nope').length === 0)
check(
  'a lineage cycle terminates',
  lineage(
    [
      { id: 'x', parentSession: 'y' },
      { id: 'y', parentSession: 'x' },
    ],
    'x',
  ).length <= 2,
)

console.log(`ok - ${String(checks)} rewind/fork checks passed`)
