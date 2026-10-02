/**
 * Frame composition: header, transcript, palette popup, composer, footer.
 *
 * The renderer is pure — it turns a snapshot of the app into the exact lines
 * the screen should show, and reports where the cursor belongs. Nothing here
 * touches the terminal or the Harness.
 * @module
 */

import {
  fleetLineOf,
  fleetSummary,
  renderFleet,
  type FleetView,
} from './fleet.ts'
import { renderUsagePane, type UsageView } from './usage-view.ts'
import { renderMarkdown } from './markdown.ts'
import {
  Composer,
  estimateTokens,
  formatTokens,
  MAX_INPUT_LINES,
  messageText,
  messageTools,
  segmentsText,
  type Message,
  type Palette,
  type BackgroundAgent,
  type Picker,
  type Segment,
  type SessionSummary,
  type ToolActivity,
} from './state.ts'
import { displayWidth, padEnd, stripAnsi, truncate, wrap } from './text.ts'
import {
  accent,
  bold,
  colAccent,
  colBorder,
  colGold,
  colGreen,
  colMuted,
  colRose,
  colText,
  muted,
  ok,
  selected,
  style,
  warn,
} from './theme.ts'
import { isImagePath, type AtMenu } from './atfile.ts'
import { helpText, t, translate } from './i18n.ts'
import { stackFrame } from './stack.ts'
import { highlighted, type Span } from './select.ts'
import type { PanelView } from './panels.ts'

/** Most file-completion rows listed at once before the popup scrolls. */
const MAX_AT_ROWS = 6

/**
 * Most slash-command rows listed at once before the popup scrolls.
 *
 * Kept small deliberately: the palette sits right above the composer, and a
 * long match list (the command table is 30+ entries) would otherwise grow the
 * popup to fill whatever room the terminal has, pushing the transcript out of
 * the way for something that is supposed to be a quick lookup.
 */
const MAX_PALETTE_ROWS = 3

/** Rows of chrome the layout reserves around the transcript. */
const HEADER_ROWS = 2
const FOOTER_ROWS = 1
const GAP_ROWS = 1
const MIN_VIEWPORT_ROWS = 3
const POPUP_BORDER_ROWS = 2
/** Most background agents listed at once before the panel scrolls. */
const MAX_BACKGROUND_ROWS = 6

/** Everything the renderer needs to draw one frame. */
export interface Snapshot {
  columns: number
  rows: number
  title: string
  host: string
  modelName: string
  messages: readonly Message[]
  /** The turn streaming in, prose and calls in arrival order. */
  streamingSegments: readonly Segment[]
  streamingReasoning: string
  streaming: boolean
  spinner: string
  status: string
  statusIsError: boolean
  overlay: string
  showThinking: boolean
  composer: Composer
  palette: Palette
  picker: Picker
  /** Rows scrolled up from the bottom of the transcript. */
  scrollBack: number
  /** Whether each tool call is listed instead of summarized on one line. */
  expandTools: boolean
  /** Open sessions, in creation order; the bar is hidden when there is one. */
  sessions: readonly SessionSummary[]
  /** Live agents other than the foreground one, newest last. */
  background: readonly BackgroundAgent[]
  /** Whether the background agents are listed instead of counted on one line. */
  expandBackground: boolean
  /** Seconds the current reply has been running, for the activity line. */
  elapsedSeconds: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  haveUsage: boolean
  contextLimit: number
  /** Output tokens per second for the last settled turn; 0 when unknown. */
  tps?: number
  /** Prompt tokens served from cache, and the total prompt tokens they came from. */
  cacheReadTokens?: number
  confirming: boolean
  /** Set while confirming: the yes/no question, drawn in the composer. */
  confirmText?: string
  /** Whether a `/find` search is open, so its counter outranks the scroll hint. */
  searchActive?: boolean
  /**
   * Prompts queued while the active session's reply streams, drawn dimmed
   * under the streaming block. Optional so snapshot builders without a
   * queue render exactly as before.
   */
  queued?: readonly string[]
  /**
   * The cross-device overview, when one is open. Optional so every existing
   * snapshot builder renders exactly as before.
   */
  fleet?: FleetView
  /**
   * The `/usage` dashboard, when it is open. Optional so every existing
   * snapshot builder renders exactly as before.
   */
  usage?: UsageView
  /**
   * Push-to-talk state, while the microphone is open or whisper is running.
   * Optional so every existing snapshot builder renders exactly as before.
   */
  voice?: VoicePhase
  /**
   * The `@` file-completion menu, while an `@` token is being typed.
   * Optional so every existing snapshot builder renders exactly as before.
   */
  atMenu?: AtMenu
  /**
   * A trust-surface panel (approval, question, plan review). While one is
   * open it owns the keyboard and replaces the transcript.
   */
  panel?: PanelView
  /**
   * Index of the transcript turn under selection, marked with a gold bar.
   * Optional so every existing snapshot builder renders exactly as before.
   */
  selectedTurn?: number
  /** One line a plugin contributed, drawn above the composer. */
  pluginLine?: string
  /** The composer's vim mode, when modal editing is on. */
  vimMode?: 'insert' | 'normal'
  /**
   * The stacked view, while `/stack` has it open: every open session tiled
   * into the transcript region at once, one per pane. The pane snapshots are
   * whole ones so a pane draws with the exact renderer the full view uses.
   * Optional so every existing snapshot builder renders exactly as before.
   */
  stack?: {
    panes: readonly StackPane[]
    focused: number
    /** The blink phase for attention panes, alternated by the app. */
    blinkOn: boolean
  }
  /**
   * A mouse drag's selection, drawn as the highlight over the frame. Only a
   * real drag sets it — a press that has not moved is still a pending click.
   * Optional so every existing snapshot builder renders exactly as before.
   */
  selection?: Span
}

/**
 * One tiled pane in the stacked view: a session's snapshot, its label, and —
 * while the session wants the user — what it wants them for.
 */
export interface StackPane {
  title: string
  snapshot: Snapshot
  /** `input` waits on an approval or question; `done` finished unseen. */
  attention?: 'input' | 'done'
}

/** What push-to-talk is doing, for the footer indicator. */
export type VoicePhase = 'recording' | 'transcribing'

/** Geometry derived from the terminal size and the current composer height. */
export interface Layout {
  contentWidth: number
  viewportRows: number
  paletteRows: number
  inputRows: number
  /** Rows the `@` file-completion popup shows, excluding its border. */
  atRows: number
  /** One row when a plugin contributed a status line. */
  pluginRows: number
  /** Rows the background-agent strip occupies, including any border. */
  backgroundRows: number
  /** Rows the session tab bar occupies (0 or 1). */
  sessionRows: number
  /** Cleared on a window too short to afford the header. */
  showHeader: boolean
  /** Cleared on a window too short to afford the blank separator row. */
  showGap: boolean
}

