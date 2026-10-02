/**
 * Rewind and fork arithmetic over a session log.
 *
 * A fork must be a *balanced completed-turn prefix*: contiguous from seq 0,
 * ending between turns, with no open turn, step, or dangling tool call. This
 * module finds those boundaries from the event types alone, so the rules are
 * testable without a live session.
 * @module
 */

/** The little bit of an event this module needs, plus its message payload. */
export interface MessageEventLike extends LogEventLike {
  data?: { message?: { content?: unknown } }
}

/** The little bit of an event this module needs. */
export interface LogEventLike {
  seq: number
  type: string
}

/** One human prompt in the log, with the turn it opened. */
export interface UserTurn {
  /** Seq of the `user/message` event. */
  seq: number
  /** The prompt text, for the picker. */
  text: string
  /** Seq of the `turn/start` that opened the containing turn. */
  turnStartSeq: number | undefined
}

/** Text of one model-visible message event, or `''` when it carries none. */
function textOf(event: MessageEventLike): string {
  const blocks = event.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block): block is { type: string; text: string } => {
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string'
    })
    .map((block) => block.text)
    .join('')
}

/**
 * Every human prompt in log order, each remembering the turn that carried it.
 *
 * A `user/message` outside any turn (a resumed or repaired log) keeps
 * `turnStartSeq: undefined`, which makes it unrewindable rather than guessed.
 */
export function projectUserTurns(events: readonly MessageEventLike[]): UserTurn[] {
  const turns: UserTurn[] = []
  let currentTurnStart: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') currentTurnStart = event.seq
    else if (event.type === 'user/message') {
      const text = textOf(event)
      if (text.trim() !== '') turns.push({ seq: event.seq, text, turnStartSeq: currentTurnStart })
    }
  }
  return turns
}

/**
 * Where to cut the log to rewind to a chosen prompt.
 *
 * Rewinding means "take me back to just before this prompt was sent", so the
 * cut is the start of the turn that contains it — everything before that turn
 * is the seed, and the prompt itself returns to the composer.
 *
 * @returns the exclusive cut offset and the prompt text, or `undefined` when
 *   the rewind is impossible: no turn boundary, or the boundary is the very
 *   start of the log (rewinding past the first message leaves nothing).
 */
export function rewindTarget(
  turns: readonly UserTurn[],
  chosenIndex: number,
): { cutSeq: number; text: string } | undefined {
  const turn = turns[chosenIndex]
  if (turn?.turnStartSeq === undefined) return undefined
  if (turn.turnStartSeq <= 0) return undefined
  return { cutSeq: turn.turnStartSeq, text: turn.text }
}

/**
 * The exclusive cut offset for a full fork: after the last completed turn.
 *
 * A fork of an idle session keeps every completed turn; a log with an open
 * turn at the end is cut back to the last `turn/end`, because a fork may not
 * inherit a half-finished turn.
 *
 * @returns the exclusive offset, or 0 when there is no completed turn yet.
 */
export function forkCut(events: readonly LogEventLike[], endSeq: number): number {
  for (let index = Math.min(endSeq, events.length) - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') return index + 1
  }
  return 0
}

/**
 * The lineage of a session id inside a set of known sessions, oldest ancestor
 * first, for `/tree`.
 */
export function lineage(
  sessions: readonly { id: string; parentSession?: string; title?: string }[],
  id: string,
): { id: string; title?: string }[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const path: { id: string; title?: string }[] = []
  let current = byId.get(id)
  const seen = new Set<string>()
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift({ id: current.id, title: current.title })
    const parent = current.parentSession
    current = parent === undefined ? undefined : byId.get(parent)
  }
  return path
}
