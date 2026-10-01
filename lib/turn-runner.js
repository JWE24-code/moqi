/**
 * The turn lifecycle: send a prompt to a session's agent, stream the reply,
 * settle the tab, and decide whether the queue drains.
 *
 * The runner owns the sequence and its rules — the first-prompt title, the
 * running/ready transitions, attribution of a turn's billed spend to the
 * provider that answered, the interrupt-vs-redirection queue decision. The
 * app owns everything visible: status lines, paint, spinners, scroll, and
 * persistence timing, all supplied as the {@link TurnHost}.
 * @module
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { queueShouldDrain, textMessage, } from "./tui/state.js";
import { promptBlocks } from "./tui-adapt.js";
import { describeError } from "./local-platform.js";
export class TurnRunner {
    host;
    constructor(host) {
        this.host = host;
    }
    /** Send a prompt to the active session. */
    send(tab, text) {
        return this.run(tab, { text, images: [] }, false);
    }
    /** Send a materialized prompt to one specific session and stream the reply. */
    run(tab, prompt, fromQueue = false) {
        return this.sendTo(tab, prompt, fromQueue);
    }
    /**
     * Send a prompt to one specific session and stream the reply.
     *
     * `fromQueue` marks a prompt that was already recorded in the composer
     * history at the moment it was queued, so the drain must not record it a
     * second time (recall would then surface it twice).
     */
    async sendTo(tab, prompt, fromQueue) {
        const agent = tab.agent;
        if (agent === undefined)
            return;
        const text = prompt.text;
        this.host.clearOverlay();
        // Only follow the newest output when the queued conversation is the one
        // on screen; a backgrounded session must not yank the view around.
        if (this.host.isForeground(tab))
            this.host.followOutput();
        if (!fromQueue) {
            this.host.rememberPrompt(text);
        }
        tab.messages.push(textMessage('user', text, {
            attachments: prompt.images.length === 0
                ? undefined
                : prompt.images.map((ref) => ({
                    name: ref.name ?? 'image',
                    width: ref.width,
                    height: ref.height,
                })),
        }));
        if (tab.title === '') {
            tab.title = text.slice(0, 60);
            // A tab restored with no title reads as "new session" in the bar, which
            // is exactly the wrong label for a conversation that already has one.
            this.host.persist();
        }
        tab.streaming = true;
        tab.streamStartedAt = Date.now();
        tab.turnStartTokens = tab.completionTokens;
        tab.drainQueue = false;
        tab.streamingSegments = [];
        tab.streamingReasoning = '';
        // Tool results land in the session log between model streams, where no
        // frame fires; the sync reads them from here on. Events before this point
        // belong to earlier turns and must not color this one's rows.
        tab.logSyncedSeq = tab.agent === undefined ? 0 : tab.agent.session.seq;
        this.host.sessionStatus(tab, 'running');
        this.host.status('');
        if (tab.queued.length > 0) {
            // More still waiting behind this one: say so, or the queue silently
            // draining looks like prompts disappearing.
            this.host.status(`${String(tab.queued.length)} queued — sends when the reply finishes`);
        }
        this.host.spinner(true);
        this.host.repaint();
        const abort = new AbortController();
        this.host.setAbort(abort);
        try {
            agent.followup(createUserMessage({ content: promptBlocks(prompt), source: { kind: 'user' } }));
            await agent.whenIdle();
        }
        catch (error) {
            this.host.status(describeError(error), true);
        }
        finally {
            this.host.setAbort(undefined);
            const turnSeconds = (Date.now() - tab.streamStartedAt) / 1000;
            const turnOutput = tab.completionTokens - tab.turnStartTokens;
            tab.tps = turnSeconds > 0 && turnOutput > 0 ? turnOutput / turnSeconds : 0;
            // Attribute this turn's own spend to whichever provider actually
            // answered it — `assembled` is what prompt assembly captured for the
            // request just settled, which stays correct even though `current`
            // already points at a switch queued for the next turn.
            const provider = tab.selection.assembled?.provider ?? tab.selection.current?.provider ?? '';
            this.host.foldUsage(tab, provider);
            this.host.persist();
            tab.streaming = false;
            tab.streamStartedAt = 0;
            this.host.spinner(false);
            // Commit whatever streamed, even on an interrupt, so nothing is lost.
            // One last log sync first: the final tool results may have landed after
            // the last frame, and the committed rows are what /export and a restart
            // will show.
            this.host.syncToolLog(tab);
            const reasoning = tab.streamingReasoning.trim();
            // The turn commits with its order intact — the same segments that were
            // on screen while it streamed, so nothing rearranges itself once it
            // settles.
            const segments = tab.streamingSegments.filter((segment) => segment.kind === 'tool' || segment.text.trim() !== '');
            if (segments.length > 0 || reasoning !== '') {
                tab.messages.push({
                    role: 'assistant',
                    segments,
                    reasoning: reasoning === '' ? undefined : reasoning,
                });
            }
            tab.streamingSegments = [];
            tab.streamingReasoning = '';
            // The answer is in: ring unless it is already on screen.
            this.host.sessionStatus(tab, 'ready');
            void this.host.flush(tab);
            // An interrupted turn must not launch the next prompt unbidden: the
            // user asked for silence, so the queue waits for a clean finish —
            // unless the interrupt was the redirection kind (`/interrupt`), which
            // stops this answer precisely so the queue can carry on. The follow-up
            // is fire-and-forget like every other send call site — awaiting it here
            // would stack one frame per queued prompt.
            const drain = queueShouldDrain({
                interrupted: abort.signal.aborted,
                drainRequested: tab.drainQueue,
            });
            tab.drainQueue = false;
            if (drain && tab.queued.length > 0) {
                const next = tab.queued.shift();
                if (next !== undefined) {
                    void this.sendTo(tab, next, true);
                    this.host.repaint();
                    return;
                }
            }
            if (!drain && tab.queued.length > 0 && this.host.isForeground(tab)) {
                this.host.status(`${String(tab.queued.length)} queued — kept after the interrupt · /interrupt runs them`);
            }
            this.host.repaint();
        }
    }
}
