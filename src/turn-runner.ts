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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  queueShouldDrain,
  textMessage,
  type Message,
  type Segment,
  type SessionStatus,
} from './tui/state.ts'
import { promptBlocks } from './tui-adapt.ts'
import { describeError } from './local-platform.ts'

/**
 * The fields of a session tab a turn reads or moves. Structural on purpose:
 * the app's own tab type satisfies it without importing anything from here.
 */
export interface TurnTab {
  agent: Agent | undefined
  id: string
  title: string
  messages: Message[]
  streaming: boolean
  streamStartedAt: number
  turnStartTokens: number
  completionTokens: number
  tps: number
  drainQueue: boolean
  queued: { text: string; images: readonly ImageAttachmentRef[] }[]
  streamingSegments: Segment[]
  streamingReasoning: string
  logSyncedSeq: number
  status: SessionStatus
  selection: { assembled?: { provider: string } | undefined; current?: { provider: string } | undefined }
}

/** A prompt as the turn consumes it: the text plus any staged images. */
export interface TurnPrompt {
  text: string
  images: readonly ImageAttachmentRef[]
}

/** Everything a turn makes visible, supplied by the app. */
export interface TurnHost {
  /** Whether this tab is the one on screen; only it follows live output. */
  isForeground(tab: TurnTab): boolean
  clearOverlay(): void
  /** Follow the newest output for the active tab. */
  followOutput(): void
  /** Record the prompt in the composer history and schedule a save. */
  rememberPrompt(text: string): void
  status(text: string, isError?: boolean): void
  repaint(): void
  spinner(on: boolean): void
  /** Hand the app the abort controller for the running turn, or take it back. */
  setAbort(controller: AbortController | undefined): void
  /** The tab's own running/ready transition (bell and seen rules included). */
  sessionStatus(tab: TurnTab, status: SessionStatus): void
  /** Attribute this turn's billed spend to the provider that answered. */
  foldUsage(tab: TurnTab, provider: string): void
  /** Sync tool rows that landed in the log between frames. */
  syncToolLog(tab: TurnTab): void
  /** Persist the session log. */
  flush(tab: TurnTab): void
  /** Schedule a durable-state save. */
  persist(): void
}

export class TurnRunner {
  constructor(private readonly host: TurnHost) {}

  /** Send a prompt to the active session. */
  send(tab: TurnTab, text: string): Promise<void> {
    return this.run(tab, { text, images: [] }, false)
  }

  /** Send a materialized prompt to one specific session and stream the reply. */
  run(tab: TurnTab, prompt: TurnPrompt, fromQueue = false): Promise<void> {
    return this.sendTo(tab, prompt, fromQueue)
  }

  /**
   * Send a prompt to one specific session and stream the reply.
   *
   * `fromQueue` marks a prompt that was already recorded in the composer
   * history at the moment it was queued, so the drain must not record it a
   * second time (recall would then surface it twice).
   */
  private async sendTo(tab: TurnTab, prompt: TurnPrompt, fromQueue: boolean): Promise<void> {
    const agent = tab.agent
    if (agent === undefined) return

    this.beginTurn(tab, prompt, fromQueue)

    const abort = new AbortController()
    this.host.setAbort(abort)

    try {
      agent.followup(
        createUserMessage({ content: promptBlocks(prompt), source: { kind: 'user' } }),
      )
      await agent.whenIdle()
    } catch (error) {
      this.host.status(describeError(error), true)
    } finally {
      const interrupted = abort.signal.aborted
      this.host.setAbort(undefined)
      this.settleTurn(tab)
      this.drainAfterTurn(tab, interrupted)
    }
  }

