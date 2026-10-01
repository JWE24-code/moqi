/**
 * The sign-in flow: one attempt at a time, its panel, its pending prompt, and
 * what answering, declining, and withdrawing each mean.
 *
 * The controller owns the flow's state and the meaning of each interaction;
 * the app owns what drawing and status look like — everything visual arrives
 * as reactions.
 * @module
 */
import { AuthorizationDeclinedError, } from '@deepseek-ai/dsh-authorization';
import { LoginPanel } from "./tui/panels.js";
import { describeError } from "./local-platform.js";
import { toLoginPrompt } from "./tui-adapt.js";
export class LoginFlow {
    resolveAuth;
    react;
    panel;
    pendingPrompt;
    abort;
    pendingEntry;
    constructor(resolveAuth, react) {
        this.resolveAuth = resolveAuth;
        this.react = react;
    }
    /** `enter` on the `/providers` list: a single-method flow starts right away,
     * one offering a choice of methods opens a second, small picker for it first.
     */
    chooseEntry(entries, id) {
        const entry = entries[Number.parseInt(id, 10)];
        if (entry === undefined)
            return;
        const [firstMethod] = entry.methods;
        if (entry.methods.length === 1 && firstMethod !== undefined) {
            this.begin(entry, firstMethod.id);
            return;
        }
        this.pendingEntry = entry;
        this.react.offerMethods(entry);
    }
    /** `enter` on the method picker a multi-method flow opened. */
    beginWithMethod(methodId) {
        const entry = this.pendingEntry;
        this.pendingEntry = undefined;
        if (entry !== undefined)
            this.begin(entry, methodId);
    }
    /** Answer the live prompt. `false` when no question is waiting. */
    answer(value) {
        const pending = this.pendingPrompt;
        if (pending === undefined)
            return false;
        this.pendingPrompt = undefined;
        pending.resolve(value);
        return true;
    }
    /**
     * Decline the live prompt the way a human's `esc` does. `false` when no
     * question is waiting — the caller should withdraw the attempt instead.
     */
    decline() {
        const pending = this.pendingPrompt;
        if (pending === undefined)
            return false;
        this.pendingPrompt = undefined;
        pending.reject(new AuthorizationDeclinedError());
        return true;
    }
    /**
     * Withdraw the whole attempt. `begin()` still has to settle asynchronously,
     * so the panel closes once that promise resolves, not here.
     */
    withdraw() {
        this.abort?.abort();
    }
    /**
     * Run one `ctx.authorization` attempt, surfacing it as a panel.
     *
     * The panel and the flow's own pending-prompt bookkeeping are the split
     * the approval and question panels already keep: the panel is pure view
     * state, and answering a live question is the flow's job, because that is
     * the one part that actually talks to the Harness.
     */
    begin(entry, method) {
        const auth = this.resolveAuth();
        if (auth === undefined)
            return;
        const controller = new AbortController();
        const login = new LoginPanel(entry.label);
        this.panel = login;
        this.abort = controller;
        this.react.mount(login);
        this.react.status('');
        this.react.repaint();
        const interaction = {
            notify: (notice) => {
                if (this.panel !== login)
                    return;
                login.notice = notice;
                // The page is on the clipboard the moment it is known, not only once
                // `enter` asks to open it — the browser to actually use it in may not
                // be reachable from wherever this terminal is (an SSH session, say),
                // and pasting it there is the fallback `enter` cannot offer.
                if (notice.url !== undefined) {
                    const ok = this.react.clipboard(notice.url);
                    this.react.status(ok ? `page copied — ${notice.url}` : notice.url);
                }
                this.react.repaint();
            },
            prompt: (prompt) => new Promise((resolve, reject) => {
                if (this.panel !== login) {
                    reject(new Error('the sign-in surface is gone'));
                    return;
                }
                login.setPrompt(toLoginPrompt(prompt));
                const pending = { resolve, reject };
                this.pendingPrompt = pending;
                this.react.repaint();
                // A flow racing a typed code against a browser callback withdraws
                // only the losing prompt this way, leaving the attempt running —
                // this is the browser callback winning, not a human saying no, and
                // must not reject with AuthorizationDeclinedError: that class means
                // specifically "the human declined," and a flow that reads it that
                // way discards the credential it just got through the browser
                // instead of finishing the commit. A plain rejection is what the
                // contract asks for here.
                prompt.signal?.addEventListener('abort', () => {
                    if (this.pendingPrompt !== pending)
                        return;
                    this.pendingPrompt = undefined;
                    if (this.panel === login)
                        login.setPrompt(undefined);
                    reject(new Error('prompt withdrawn — its own signal aborted'));
                    this.react.repaint();
                });
            }),
        };
        auth
            .begin({ key: entry.key, method, interaction, signal: controller.signal })
            .then((outcome) => {
            this.settle();
            this.react.status(outcome.status === 'authorized'
                ? `signed in — ${entry.label}`
                : `sign-in cancelled — ${entry.label}`, outcome.status !== 'authorized');
            this.react.repaint();
        })
            .catch((error) => {
            this.settle();
            this.react.status(describeError(error), true);
            this.react.repaint();
        });
    }
    settle() {
        this.panel = undefined;
        this.abort = undefined;
        this.pendingPrompt = undefined;
        this.react.mount(undefined);
    }
}
