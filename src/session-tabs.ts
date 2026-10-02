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
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionStatus } from './tui/state.ts'

/** The parts of a session tab that the strip's rules touch. */
export interface TabLike {
  id: string
  title: string
  agent: Agent | undefined
  status: SessionStatus
}

export class SessionTabs<T extends TabLike> {
  tabs: T[]
  active = 0
  private readonly bellEnabled: boolean

  constructor(tabs: T[], options: { bell?: boolean } = {}) {
    this.tabs = tabs
    this.bellEnabled = options.bell !== false
  }

  /** The tab bar's view of the open sessions. */
  summaries(): { id: string; title: string; status: SessionStatus; active: boolean }[] {
    return this.tabs.map((tab, index) => ({
      id: tab.id,
      title: tab.title,
      status: tab.status,
      active: index === this.active,
    }))
  }

  /** Find the session that owns an agent, if any. */
  forAgent(agent: Agent): T | undefined {
    return this.tabs.find((tab) => tab.agent === agent)
  }

  /** The tab currently on screen. */
  current(): T | undefined {
    return this.tabs[this.active]
  }

  /**
   * Move a session to a new status, ringing the bell when it becomes `ready`.
   *
   * `ready` is the only state worth a sound: a turn finished and its answer is
   * waiting. A session you are already looking at is marked seen instead, so
   * the bar does not nag about a reply on screen.
   */
  setStatus(tab: T, status: SessionStatus): void {
    const wasReady = tab.status === 'ready'
    if (status === 'ready' && this.tabs[this.active] === tab) {
      tab.status = 'idle'
      if (!wasReady) this.ring()
      return
    }
    tab.status = status
    if (status === 'ready' && !wasReady) this.ring()
  }

  /** Sound the terminal bell, unless it has been turned off. */
  ring(): void {
    if (!this.bellEnabled) return
    try {
      process.stdout.write('\u0007')
    } catch {
      // A closed stdout is not a reason to fail a turn.
    }
  }

  /** Append a new session and make it active. */
  append(tab: T): void {
    this.tabs.push(tab)
    this.active = this.tabs.length - 1
  }

  /** Replace the whole strip (the restore path), activating `active`. */
  replaceAll(tabs: T[], active: number): void {
    this.tabs = tabs
    this.active = active === -1 ? 0 : active
  }

  /** Switch the view to another session, marking it seen. */
  select(index: number): T | undefined {
    if (index < 0 || index >= this.tabs.length) return undefined
    this.active = index
    const tab = this.tabs[index]
    // Looking at it counts as reading it.
    if (tab?.status === 'ready') tab.status = 'idle'
    return tab
  }

  /**
   * Close the session at `index`, keeping at least one open.
   *
   * @returns the closed tab, or `undefined` when it was the last session.
   */
  remove(index: number): { closed: T } | undefined {
    if (this.tabs.length <= 1) return undefined
    const [closed] = this.tabs.splice(index, 1)
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1
    else if (index < this.active) this.active -= 1
    return closed === undefined ? undefined : { closed }
  }
}
