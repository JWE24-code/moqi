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
/** The event shape the projections read; the parts they touch, nothing else. */
export type MessageEventLike = {
    type?: string;
    data?: unknown;
};
/**
 * The joined text of a message event's content, or `''` when it has none.
 * Only text blocks count: images and tool payloads belong to other surfaces.
 */
export declare function messageTextOf(event: MessageEventLike): string;
/**
 * The text of a plugin notice — a `user/message` whose source carries
 * `form: 'notice'` — or `undefined` when the event is not one. Notices are how
 * local plugins (the PII shield, for one) tell the user something was
 * rewritten on the way in. They land in the session log, so both the live
 * transcript and a restored one read them from here.
 */
export declare function noticeTextOf(event: MessageEventLike): string | undefined;