/** The usable width inside the one-column gutter on each side. */
function contentWidth(columns: number): number {
  // Never wider than the window: a floor here would push styled rows past the
  // right edge on a very narrow terminal instead of merely looking cramped.
  return Math.max(Math.min(columns - 2, columns), 4)
}

/** Room left under the chrome for one popup, given what is already reserved. */
function popupRows(
  open: boolean,
  matches: number,
  max: number,
  reserved: number,
  snapshot: Snapshot,
  inputRows: number,
): number {
  if (!open) return 0
  const available =
    snapshot.rows -
    HEADER_ROWS -
    GAP_ROWS -
    inputRows -
    FOOTER_ROWS -
    MIN_VIEWPORT_ROWS -
    POPUP_BORDER_ROWS -
    reserved
  return Math.max(Math.min(matches, max, available), 0)
}

/** The shrinkable and fixed chrome rows, as `layout` measured them. */
interface Chrome {
  rows: number
  sessionRows: number
  pluginRows: number
  backgroundRows: number
  showHeader: boolean
  showGap: boolean
  popupHeight: number
  atHeight: number
  inputRows: number
}

/**
 * Shed chrome until the transcript has its minimum, cheapest first: the
 * expanded agent list collapses to its one-line form, then the header goes,
 * then the separator, and only a window too small for even that loses the
 * strip entirely. The transcript outranks all of them — a frame showing a
 * four-row agent panel and no conversation would be the wrong trade.
 */
function shedChrome(chrome: Chrome): Chrome {
  if (spareRows(chrome) >= MIN_VIEWPORT_ROWS) return chrome
  if (chrome.pluginRows > 0) return shedChrome({ ...chrome, pluginRows: 0 })
  if (chrome.backgroundRows > 1) return shedChrome({ ...chrome, backgroundRows: 1 })
  if (chrome.showHeader) return shedChrome({ ...chrome, showHeader: false })
  if (chrome.showGap) return shedChrome({ ...chrome, showGap: false })
  if (chrome.backgroundRows > 0) return shedChrome({ ...chrome, backgroundRows: 0 })
  if (chrome.sessionRows > 0) return shedChrome({ ...chrome, sessionRows: 0 })
  return chrome
}

/** The transcript rows left under the chrome. */
function spareRows(chrome: Chrome): number {
  return (
    chrome.rows -
    ((chrome.showHeader ? HEADER_ROWS : 0) +
      chrome.sessionRows +
      (chrome.showGap ? GAP_ROWS : 0) +
      chrome.popupHeight +
      chrome.atHeight +
      chrome.pluginRows +
      chrome.backgroundRows +
      chrome.inputRows +
      FOOTER_ROWS)
  )
}

/** Compute the geometry for a frame. */
export function layout(snapshot: Snapshot): Layout {
  const width = contentWidth(snapshot.columns)
  const composerRows = snapshot.composer.height(width - 4)
  const inputRows = composerRows + 2

  const paletteRows = popupRows(
    snapshot.palette.open,
    snapshot.palette.matches.length,
    MAX_PALETTE_ROWS,
    0,
    snapshot,
    inputRows,
  )
  const paletteHeight = paletteRows > 0 ? paletteRows + POPUP_BORDER_ROWS : 0

  const atRows = popupRows(
    snapshot.atMenu?.open === true,
    snapshot.atMenu?.matches.length ?? 0,
    MAX_AT_ROWS,
    paletteHeight,
    snapshot,
    inputRows,
  )
  const atHeight = atRows > 0 ? atRows + POPUP_BORDER_ROWS : 0

  // The tab bar earns its row only once there is more than one session, and
  // yields it in the stacked view: the tiles already say which session is
  // which, so the strip would spend a transcript row repeating them.
  const sessionRows = snapshot.sessions.length > 1 && snapshot.stack === undefined ? 1 : 0

  // A plugin's status line is one row, surrendered first when space is short.
  const pluginRows = snapshot.pluginLine !== undefined && snapshot.pluginLine.trim() !== '' ? 1 : 0

  // The background strip is one line when collapsed, or a bordered list.
  const backgroundRows =
    snapshot.background.length === 0
      ? 0
      : snapshot.expandBackground
        ? Math.min(snapshot.background.length, MAX_BACKGROUND_ROWS) + POPUP_BORDER_ROWS
        : 1

  const settled = shedChrome({
    rows: snapshot.rows,
    sessionRows,
    pluginRows,
    backgroundRows,
    showHeader: true,
    showGap: true,
    popupHeight: paletteHeight,
    atHeight,
    inputRows,
  })

  const viewportRows = Math.max(spareRows(settled), 0)
  return {
    contentWidth: width,
    viewportRows,
    paletteRows,
    atRows,
    pluginRows: settled.pluginRows,
    inputRows,
    backgroundRows: settled.backgroundRows,
    sessionRows: settled.sessionRows,
    showHeader: settled.showHeader,
    showGap: settled.showGap,
  }
}

