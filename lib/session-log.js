/**
 * Pure projections over session-log events — framework-free on purpose.
 *
 * The log writes message events in two shapes: `user/message` carries the
 * message flat in `data`, while assistant, system, and tool events nest it
 * under `data.message`. Every projection here reads through that difference,
 * so an old and a new log render the same. This module imports nothing from
 * the Harness, which is what lets its suite run from a bare `npm ci` — the
 * same split as the tuiHost seam.
 *
 * @module
 */
/**
 * The body of a message event, whichever of the two shapes the log carries:
 * `user/message` writes the message flat in `data`, the other message events
 * nest it under `data.message`.
 */
function messageBodyOf(event) {
    const data = event.data;
    if (data === undefined)
        return undefined;
    const nested = data['message'];
    if (typeof nested === 'object' && nested !== null)
        return nested;
    return data;
}
/**
 * The joined text of a message event's content, or `''` when it has none.
 * Only text blocks count: images and tool payloads belong to other surfaces.
 */
export function messageTextOf(event) {
    const content = messageBodyOf(event)?.['content'];
    const blocks = Array.isArray(content) ? content : [];
    return blocks
        .filter((block) => {
        const candidate = block;
        return candidate.type === 'text' && typeof candidate.text === 'string';
    })
        .map((block) => block.text)
        .join('');
}
/**
 * The text of a plugin notice — a `user/message` whose source carries
 * `form: 'notice'` — or `undefined` when the event is not one. Notices are how
 * local plugins (the PII shield, for one) tell the user something was
 * rewritten on the way in. They land in the session log, so both the live
 * transcript and a restored one read them from here.
 */
export function noticeTextOf(event) {
    if (event.type !== 'user/message')
        return undefined;
    const source = messageBodyOf(event)?.['source'];
    if (source?.kind !== 'plugin' || source?.form !== 'notice')
        return undefined;
    const text = messageTextOf(event);
    return text === '' ? undefined : text;
}
