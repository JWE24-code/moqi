import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { type Message, type Segment, type SessionStatus } from './tui/state.ts';
/**
 * The fields of a session tab a turn reads or moves. Structural on purpose:
 * the app's own tab type satisfies it without importing anything from here.
 */
export interface TurnTab {
    agent: Agent | undefined;
    id: string;
    title: string;
    messages: Message[];
    streaming: boolean;
    streamStartedAt: number;
    turnStartTokens: number;
    completionTokens: number;
    tps: number;
    drainQueue: boolean;
    queued: {
        text: string;
        images: readonly ImageAttachmentRef[];
    }[];
    streamingSegments: Segment[];
    streamingReasoning: string;
    logSyncedSeq: number;
    status: SessionStatus;
    selection: {
        assembled?: {
            provider: string;
        };
        current?: {
            provider: string;
        };
    };
}
/** A prompt as the turn consumes it: the text plus any staged images. */
export interface TurnPrompt {
    text: string;
    images: readonly ImageAttachmentRef[];
}
/** Everything a turn makes visible, supplied by the app. */
export interface TurnHost {
    /** Whether this tab is the one on screen; only it follows live output. */
    isForeground(tab: TurnTab): boolean;
    clearOverlay(): void;
    /** Follow the newest output for the active tab. */
    followOutput(): void;
    /** Record the prompt in the composer history and schedule a save. */
    rememberPrompt(text: string): void;
    status(text: string, isError?: boolean): void;
    repaint(): void;
    spinnerStart(): void;
    spinnerStop(): void;
    /** Hand the app the abort controller for the running turn, or take it back. */
    setAbort(controller: AbortController | undefined): void;
    /** The tab's own running/ready transition (bell and seen rules included). */
    sessionStatus(tab: TurnTab, status: SessionStatus): void;
    /** Attribute this turn's billed spend to the provider that answered. */
    foldUsage(tab: TurnTab, provider: string): void;
    /** Sync tool rows that landed in the log between frames. */
    syncToolLog(tab: TurnTab): void;
    /** Persist the session log. */
    flush(tab: TurnTab): void;
    /** Schedule a durable-state save. */
    persist(): void;
}
export declare class TurnRunner {
    private readonly host;
    constructor(host: TurnHost);
    /** Send a prompt to the active session. */
    send(tab: TurnTab, text: string): Promise<void>;
    /** Send a materialized prompt to one specific session and stream the reply. */
    run(tab: TurnTab, prompt: TurnPrompt, fromQueue?: boolean): Promise<void>;
    /**
     * Send a prompt to one specific session and stream the reply.
     *
     * `fromQueue` marks a prompt that was already recorded in the composer
     * history at the moment it was queued, so the drain must not record it a
     * second time (recall would then surface it twice).
     */
    private sendTo;
    /** Put a turn on screen: the user turn, the title, and the running state. */
    private beginTurn;
    /** Commit whatever streamed, even on an interrupt, so nothing is lost. */
    private settleTurn;
    /**
     * Run the queue's rules once a turn has settled.
     *
     * An interrupted turn must not launch the next prompt unbidden: the
     * user asked for silence, so the queue waits for a clean finish —
     * unless the interrupt was the redirection kind (`/interrupt`), which
     * stops this answer precisely so the queue can carry on. The follow-up
     * is fire-and-forget like every other send call site — awaiting it here
     * would stack one frame per queued prompt.
     */
    private drainAfterTurn;
}