/** Strip the scheme and trailing slash from a base URL for the header. */
export function hostLabel(base: string): string {
  return base.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/** The `dsh` header line: mark and title on the left, host on the right. */
function header(snapshot: Snapshot, width: number): string {
  const title = snapshot.title === '' ? 'new conversation' : snapshot.title
  const left = `${bold('◆ moqi')}${muted(`  ${title}`)}`
  const right = muted(snapshot.host)
  const gap = width - displayWidth(left) - displayWidth(right)
  if (gap < 2) {
    return `${bold('◆ moqi')}${muted(`  ${truncate(title, Math.max(width - 8, 4))}`)}`
  }
  return left + ' '.repeat(gap) + right
}

/** Render one transcript turn to styled lines. */
/** How a turn's tool activity should be drawn. */
interface ToolStyle {
  /** List every call instead of collapsing them onto one line. */
  expand: boolean
  /** Current spinner frame, for a run still in progress. */
  spinner: string
  /** Seconds the run has been going, for a run still in progress. */
  elapsed: number
}

/**
 * One tool call, where it happened.
 *
 * A call is one line — its mark, its name, and what it does — so it reads as a
 * step the agent took between two things it said, and the prose on either side
 * keeps its own shape. `ctrl+o` adds each call's outcome underneath the very
 * call that produced it. The call in flight carries the spinner and its elapsed
 * time instead of a status mark.
 */
function renderTool(tool: ToolActivity, width: number, toolStyle: ToolStyle): string[] {
  const mark =
    tool.status === 'running'
      ? toolStyle.spinner === ''
        ? style('●', { fg: colGreen })
        : style(toolStyle.spinner, { fg: colAccent })
      : tool.status === 'ok'
        ? ok('✓')
        : warn('✗')

  // The elapsed time belongs to the call in hand, not to the turn: it is the
  // one number that says "this is still going" rather than "this took a while".
  const elapsed =
    tool.status === 'running' && toolStyle.elapsed > 0
      ? muted(`  ${formatElapsed(toolStyle.elapsed)}`)
      : ''

  const detail =
    tool.detail === undefined || tool.detail === ''
      ? ''
      : muted(
          `  ${truncate(tool.detail, Math.max(width - displayWidth(tool.name) - displayWidth(elapsed) - 8, 8))}`,
        )

  const head = truncate(`${mark} ${style(tool.name, { fg: colText })}${detail}${elapsed}`, width)
  if (!toolStyle.expand) return [head]

  const result = tool.result ?? ''
  if (result === '') return [head]
  const under = (tool.status === 'error' ? warn : muted)(
    `  ↳ ${truncate(result, Math.max(width - 4, 8))}`,
  )
  return [head, under]
}

/** Seconds as a compact duration: 8s, 1m12s. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`
  return `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s`
}

function renderMessage(
  message: Message,
  width: number,
  showThinking: boolean,
  toolStyle: ToolStyle,
  selectedTurn = false,
): string[] {
  const content = renderMessageBody(message, width, showThinking, toolStyle)
  if (!selectedTurn) return content
  // A selection is a frame, not a repaint: the gold bar marks the turn whose
  // text `alt+c` would copy without disturbing any of the turn's own styling.
  const bar = style('▏', { fg: colGold })
  return content.map((line) => `${bar}${line}`)
}

/** One turn's lines, without selection decoration. */
function renderMessageBody(
  message: Message,
  width: number,
  showThinking: boolean,
  toolStyle: ToolStyle,
): string[] {
  if (message.role === 'user') return renderUserTurn(message, width)
  if (message.command !== undefined) return renderCommandTurn(message, width)
  return renderAssistantTurn(message, width, showThinking, toolStyle)
}

/** A user turn: the prompt in the speaker bar, then its attachments. */
function renderUserTurn(message: Message, width: number): string[] {
  const bar = style('▌', { fg: message.steering === true ? colMuted : colAccent })
  const out: string[] = []
  for (const line of wrap(messageText(message), width - 2)) {
    out.push(message.steering === true ? `${bar} ${muted(line)}` : `${bar} ${style(line, { fg: colText })}`)
  }
  if ((message.attachments ?? []).length > 0) {
    const names = (message.attachments ?? [])
      .map((image) => `🖼 ${image.name} ${String(image.width)}×${String(image.height)}`)
      .join('  ')
    out.push(`${bar} ${muted(names)}`)
  }
  return out
}

/** A slash command's turn: the outcome mark, then what it printed. */
function renderCommandTurn(message: Message, width: number): string[] {
  const command = message.command
  const mark = command?.ok ? ok('✓') : warn('✗')
  const label = style(`/${command?.name ?? ''}`, { fg: colAccent })
  const out = [`${mark} ${label}`]
  for (const line of wrap(messageText(message), width - 2)) {
    out.push(`  ${muted(line)}`)
  }
  return out
}

/** An assistant turn: reasoning, then the segments in the order they came. */
function renderAssistantTurn(
  message: Message,
  width: number,
  showThinking: boolean,
  toolStyle: ToolStyle,
): string[] {
  const out: string[] = []

  if (showThinking && (message.reasoning ?? '').trim() !== '') {
    const bar = style('┆', { fg: colMuted })
    for (const line of wrap((message.reasoning ?? '').trim(), width - 2)) {
      out.push(`${bar} ${style(line, { fg: colMuted, italic: true })}`)
    }
    if (out.length > 0) out.push('')
  }

  // The turn in the order it happened: what the agent said, the call it made,
  // what it said next. Each piece is rendered as itself and separated by a
  // blank line, so neither the prose nor the calls run together.
  for (const segment of message.segments) {
    const lines =
      segment.kind === 'tool'
        ? renderTool(segment.tool, width, toolStyle)
        : segment.text.trim() === ''
          ? []
          : renderMarkdown(segment.text.trim(), width).split('\n')
    if (lines.length === 0) continue
    if (out.length > 0) out.push('')
    out.push(...lines)
  }

  // The collapsed summary used to be what advertised ctrl+o. Now that calls
  // render in place there is no summary, so the hint goes where it is still
  // true: once per turn, and only when expanding would actually reveal
  // something that is currently hidden.
  const hidden =
    !toolStyle.expand &&
    messageTools(message).some((tool) => tool.result !== undefined && tool.result !== '')
  if (hidden) out.push(muted('  ctrl+o for detail'))
  return out
}

/** The whole transcript, including the reply currently streaming in. */
/**
 * Rendered lines for one settled message, keyed by the message object.
 *
 * A frame only ever shows a window of a long transcript, but the viewport is
 * sliced from fully rendered lines — so without this cache every paint
 * re-rendered and re-highlighted the entire conversation. Messages are
 * immutable once committed, so the rest of the key is everything outside the
 * message that changes its lines: the width, and the two view toggles. Leaving
 * the toggles out made `ctrl+o` and `/thinking` no-ops on every settled turn —
 * they flipped the flag and the cache handed back the old frame.
 */
interface CachedLines {
  width: number
  expand: boolean
  showThinking: boolean
  lines: string[]
}

const messageLineCache = new WeakMap<Message, CachedLines>()

/** Render one message through the cache. */
function cachedMessageLines(
  message: Message,
  width: number,
  showThinking: boolean,
  toolStyle: ToolStyle,
  selected: boolean,
): string[] {
  // A streaming turn animates and a selected turn carries a bar, so neither
  // may be served from the cache of its unmarked form.
  const animating = toolStyle.spinner !== '' && messageTools(message).length > 0
  if (animating || selected) {
    return renderMessage(message, width, showThinking, toolStyle, selected)
  }
  const hit = messageLineCache.get(message)
  if (
    hit !== undefined &&
    hit.width === width &&
    hit.expand === toolStyle.expand &&
    hit.showThinking === showThinking
  ) {
    return hit.lines
  }
  const lines = renderMessage(message, width, showThinking, toolStyle)
  messageLineCache.set(message, { width, expand: toolStyle.expand, showThinking, lines })
  return lines
}

/** One rendered block and the message it belongs to, in body order. */
function messageBlocks(snapshot: Snapshot, width: number): { message: number; lines: string[] }[] {
  // A settled turn never animates, so its spinner frame is irrelevant.
  const settled: ToolStyle = { expand: snapshot.expandTools, spinner: '', elapsed: 0 }
  const live: ToolStyle = {
    expand: snapshot.expandTools,
    spinner: snapshot.spinner,
    elapsed: snapshot.elapsedSeconds,
  }

  const blocks: { message: number; lines: string[] }[] = []
  snapshot.messages.forEach((message, index) => {
    const rendered = cachedMessageLines(
      message,
      width,
      snapshot.showThinking,
      settled,
      snapshot.selectedTurn === index,
    )
    // A message that renders no lines owns no rows, so no click can land on
    // it; carrying the message index keeps the hit test honest about that.
    if (rendered.length > 0) blocks.push({ message: index, lines: rendered })
  })
  if (snapshot.streaming) {
    const running = renderMessage(
      {
        role: 'assistant',
        segments: snapshot.streamingSegments,
        reasoning: snapshot.streamingReasoning,
      },
      width,
      snapshot.showThinking,
      live,
    )
    if (running.length > 0) blocks.push({ message: -1, lines: running })
  }
  const queued = snapshot.queued ?? []
  if (queued.length > 0) {
    // Queued prompts borrow the user bar's shape but read as waiting: a
    // muted marker and dim text, so they are recognizably yours-to-come
    // rather than already-sent.
    const bar = muted('▌')
    const block: string[] = []
    for (const text of queued) {
      for (const line of wrap(text.replace(/\s+$/, ''), width - 2)) {
        block.push(`${bar} ${style(line, { fg: colMuted, dim: true })}`)
      }
    }
    block.push(muted('· queued — sends when the reply finishes'))
    blocks.push({ message: -1, lines: block })
  }
  return blocks
}

/** Each rendered turn's body start row and the message it belongs to. */
function turnStartRows(
  snapshot: Snapshot,
  width: number,
): { message: number; start: number }[] {
  if (snapshot.overlay !== '' || (snapshot.messages.length === 0 && !snapshot.streaming)) return []
  let offset = 0
  return messageBlocks(snapshot, width).map((block) => {
    const start = offset
    offset += block.lines.length + 1 // the blank separator between blocks
    return { message: block.message, start }
  })
}

function transcript(snapshot: Snapshot, width: number): string[] {
  const out: string[] = []
  messageBlocks(snapshot, width).forEach((block, index) => {
    if (index > 0) out.push('')
    out.push(...block.lines)
  })
  return out
}

/** The first-run panel, shown while the transcript is empty. */
function welcome(snapshot: Snapshot): string[] {
  return [
    bold(t('welcome.title')),
    '',
    muted(t('welcome.connected', { host: snapshot.host, model: snapshot.modelName })),
    muted(t('welcome.harness')),
    '',
    `${muted(t('welcome.type'))}${accent('/')}${muted(t('welcome.forCommands'))}`,
  ]
}

/** The scrollable transcript pane, anchored to the bottom. */
/** Everything the transcript pane would show, before scrolling or clipping. */
function bodyLines(snapshot: Snapshot, width: number): string[] {
  if (snapshot.overlay !== '') return renderMarkdown(snapshot.overlay, width).split('\n')
  if (snapshot.messages.length === 0 && !snapshot.streaming) return welcome(snapshot)
  return transcript(snapshot, width)
}

/**
 * How far back the transcript can scroll: anything beyond this is empty space
 * above the first line, so the caller clamps to it rather than letting the view
 * drift off the top.
 */
export function maxScrollBack(snapshot: Snapshot): number {
  const geometry = layout(snapshot)
  const body = bodyLines(snapshot, geometry.contentWidth)
  return Math.max(body.length - geometry.viewportRows, 0)
}

/**
 * Lines of the rendered body that contain `query`, case-insensitively.
 *
 * Matching runs over the printable text of each line — the styled form is full
 * of SGR escapes the user never typed — and returns indexes into the same
 * line array the viewport slices, so a hit can be scrolled to directly.
 */
export function findMatches(snapshot: Snapshot, query: string): number[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const geometry = layout(snapshot)
  const hits: number[] = []
  bodyLines(snapshot, geometry.contentWidth).forEach((line, index) => {
    if (stripAnsi(line).toLowerCase().includes(needle)) hits.push(index)
  })
  return hits
}

/**
 * The window of `body` the screen shows: the tail, anchored to the bottom so
 * the conversation grows upward out of the composer, pulled back by however
 * far `scrollBack` has scrolled.
 */
function scrollWindow(body: string[], scrollBack: number, height: number): string[] {
  if (body.length <= height) return [...Array<string>(height - body.length).fill(''), ...body]
  const maxStart = body.length - height
  const start = Math.max(Math.min(maxStart - scrollBack, maxStart), 0)
  return body.slice(start, start + height)
}

function viewport(snapshot: Snapshot, geometry: Layout): string[] {
  return scrollWindow(bodyLines(snapshot, geometry.contentWidth), snapshot.scrollBack, geometry.viewportRows)
}

/**
 * The stacked view's region: every pane snapshot tiled into the transcript's
 * rows. What a pane shows is the same renderer the full view uses, just at a
 * tile's size, so a session never looks different for being tiled.
 */
function stackPane(snapshot: Snapshot, geometry: Layout): string[] {
  const stack = snapshot.stack
  if (stack === undefined || stack.panes.length === 0) return []
  return stackFrame({
    count: stack.panes.length,
    width: geometry.contentWidth,
    height: geometry.viewportRows,
    focused: stack.focused,
    title: (index) => stack.panes[index]?.title ?? '',
    attention: (index) => stack.panes[index]?.attention,
    blinkOn: stack.blinkOn,
    renderBody: (index, width, height) => {
      const pane = stack.panes[index]
      if (pane === undefined) return []
      // A panel the pane's own session raised draws inside its tile, not
      // over the whole stack: the permission window belongs to the session
      // that asked for it, which is the one the tile names.
      if (pane.snapshot.panel !== undefined) {
        return panelPane(pane.snapshot, { ...geometry, contentWidth: width, viewportRows: height })
      }
      return scrollWindow(bodyLines(pane.snapshot, width), pane.snapshot.scrollBack, height)
    },
  })
}

/**
 * The picker pane, which replaces the transcript while it is open.
 *
 * Grouped mode prints a header whenever the subtitle changes, so a model list
 * reads provider by provider. Headers are laid out as part of the scrolling
 * body, which is why the visible window is computed over rendered lines rather
 * than over items.
 */
function pickerPane(snapshot: Snapshot, geometry: Layout): string[] {
  const width = geometry.contentWidth
  const height = geometry.viewportRows
  const picker = snapshot.picker
  const matches = picker.matches()

  // Title line, plus a filter line that doubles as the query display.
  const head: string[] = [bold(picker.title)]
  const hint = picker.query === '' ? muted('type to filter') : ''
  head.push(`${muted('› ')}${style(picker.query, { fg: colText })}${hint}`)
  head.push('')

  // Build every body line, remembering which one carries the selection.
  const body: string[] = []
  let selectedLine = -1
  let group = ''
  matches.forEach((item, index) => {
    if (picker.grouped && item.subtitle !== group) {
      group = item.subtitle
      if (body.length > 0) body.push('')
      body.push(style(group, { fg: colAccent, bold: true }))
    }
    const marker = item.active === true ? '● ' : '  '
    const right = picker.grouped ? '' : item.subtitle
    const rightWidth = displayWidth(right)
    const titleWidth = Math.max(width - rightWidth - displayWidth(marker) - 3, 8)
    const label = truncate(item.title.replace(/\n/g, ' '), titleWidth)
    const pad = Math.max(width - displayWidth(label) - rightWidth - displayWidth(marker) - 1, 1)
    const row = ` ${marker}${label}${' '.repeat(pad)}${right}`
    if (index === picker.selected) selectedLine = body.length
    body.push(index === picker.selected ? selected(padEnd(row, width)) : muted(padEnd(row, width)))
  })

  if (matches.length === 0) body.push(muted('  no matches'))

  // Scroll so the selected line stays visible.
  const bodyHeight = Math.max(height - head.length - 1, 1)
  let start = 0
  if (selectedLine >= bodyHeight) start = selectedLine - bodyHeight + 1
  const visible = body.slice(start, start + bodyHeight)

  const out = [...head, ...visible]
  while (out.length < height - 1) out.push('')
  const action = picker.kind === 'models' || picker.kind === 'themes' ||
    picker.kind === 'login' || picker.kind === 'login-method'
    ? 'select'
    : picker.kind === 'plugins' || picker.kind === 'panel'
      ? 'enable or disable'
      : picker.kind === 'delete' ? 'delete' : 'open'
  // The open-sessions list is the only one a key can act on beyond selecting
  // a row: "x" closes the session under the cursor without leaving the list.
  const keys = picker.kind === 'open'
    ? `↑↓ move  ·  enter ${action}  ·  x close  ·  esc back`
    : `↑↓ move  ·  enter ${action}  ·  esc back`
  const count = `${matches.length}/${picker.items.length}`
  out.push(
    muted(keys) +
      ' '.repeat(Math.max(width - displayWidth(keys) - displayWidth(count), 1)) +
      muted(count),
  )
  return out.slice(0, height)
}

/** The slash-command popup drawn above the composer. */
function palettePane(snapshot: Snapshot, geometry: Layout): string[] {
  const rows = geometry.paletteRows
  if (rows < 1) return []
  const width = geometry.contentWidth
  const inner = Math.max(width - 4, 10)

  const start = snapshot.palette.selected >= rows ? snapshot.palette.selected - rows + 1 : 0
  const visible = snapshot.palette.matches.slice(start, start + rows)

  let nameColumn = 0
  for (const command of visible) {
    const label = `/${command.name}${command.args === '' ? '' : ` ${command.args}`}`
    nameColumn = Math.max(nameColumn, label.length)
  }
  nameColumn += 2

  const body = visible.map((command, index) => {
    const label = `/${command.name}${command.args === '' ? '' : ` ${command.args}`}`
    const pad = Math.max(nameColumn - label.length, 1)
    const row = truncate(`${label}${' '.repeat(pad)}${command.description}`, inner)
    const padded = padEnd(row, inner)
    return start + index === snapshot.palette.selected ? selected(padded) : muted(padded)
  })

  return box(body, inner, colAccent)
}

/**
 * The `@` file-completion popup drawn between the palette and the composer.
 *
 * Directories carry a trailing slash and images a mark, so the shape of the
 * workspace is legible without color. The row count is bounded by the layout,
 * so a huge workspace scrolls the list rather than the transcript.
 */
function atPane(snapshot: Snapshot, geometry: Layout): string[] {
  const menu = snapshot.atMenu
  const rows = geometry.atRows
  if (menu === undefined || !menu.open || rows < 1) return []
  const inner = Math.max(geometry.contentWidth - 4, 10)

  const start = menu.selected >= rows ? menu.selected - rows + 1 : 0
  const visible = menu.matches.slice(start, start + rows)

  const body = visible.map((match, index) => {
    const label = match.directory ? `${match.path}/` : match.path
    const marked = isImagePath(label) ? `🖼 ${label}` : `  ${label}`
    const padded = padEnd(truncate(marked, inner), inner)
    return start + index === menu.selected ? selected(padded) : muted(padded)
  })

  return box(body, inner, colBorder)
}

/**
 * The session tab bar.
 *
 * Only drawn with more than one session open. Each tab carries a status mark —
 * a spinner while its turn runs, a filled dot when a finished answer is
 * waiting, nothing when it has been seen — so an unattended session advertises
 * itself without stealing the screen.
 */
function sessionBar(snapshot: Snapshot, geometry: Layout): string[] {
  if (geometry.sessionRows === 0) return []
  const width = geometry.contentWidth

  const cells = snapshot.sessions.map((session, index) => {
    const mark =
      session.status === 'running'
        ? style(snapshot.spinner, { fg: colGreen })
        : session.status === 'ready'
          ? style('●', { fg: colGold })
          : muted('·')
    const name = session.title === '' ? 'new' : session.title
    const label = `${String(index + 1)} ${name}`
    const body = `${mark} ${truncate(label, 18)}`
    return session.active ? selected(` ${body} `) : muted(` ${body} `)
  })

  const bar = cells.join(muted('│'))
  if (displayWidth(bar) <= width) return [bar]

  // Too many to show: keep the active one and say how many are hidden.
  const activeIndex = snapshot.sessions.findIndex((session) => session.active)
  const shown = cells.slice(Math.max(activeIndex - 1, 0), Math.max(activeIndex - 1, 0) + 2)
  const more = muted(`  +${String(snapshot.sessions.length - shown.length)}`)
  return [truncate(shown.join(muted('│')) + more, width)]
}

/**
 * The screen row the session bar occupies, or `undefined` when it is not
 * drawn. Clicks and the renderer must agree on where the bar is, and the
 * header above it is conditional — so the position is computed from the same
 * layout the frame is, never assumed to be the first row.
 */
export function sessionBarRow(snapshot: Snapshot): number | undefined {
  const geometry = layout(snapshot)
  if (geometry.sessionRows === 0) return undefined
  // header + its blank line, when the header is being shown at all.
  return geometry.showHeader ? 2 : 0
}

/**
 * The tab a mouse click lands on, if any: the whole decision, pure.
 *
 * Keeping it here rather than in the app means the two halves that must
 * agree — which row the bar is on, and which column inside it a tab covers —
 * are exercised together, against the same layout the renderer uses.
 */
export function tabClickTarget(
  snapshot: Snapshot,
  cell: { column: number; row: number },
): number | undefined {
  if (cell.row !== sessionBarRow(snapshot)) return undefined
  return tabAtColumn(snapshot, cell.column)
}

/**
 * Which transcript turn a mouse click landed on, if any.
 *
 * Click-to-copy needs the same guarantee the tab bar gets: the hit test is
 * computed from the layout the frame was drawn with, not assumed. A click in
 * the blank line between two turns selects the turn above it — a gap is not
 * worth a miss. Returns `undefined` when the transcript pane is not on screen
 * (an overlay, picker, panel, or the stacked view, whose per-pane mapping is
 * its own later piece) or the click fell outside it.
 */
export function turnClickTarget(
  snapshot: Snapshot,
  cell: { row: number },
): number | undefined {
  if (snapshot.panel !== undefined) return undefined
  if (snapshot.fleet?.open === true || snapshot.usage?.open === true) return undefined
  if (snapshot.stack !== undefined || snapshot.picker.kind !== 'none') return undefined
  const geometry = layout(snapshot)
  const top = (geometry.showHeader ? 2 : 0) + geometry.sessionRows
  const row = cell.row - top
  if (row < 0 || row >= geometry.viewportRows) return undefined
  const body = bodyLines(snapshot, geometry.contentWidth)
  const maxStart = Math.max(body.length - geometry.viewportRows, 0)
  const start = Math.max(Math.min(maxStart - snapshot.scrollBack, maxStart), 0)
  const line = start + row
  let hit: number | undefined
  for (const turn of turnStartRows(snapshot, geometry.contentWidth)) {
    // The streaming block and the queue are not selectable turns (-1): a
    // click there keeps whatever selection exists rather than inventing one.
    if (turn.message >= 0 && line >= turn.start) hit = turn.message
  }
  return hit
}

/**
 * Which session a click on the tab bar landed on, if any.
 *
 * The extents mirror {@link sessionBar}'s cell construction exactly — mark,
 * space, label truncated to 18, and the wrapping spaces — because a hit test
 * that drifts from the renderer sends clicks to the wrong tab, which is worse
 * than no click support at all: it looks deliberate. Styled text measures the
 * same as plain (the escapes carry no width), so the arithmetic runs on the
 * unstyled shapes. Returns `undefined` for a click between tabs, on the
 * overflow marker, or when the bar is not being drawn at all.
 */
export function tabAtColumn(snapshot: Snapshot, column: number): number | undefined {
  if (snapshot.sessions.length < 2) return undefined
  let start = 0
  for (let index = 0; index < snapshot.sessions.length; index += 1) {
    const session = snapshot.sessions[index]
    if (session === undefined) continue
    const name = session.title === '' ? 'new' : session.title
    // One cell: ' ' + mark(1) + ' ' + truncate(label, 18) + ' '
    const cellWidth = Math.min(displayWidth(`${String(index + 1)} ${name}`), 18) + 3
    if (column >= start && column < start + cellWidth) return index
    start += cellWidth
    if (index < snapshot.sessions.length - 1) start += 1 // the '│' separator
    if (start > column && column < start) break
  }
  return undefined
}

/** A compact duration for an agent that has been alive a while. */
function agentAge(agent: BackgroundAgent, now: number): string {
  return formatElapsed(Math.max(Math.floor((now - agent.startedAt) / 1000), 0))
}

/**
 * The background-agent strip, drawn between the transcript and the composer.
 *
 * Delegated work is otherwise invisible: the transcript only shows the
 * foreground agent, so a turn that spawned subagents looks idle while the
 * machine is busy. Collapsed it is one line with a count; `ctrl+b` lists them.
 */
function backgroundPane(snapshot: Snapshot, geometry: Layout): string[] {
  if (geometry.backgroundRows === 0) return []
  const width = geometry.contentWidth
  const agents = snapshot.background
  const running = agents.filter((agent) => agent.status === 'running').length
  const now = Date.now()

  // The layout may have collapsed an expanded strip to buy the transcript its
  // minimum height, so the geometry decides the form, not the toggle alone.
  if (!snapshot.expandBackground || geometry.backgroundRows === 1) {
    const mark = running > 0 ? style(snapshot.spinner, { fg: colGreen }) : ok('✓')
    const count =
      agents.length === 1 ? '1 agent' : `${String(agents.length)} agents`
    const state = running > 0 ? `${String(running)} running` : 'idle'
    const names = agents
      .slice(0, 3)
      .map((agent) => agent.label)
      .join(', ')
    const left = `${mark} ${style(count, { fg: colText })}${muted(`  ${state}`)}${muted(`  ·  ${names}`)}`
    const right = muted('ctrl+b')
    const gap = width - displayWidth(left) - displayWidth(right)
    return [gap < 2 ? truncate(left, width) : left + ' '.repeat(gap) + right]
  }

  const inner = Math.max(width - 4, 10)
  const visible = agents.slice(0, MAX_BACKGROUND_ROWS)
  const body = visible.map((agent) => {
    const mark =
      agent.status === 'running' ? style(snapshot.spinner, { fg: colGreen }) : muted('·')
    const depth = agent.depth > 1 ? muted(`${'  '.repeat(agent.depth - 1)}↳ `) : ''
    const age = muted(agentAge(agent, now))
    const label = `${mark} ${depth}${style(agent.label, { fg: colText })}`
    const pad = Math.max(inner - displayWidth(label) - displayWidth(age), 1)
    return truncate(label + ' '.repeat(pad) + age, inner)
  })
  if (agents.length > visible.length) {
    body.push(muted(`  and ${String(agents.length - visible.length)} more`))
  }
  return box(body, inner, colGreen)
}

/** Wrap lines in a rounded border of the given accent color. */
function box(body: string[], inner: number, color: typeof colAccent): string[] {
  const top = style(`╭${'─'.repeat(inner + 2)}╮`, { fg: color })
  const bottom = style(`╰${'─'.repeat(inner + 2)}╯`, { fg: color })
  const side = style('│', { fg: color })
  return [top, ...body.map((line) => `${side} ${padEnd(line, inner)} ${side}`), bottom]
}

/** The bordered composer, plus the cursor position inside it. */
function composerPane(
  snapshot: Snapshot,
  geometry: Layout,
): { lines: string[]; cursor: { row: number; column: number } } {
  const inner = Math.max(geometry.contentWidth - 4, 10)
  const rows = snapshot.composer.layout(inner)
  const visibleRows = Math.min(Math.max(rows.length, 1), MAX_INPUT_LINES)

  // Scroll the composer so the cursor's row stays visible in a long draft.
  const cursorRow = Math.max(
    rows.findIndex((row) => snapshot.composer.position() >= row.start && snapshot.composer.position() <= row.end),
    0,
  )
  const first = Math.max(Math.min(cursorRow - visibleRows + 1, rows.length - visibleRows), 0)
  const slice = rows.slice(first, first + visibleRows)

  const empty = snapshot.composer.value() === ''
  // A pending yes/no question takes the composer: it is the one place the
  // next keystroke is guaranteed to land, so the prompt belongs there rather
  // than in a status line the eye has already left.
  const question = snapshot.confirmText === undefined ? undefined : `${snapshot.confirmText}  (y/n)`
  // A narrow terminal has to drop the hint before it drops the prompt.
  const placeholder =
    question !== undefined && inner >= 12
      ? truncate(question, inner)
      : inner >= 34
        ? 'Ask the harness…  (/ for commands)'
        : inner >= 16
          ? 'Ask the harness…'
          : '…'
  const body = slice.map((row, index) => {
    if (empty && index === 0) {
      return muted(padEnd(truncate(placeholder, inner), inner))
    }
    return padEnd(truncate(style(row.text, { fg: colText }), inner), inner)
  })
  while (body.length < visibleRows) body.push(' '.repeat(inner))

  const color = snapshot.streaming ? colAccent : colBorder
  const lines = box(body, inner, color)

  const active = rows[cursorRow]
  const column = active === undefined ? 0 : displayWidth(active.text.slice(0, snapshot.composer.position() - active.start))
  return {
    lines,
    // +1 for the box's top border, +1 for the gutter and the border column.
    cursor: { row: 1 + (cursorRow - first), column: 2 + Math.min(column, inner - 1) },
  }
}

/** The status footer: model, context budget, usage, and the current status. */
/** The footer's left half: model, context budget, usage, and the spinner. */
function footerLeft(snapshot: Snapshot): string {
  const used = snapshot.haveUsage
    ? snapshot.totalTokens
    : estimateTokens(
        snapshot.messages.map(messageText).join('\n') + segmentsText(snapshot.streamingSegments),
      )
  const percent = snapshot.contextLimit > 0 ? Math.floor((used * 100) / snapshot.contextLimit) : 0
  const approx = snapshot.haveUsage ? '' : '~'
  const context = `ctx ${approx}${formatTokens(used)}/${formatTokens(snapshot.contextLimit)} ${percent}%`

  const separator = muted('  ·  ')
  const segments: string[] = [muted(snapshot.modelName)]
  segments.push(percent >= 80 ? warn(context) : muted(context))
  if (snapshot.haveUsage) {
    segments.push(
      muted(`↑${formatTokens(snapshot.promptTokens)} ↓${formatTokens(snapshot.completionTokens)}`),
    )
    const tps = snapshot.tps ?? 0
    if (tps > 0) segments.push(muted(`${tps.toFixed(0)} tok/s`))
    // A cache-hit rate is only honest when the prompt was non-trivial: an
    // empty request reads as 100% and means nothing.
    const cacheRead = snapshot.cacheReadTokens ?? 0
    if (cacheRead > 0 && snapshot.promptTokens > 0) {
      const rate = Math.min(Math.floor((cacheRead * 100) / snapshot.promptTokens), 100)
      segments.push(muted(`cache ${String(rate)}%`))
    }
  }

  let left = segments.join(separator)
  if (snapshot.streaming) left = `${accent(snapshot.spinner)} ${left}`
  return left
}

/** The footer's right half, by what most needs saying at this moment. */
function footerRight(snapshot: Snapshot, width: number): string {
  // A search counter or an error must not be hidden by the scroll indicator —
  // a match jump leaves the view scrolled, which is exactly when the "no
  // matches" error and the `match i/n` counter matter most.
  const outranksScroll = snapshot.statusIsError || snapshot.searchActive === true
  if (snapshot.voice !== undefined) {
    // An open microphone outranks all of it. Nothing else the footer says is
    // worth a person not knowing the room is being recorded, so this line
    // holds the slot for as long as the take lasts.
    return snapshot.voice === 'recording'
      ? style(t('footer.recording', { spinner: snapshot.spinner }), { fg: colRose })
      : style(t('footer.transcribing', { spinner: snapshot.spinner }), { fg: colGold })
  }
  if (snapshot.scrollBack > 0 && !outranksScroll) {
    // Scrolled away from the newest output: say so, and say how to get back.
    return style(
      t('footer.scrolled', {
        lines: snapshot.scrollBack,
        s: snapshot.scrollBack === 1 ? '' : 's',
      }),
      { fg: colGold },
    )
  }
  if (snapshot.status !== '') {
    const clipped = truncate(snapshot.status, Math.max(Math.floor(width / 2), 10))
    return snapshot.statusIsError ? warn(clipped) : ok(clipped)
  }
  if (snapshot.picker.kind === 'none' && !snapshot.palette.open) {
    return snapshot.vimMode === undefined
      ? muted(t('footer.hint'))
      : style(snapshot.vimMode === 'normal' ? ' NORMAL ' : ' INSERT ', {
          fg: colText,
          bg: snapshot.vimMode === 'normal' ? colAccent : colBorder,
          bold: true,
        })
  }
  return ''
}

/** The status footer: model, context budget, usage, and the current status. */
function footer(snapshot: Snapshot, width: number): string {
  const left = footerLeft(snapshot)
  const right = footerRight(snapshot, width)
  const gap = width - displayWidth(left) - displayWidth(right)
  if (gap < 2) return truncate(left, width)
  return left + ' '.repeat(gap) + right
}

/**
 * The fleet overview pane, which replaces the transcript while it is open.
 *
 * The rows themselves come from `renderFleet`, so this function only supplies
 * the chrome the pane needs: a heading, the summary line, scrolling, and the
 * key hints. Keeping the row rendering in `fleet.ts` is what lets the overview
 * be tested without a terminal.
 */
function fleetPane(snapshot: Snapshot, geometry: Layout): string[] {
  const width = geometry.contentWidth
  const height = geometry.viewportRows
  const fleet = snapshot.fleet
  if (fleet === undefined) return []

  const head: string[] = [bold('Fleet')]
  head.push(
    fleet.loading && fleet.sessions.length === 0
      ? muted('collecting from every device…')
      : muted(fleetSummary(fleet.sessions)),
  )
  head.push('')

  const body = renderFleet(fleet.sessions, {
    width,
    selectedIndex: fleet.sessions.length === 0 ? -1 : fleet.selected,
    spinner: snapshot.spinner,
    sources: fleet.sources,
  })

  // Scroll so the selected row stays visible. The renderer inserts a heading
  // per device, so the row's index is not its line -- fleetLineOf maps it.
  const bodyHeight = Math.max(height - head.length - 1, 1)
  const selectedLine = fleetLineOf(fleet.sessions, fleet.selected)
  const start = selectedLine >= bodyHeight ? selectedLine - bodyHeight + 1 : 0
  const visible = body.slice(start, start + bodyHeight)

  const out = [...head, ...visible]
  while (out.length < height - 1) out.push('')

  // While a device is being added the footer becomes that prompt: the keys it
  // would otherwise advertise are the ones now being typed into it.
  if (fleet.adding) {
    const label = 'add device: '
    const typed = style(fleet.draft, { fg: colText })
    const help = muted('  enter add  ·  esc cancel')
    const line = `${accent(label)}${typed}${help}`
    out.push(truncate(line, width))
    return out.slice(0, height)
  }

  const current = fleet.sessions[fleet.selected]
  // A local session switches in place; a remote one is attached to over SSH,
  // handing the terminal over for the duration — both read "open" here, and
  // it is only where a real terminal is not attached on both ends that this
  // falls back to copying the command instead.
  const action = current === undefined ? 'open' : 'enter open'
  const hint = `↑↓ move  ·  ${action}  ·  a add  ·  x remove  ·  r refresh  ·  esc back`
  const count = fleet.loading ? 'refreshing…' : `${String(fleet.sessions.length)} sessions`
  const pad = Math.max(width - displayWidth(hint) - displayWidth(count), 1)
  out.push(muted(hint) + ' '.repeat(pad) + muted(count))
  return out.slice(0, height)
}

/**
 * The `/usage` dashboard. `renderUsagePane` draws the whole body; this
 * function only clips it to the viewport and adds the key hint, the same
 * split {@link fleetPane} keeps with `renderFleet`.
 */
function usagePane(snapshot: Snapshot, geometry: Layout): string[] {
  const width = geometry.contentWidth
  const height = geometry.viewportRows
  const usage = snapshot.usage
  if (usage === undefined) return []
  const body = renderUsagePane(usage, width)
  const out = body.slice(0, Math.max(height - 1, 0))
  while (out.length < height - 1) out.push('')
  out.push(muted('esc back'))
  return out.slice(0, height)
}

/**
 * The transcript region's content, by what owns it: a trust-surface panel,
 * the fleet overview, the usage dashboard, an open picker, the stacked
 * tiles, or the plain scrolling transcript. An open picker outranks the
 * stacked view: the keys already go to the picker, so the stack tiling must
 * not paint over it and make every picker command look dead in the stack.
 */
function bodyPane(snapshot: Snapshot, geometry: Layout): string[] {
  if (snapshot.panel !== undefined) return panelPane(snapshot, geometry)
  if (snapshot.fleet?.open === true) return fleetPane(snapshot, geometry)
  if (snapshot.usage?.open === true) return usagePane(snapshot, geometry)
  if (snapshot.picker.kind !== 'none') return pickerPane(snapshot, geometry)
  if (snapshot.stack !== undefined) return stackPane(snapshot, geometry)
  return viewport(snapshot, geometry)
}

/** Where the composer's cursor lands, unless a full-pane surface owns the screen. */
function frameCursor(
  snapshot: Snapshot,
  composerTop: number,
  composer: { cursor: { row: number; column: number } },
): { row: number; column: number } | undefined {
  if (
    snapshot.picker.kind !== 'none' ||
    snapshot.fleet?.open === true ||
    snapshot.usage?.open === true ||
    snapshot.panel !== undefined
  ) {
    return undefined
  }
  return {
    row: composerTop + composer.cursor.row,
    column: composer.cursor.column + 1,
  }
}

/** Build a full frame plus the cursor position for the screen to place. */
export function render(snapshot: Snapshot): {
  lines: string[]
  cursor: { row: number; column: number } | undefined
} {
  const geometry = layout(snapshot)
  const width = geometry.contentWidth
  const gutter = ' '

  const rows: string[] = []
  if (geometry.showHeader) {
    rows.push(header(snapshot, width))
    rows.push('')
  }
  rows.push(...sessionBar(snapshot, geometry))

  if (geometry.viewportRows > 0) rows.push(...bodyPane(snapshot, geometry))
  if (geometry.showGap) rows.push('')

  rows.push(...backgroundPane(snapshot, geometry))

  const palette = palettePane(snapshot, geometry)
  rows.push(...palette)

  rows.push(...atPane(snapshot, geometry))

  if (geometry.pluginRows > 0 && snapshot.pluginLine !== undefined) {
    rows.push(muted(truncate(snapshot.pluginLine, width)))
  }

  const composer = composerPane(snapshot, geometry)
  const composerTop = rows.length
  rows.push(...composer.lines)
  rows.push(footer(snapshot, width))

  // The whole frame sits inside a one-column gutter. The cursor has to move
  // with it: composerPane reports a column inside its own box, and every line
  // of that box is about to be shifted right by the gutter.
  const lines = rows.map((line) => gutter + line)
  const painted = snapshot.selection === undefined ? lines : highlighted(lines, snapshot.selection)
  const cursor = frameCursor(snapshot, composerTop, composer)
  return { lines: painted, cursor }
}

/**
 * A trust-surface panel: what the agent is asking, the choices, and the way
 * out. It borrows the transcript's rows rather than floating, so a small
 * terminal still shows the whole decision.
 */
function panelPane(snapshot: Snapshot, geometry: Layout): string[] {
  const panel = snapshot.panel
  if (panel === undefined) return []
  const width = geometry.contentWidth
  const inner = Math.max(width - 2, 10)
  const out: string[] = []

  out.push(bold(truncate(panel.title, inner)))
  out.push('')
  const detail = panel.detail.trim()
  if (detail !== '') {
    for (const line of renderMarkdown(detail, width).split('\n')) out.push(truncate(line, inner))
    out.push('')
  }
  out.push(...panelRows(panel, inner))
  out.push(...panelInput(panel, inner))
  out.push('')
  out.push(muted(truncate(panel.hint, inner)))
  return out.slice(0, Math.max(geometry.viewportRows, 0))
}

/** The panel's selectable rows: a cursor for the choice, a ring for multi-select. */
function panelRows(panel: PanelView, inner: number): string[] {
  return panel.rows.map((row) => {
    const mark = row.checked === undefined ? (row.selected ? '❯' : ' ') : row.checked ? '◉' : '○'
    const body = truncate(`${mark} ${row.label}${row.description === undefined ? '' : `  ${row.description}`}`, inner)
    return row.selected ? selected(padEnd(body, inner)) : body
  })
}

/** The panel's free-text line, when the answer is typed rather than chosen. */
function panelInput(panel: PanelView, inner: number): string[] {
  if (panel.inputLabel === undefined) return []
  const text = panel.inputText === undefined || panel.inputText === '' ? '(type an answer)' : panel.inputText
  const line = truncate(`${panel.inputLabel}: ${text}`, inner)
  return [panel.inputFocused === true ? selected(padEnd(line, inner)) : muted(line)]
}

/**
 * The help text shown by `/help`, rendered as markdown in the transcript pane.
 *
 * It is longer than a default 80x24 window, and the overlay shows the *tail*
 * of it, so the list has a budget: every line added here pushes one off the
 * top, and what falls off first is the session keys. A new section therefore
 * comes with an equal number of lines folded together further down — which is
 * why several entries below read as two keys on one row.
 */
/**
 * The key reference.
 *
 * The strings live in the `i18n` catalog so one list covers both languages;
 * this export is the English one, which the render tests assert against.
 *
 * The overlay shows the tail of it, so the list has a budget: a new section
 * comes with an equal number of lines folded elsewhere. A line added to one
 * language's copy in `i18n.ts` must be added to the other, or the two drift.
 */
export const HELP_TEXT = translate('en', 'help.body')

/** The key reference in the active language, for the `/help` overlay. */
export function keyReference(): string {
  return helpText()
}
