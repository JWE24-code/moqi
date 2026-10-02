/**
 * Session listing for pickers and `/tree`.
 *
 * The query service's row shape is probed rather than assumed: an rc that
 * names a field differently still yields a list, just without the niceties.
 * Nothing here touches the app state — every function takes what it reads.
 * @module
 */
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { textMessage, type Message, type PickerItem } from './tui/state.ts'

/** The shape of the harness session-query service this build can rely on. */
export interface SessionQueryLike {
  listSessions?: (options?: unknown) => unknown
  list?: (options?: unknown) => unknown
  querySessions?: (options?: unknown) => unknown
}

/** A compact "3h ago" label for the picker's right column. */
function relativeTime(epochMillis: number): string {
  const seconds = Math.max(Math.floor((Date.now() - epochMillis) / 1000), 0)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

/**
 * List sessions through whichever method this build of the query service
 * exposes. The service is documented as providing "filtered lists"; probing
 * keeps the app working across the rc releases rather than pinning one name.
 */
/** The rows a query answered with: an array, or wrapped in `{ items }`. */
function rowsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  const wrapped = raw as { items?: unknown }
  return Array.isArray(wrapped?.items) ? (wrapped.items as unknown[]) : []
}

export async function listSessions(query: SessionQueryLike): Promise<PickerItem[]> {
  const method = query.listSessions ?? query.list ?? query.querySessions
  if (method === undefined) return []
  const raw = await method.call(query, undefined)
  const rows = rowsOf(raw)
  return rows.slice(0, 200).map((row) => {
    const record = row as Record<string, unknown>
    // The corpus rows are `{ header, live, persisted }` with id and createdAt
    // nested inside `header`; search-shaped rows carry them flat. Read both.
    const header = (record['header'] ?? {}) as Record<string, unknown>
    const id = String(record['sessionId'] ?? record['id'] ?? header['id'] ?? '')
    const title = String(record['title'] ?? record['summary'] ?? '') || id
    const when = record['updatedAt'] ?? record['createdAt'] ?? header['createdAt']
    const subtitle = typeof when === 'number' ? relativeTime(when) : ''
    return { id, title, subtitle }
  }).filter((item) => item.id !== '')
}

/**
 * Rebuild the transcript from a session's durable log. Only user and assistant
 * text is projected; everything else the log carries belongs to other surfaces.
 */
export function readHistory(session: Session): Message[] {
  const out: Message[] = []
  const length = session.seq
  for (let seq = 0; seq < length; seq += 1) {
    const event = session.eventAt(SessionSeq(seq)) as
      | { type?: string; data?: Record<string, unknown> }
      | undefined
    if (event === undefined) continue
    const message = (event.data as { message?: { content?: unknown[] } } | undefined)?.message
    const blocks = Array.isArray(message?.content) ? message.content : []
    const text = blocks
      .filter((block): block is { type: string; text: string } => {
        const candidate = block as { type?: unknown; text?: unknown }
        return candidate.type === 'text' && typeof candidate.text === 'string'
      })
      .map((block) => block.text)
      .join('')
    if (text === '') continue
    if (event.type === 'assistant/message') out.push(textMessage('assistant', text))
    else if (event.type === 'user/message') out.push(textMessage('user', text))
  }
  return out
}

/**
 * The session log as the rewind/fork rules want it: every event with the seq
 * that indexes it, since a log is contiguous from 0.
 */
export function sessionEvents(session: Session): { seq: number; type: string }[] {
  return session
    .snapshotEvents(SessionLogOffset(0), session.seq)
    .map((event, seq) => ({ seq, type: String((event as { type?: unknown }).type ?? '') }))
}

/** A session's fork parent, when its header records one. */
export function parentOf(session: Session | undefined): string | undefined {
  const parent = session?.header.parentSession
  return parent === undefined ? undefined : String(parent)
}

/**
 * Session rows with their fork parent, for `/tree`.
 *
 * The query service's row shape is probed rather than assumed: an rc that
 * names the field differently still yields a tree, just without lineage.
 */
export async function listSessionsWithParents(
  query: SessionQueryLike,
): Promise<{ id: string; title?: string; parentSession?: string }[]> {
  const method = query.listSessions ?? query.list ?? query.querySessions
  if (method === undefined) return []
  const raw = await method.call(query, undefined)
  const rows = rowsOf(raw)
  return rows.slice(0, 500).map((row) => {
    const record = row as Record<string, unknown>
    // Same nested `header` shape as listSessions above.
    const header = (record['header'] ?? {}) as Record<string, unknown>
    const parent = record['parentSession'] ?? record['parent'] ?? header['parentSession']
    return {
      id: String(record['sessionId'] ?? record['id'] ?? header['id'] ?? ''),
      title: typeof record['title'] === 'string' ? record['title'] : undefined,
      parentSession: parent === undefined || parent === null ? undefined : String(parent),
    }
  }).filter((row) => row.id !== '')
}
