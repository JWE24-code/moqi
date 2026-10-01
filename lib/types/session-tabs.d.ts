/**
 * The open-session strip: the tabs array, which one is active, and the rules
 * that govern them.
 *
 * Owned here so the rules live in one testable place. A turn finishing in a
 * session you are not looking at leaves it `ready` and rings the bell; a
 * session you are already looking at is marked seen instead; the last session
 * cannot be closed. What the app does in reaction — paint, status text,
 * persistence — stays at the app's edge.
 * @module
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionStatus } from './tui/state.ts';
/** The parts of a session tab that the strip's rules touch. */
export interface TabLike {
    id: string;
    title: string;
    agent: Agent | undefined;
    status: SessionStatus;
}
export declare class SessionTabs<T extends TabLike> {
    tabs: T[];
    active: number;
    private readonly bellEnabled;
    constructor(tabs: T[], options?: {
        bell?: boolean;
    });
    /** The tab bar's view of the open sessions. */
    summaries(): {
        id: string;
        title: string;
        status: SessionStatus;
        active: boolean;
    }[];
    /** Find the session that owns an agent, if any. */
    forAgent(agent: Agent): T | undefined;
    /** The tab currently on screen. */
    current(): T | undefined;
    /**
     * Move a session to a new status, ringing the bell when it becomes `ready`.
     *
     * `ready` is the only state worth a sound: a turn finished and its answer is
     * waiting. A session you are already looking at is marked seen instead, so
     * the bar does not nag about a reply on screen.
     */
    setStatus(tab: T, status: SessionStatus): void;
    /** Sound the terminal bell, unless it has been turned off. */
    ring(): void;
    /** Append a new session and make it active. */
    append(tab: T): void;
    /** Replace the whole strip (the restore path), activating `active`. */
    replaceAll(tabs: T[], active: number): void;
    /** Switch the view to another session, marking it seen. */
    select(index: number): T | undefined;
    /**
     * Close the session at `index`, keeping at least one open.
     *
     * @returns the closed tab, or `undefined` when it was the last session.
     */
    remove(index: number): {
        closed: T;
    } | undefined;
}
