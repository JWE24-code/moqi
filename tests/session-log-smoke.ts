/**
 * Smoke tests for the pure session-log projections in `session-log.ts`: the
 * two message-event shapes the log writes, and the plugin notices that ride in
 * `user/message` events. Framework-free on purpose — the Harness-touching
 * consumers (`readHistory`, the live transcript sync) are thin folds over
 * these rules.
 */
import assert from 'node:assert/strict'
import { messageTextOf, noticeTextOf, type MessageEventLike } from '../src/session-log.ts'

let checks = 0
function check(label: string, condition: boolean): void {
  assert.ok(condition, label)
  checks += 1
}

// The shapes a real log carries: `user/message` writes the message flat in
// `data`, assistant and tool events nest it under `data.message`.
const userFlat: MessageEventLike = {
  type: 'user/message',
  data: {
    content: [{ type: 'text', text: 'mijn iban is BE68 …' }],
    source: { kind: 'user' },
    role: 'user',
    id: 'u1',
  },
}
const noticeFlat: MessageEventLike = {
  type: 'user/message',
  data: {
    content: [{ type: 'text', text: '🔒 PII shield: 1 item(s) anonymized locally (1 IBAN).' }],
    source: { kind: 'plugin', plugin: 'pii-anonymizer', form: 'notice', summary: '🔒' },
    role: 'user',
    id: 'n1',
  },
}
const noticeWrapped: MessageEventLike = {
  type: 'user/message',
  data: {
    message: {
      content: [{ type: 'text', text: '🔒 wrapped-shape notice' }],
      source: { kind: 'plugin', form: 'notice' },
      role: 'user',
      id: 'n2',
    },
  },
}
const assistantWrapped: MessageEventLike = {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: 'antwoord' }] } },
}

// ------------------------------------------------------------ messageTextOf

check('a flat user message yields its text', messageTextOf(userFlat) === 'mijn iban is BE68 …')
check('a wrapped assistant message yields its text', messageTextOf(assistantWrapped) === 'antwoord')
check('a flat notice yields its text', messageTextOf(noticeFlat) === '🔒 PII shield: 1 item(s) anonymized locally (1 IBAN).')
check('a non-message event yields no text', messageTextOf({ type: 'turn/start' }) === '')
check('an event without data yields no text', messageTextOf({}) === '')
check(
  'non-text blocks are not text',
  messageTextOf({
    type: 'user/message',
    data: { content: [{ type: 'image', url: 'x' }, { type: 'text', text: 'tekst' }] },
  }) === 'tekst',
)

// ------------------------------------------------------------ noticeTextOf

check('a flat plugin notice is a notice', noticeTextOf(noticeFlat) === '🔒 PII shield: 1 item(s) anonymized locally (1 IBAN).')
check('a wrapped plugin notice is a notice', noticeTextOf(noticeWrapped) === '🔒 wrapped-shape notice')
check('a plain user message is not a notice', noticeTextOf(userFlat) === undefined)
check('an assistant event is not a notice', noticeTextOf(assistantWrapped) === undefined)
check('a non-message event is not a notice', noticeTextOf({ type: 'turn/start' }) === undefined)
check(
  'a notice without text yields undefined',
  noticeTextOf({
    type: 'user/message',
    data: { content: [], source: { kind: 'plugin', form: 'notice' } },
  }) === undefined,
)
check(
  'a plugin message that is not a form of notice is skipped',
  noticeTextOf({
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', form: 'snapshot' } },
  }) === undefined,
)

console.log(`session-log-smoke: ${String(checks)} checks ok`)