  /** Put a turn on screen: the user turn, the title, and the running state. */
  private beginTurn(tab: TurnTab, prompt: TurnPrompt, fromQueue: boolean): void {
    const text = prompt.text
    this.host.clearOverlay()
    // Only follow the newest output when the queued conversation is the one
    // on screen; a backgrounded session must not yank the view around.
    if (this.host.isForeground(tab)) this.host.followOutput()
    if (!fromQueue) {
      this.host.rememberPrompt(text)
    }
    tab.messages.push(
      textMessage('user', text, {
        attachments:
          prompt.images.length === 0
            ? undefined
            : prompt.images.map((ref) => ({
                name: ref.name ?? 'image',
                width: ref.width,
                height: ref.height,
              })),
      }),
    )
    if (tab.title === '') {
      tab.title = text.slice(0, 60)
      // A tab restored with no title reads as "new session" in the bar, which
      // is exactly the wrong label for a conversation that already has one.
      this.host.persist()
    }

    tab.streaming = true
    tab.streamStartedAt = Date.now()
    tab.turnStartTokens = tab.completionTokens
    tab.drainQueue = false
    tab.streamingSegments = []
    tab.streamingReasoning = ''
    // Tool results land in the session log between model streams, where no
    // frame fires; the sync reads them from here on. Events before this point
    // belong to earlier turns and must not color this one's rows.
    tab.logSyncedSeq = tab.agent === undefined ? 0 : tab.agent.session.seq
    this.host.sessionStatus(tab, 'running')
    this.host.status('')
    if (tab.queued.length > 0) {
      // More still waiting behind this one: say so, or the queue silently
      // draining looks like prompts disappearing.
      this.host.status(`${String(tab.queued.length)} queued — sends when the reply finishes`)
    }
    this.host.spinner(true)
    this.host.repaint()
  }

  /** Commit whatever streamed, even on an interrupt, so nothing is lost. */
  private settleTurn(tab: TurnTab): void {
    const turnSeconds = (Date.now() - tab.streamStartedAt) / 1000
    const turnOutput = tab.completionTokens - tab.turnStartTokens
    tab.tps = turnSeconds > 0 && turnOutput > 0 ? turnOutput / turnSeconds : 0
    // Attribute this turn's own spend to whichever provider actually
    // answered it — `assembled` is what prompt assembly captured for the
    // request just settled, which stays correct even though `current`
    // already points at a switch queued for the next turn.
    const provider = tab.selection.assembled?.provider ?? tab.selection.current?.provider ?? ''
    this.host.foldUsage(tab, provider)
    this.host.persist()
    tab.streaming = false
    tab.streamStartedAt = 0
    this.host.spinner(false)
    // One last log sync first: the final tool results may have landed after
    // the last frame, and the committed rows are what /export and a restart
    // will show.
    this.host.syncToolLog(tab)
    const reasoning = tab.streamingReasoning.trim()
    // The turn commits with its order intact — the same segments that were
    // on screen while it streamed, so nothing rearranges itself once it
    // settles.
    const segments = tab.streamingSegments.filter(
      (segment) => segment.kind === 'tool' || segment.text.trim() !== '',
    )
    if (segments.length > 0 || reasoning !== '') {
      tab.messages.push({
        role: 'assistant',
        segments,
        reasoning: reasoning === '' ? undefined : reasoning,
      })
    }
    tab.streamingSegments = []
    tab.streamingReasoning = ''
    // The answer is in: ring unless it is already on screen.
    this.host.sessionStatus(tab, 'ready')
    this.host.flush(tab)
  }

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
  private drainAfterTurn(tab: TurnTab, interrupted: boolean): void {
    const drain = queueShouldDrain({
      interrupted,
      drainRequested: tab.drainQueue,
    })
    tab.drainQueue = false
    if (drain && tab.queued.length > 0) {
      const next = tab.queued.shift()
      if (next !== undefined) {
        void this.sendTo(tab, next, true)
      }
    }
    if (!drain && tab.queued.length > 0 && this.host.isForeground(tab)) {
      this.host.status(
        `${String(tab.queued.length)} queued — kept after the interrupt · /interrupt runs them`,
      )
    }
    this.host.repaint()
  }
}
