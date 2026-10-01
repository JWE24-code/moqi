import type { Session } from '@deepseek-ai/dsh-session';
import { type Message, type PickerItem } from './tui/state.ts';
/** The shape of the harness session-query service this build can rely on. */
export interface SessionQueryLike {
    listSessions?: (options?: unknown) => Promise<unknown> | unknown;
    list?: (options?: unknown) => Promise<unknown> | unknown;
    querySessions?: (options?: unknown) => Promise<unknown> | unknown;
}
/**
 * List sessions through whichever method this build of the query service
 * exposes. The service is documented as providing "filtered lists"; probing
 * keeps the app working across the rc releases rather than pinning one name.
 */
export declare function listSessions(query: SessionQueryLike): Promise<PickerItem[]>;
/**
 * Rebuild the transcript from a session's durable log. Only user and assistant
 * text is projected; everything else the log carries belongs to other surfaces.
 */
export declare function readHistory(session: Session): Message[];
/**
 * The session log as the rewind/fork rules want it: every event with the seq
 * that indexes it, since a log is contiguous from 0.
 */
export declare function sessionEvents(session: Session): {
    seq: number;
    type: string;
}[];
/** A session's fork parent, when its header records one. */
export declare function parentOf(session: Session | undefined): string | undefined;
/**
 * Session rows with their fork parent, for `/tree`.
 *
 * The query service's row shape is probed rather than assumed: an rc that
 * names the field differently still yields a tree, just without lineage.
 */
export declare function listSessionsWithParents(query: SessionQueryLike): Promise<{
    id: string;
    title?: string;
    parentSession?: string;
}[]>;
