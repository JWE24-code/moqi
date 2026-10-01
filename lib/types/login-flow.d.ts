/**
 * The sign-in flow: one attempt at a time, its panel, its pending prompt, and
 * what answering, declining, and withdrawing each mean.
 *
 * The controller owns the flow's state and the meaning of each interaction;
 * the app owns what drawing and status look like — everything visual arrives
 * as reactions.
 * @module
 */
import { type AuthorizationEntry, type AuthorizationInteraction } from '@deepseek-ai/dsh-authorization';
import { LoginPanel } from './tui/panels.ts';
/** The part of the Harness authorization service the flow relies on. */
export interface AuthorizationLike {
    begin(input: {
        key: string;
        method: string;
        interaction: AuthorizationInteraction;
        signal: AbortSignal;
    }): Promise<{
        status: string;
    }>;
}
/** The visuals the flow needs the app to perform on its behalf. */
export interface LoginReactions {
    /** Mount the flow's panel, or `undefined` to clear it. */
    mount(panel: LoginPanel | undefined): void;
    status(text: string, isError?: boolean): void;
    repaint(): void;
    /** Copy to the local clipboard; the flow phrases the outcome in its status. */
    clipboard(url: string): boolean;
    /** Open the method picker for a multi-method entry. */
    offerMethods(entry: AuthorizationEntry): void;
}
export declare class LoginFlow {
    private readonly resolveAuth;
    private readonly react;
    private panel;
    private pendingPrompt;
    private abort;
    private pendingEntry;
    constructor(resolveAuth: () => AuthorizationLike | undefined, react: LoginReactions);
    /** `enter` on the `/providers` list: a single-method flow starts right away,
     * one offering a choice of methods opens a second, small picker for it first.
     */
    chooseEntry(entries: readonly AuthorizationEntry[], id: string): void;
    /** `enter` on the method picker a multi-method flow opened. */
    beginWithMethod(methodId: string): void;
    /** Answer the live prompt. `false` when no question is waiting. */
    answer(value: string): boolean;
    /**
     * Decline the live prompt the way a human's `esc` does. `false` when no
     * question is waiting — the caller should withdraw the attempt instead.
     */
    decline(): boolean;
    /**
     * Withdraw the whole attempt. `begin()` still has to settle asynchronously,
     * so the panel closes once that promise resolves, not here.
     */
    withdraw(): void;
    /**
     * Run one `ctx.authorization` attempt, surfacing it as a panel.
     *
     * The panel and the flow's own pending-prompt bookkeeping are the split
     * the approval and question panels already keep: the panel is pure view
     * state, and answering a live question is the flow's job, because that is
     * the one part that actually talks to the Harness.
     */
    begin(entry: AuthorizationEntry, method: string): void;
    private settle;
}
