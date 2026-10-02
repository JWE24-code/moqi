/**
 * A minimal interactive loop for PTY-driven integration testing.
 *
 * The full app (src/index.ts) imports @deepseek-ai/* packages that are not
 * installed in this checkout, so it cannot run here. This subject wires the
 * REAL terminal layer — Screen (raw mode, alt screen, diffed painting), the
 * chunk-tolerant key decoder, Composer, and view.ts's render — into the
 * smallest loop that behaves like the app:
 *
 *   - printable keys insert into the composer
 *   - ctrl+a / ctrl+e move to line start / end
 *   - shift+enter inserts a newline; enter appends the typed text to the transcript
 *   - ctrl+c twice within 1.5s quits (mirroring the app's two-step exit)
 *   - resize repaints
 *
 * On quit it restores the terminal via screen.stop() and then prints a plain
 * 'SUBJECT-DONE <n>' line (AFTER leaving the alt screen) so the driver can
 * detect a clean exit.
 *
 * Run with: node --experimental-strip-types tests/pty-subject.ts
 */

import { Screen } from '../src/tui/screen.ts'
import { Composer, Palette, Picker, textMessage, type Message } from '../src/tui/state.ts'
import { render, type Snapshot } from '../src/tui/view.ts'
import { AtMenu, activeAtToken, acceptToken, filterFiles } from '../src/tui/atfile.ts'
import { ApprovalPanel, QuestionsPanel } from '../src/tui/panels.ts'
import { setLanguage } from '../src/tui/i18n.ts'

const composer = new Composer()
/** The same trust-surface state the real app keeps, in miniature. */
let panel: ApprovalPanel | QuestionsPanel | undefined
const atMenu = new AtMenu()
const CANDIDATES = ['src/tui/state.ts', 'src/tui/view.ts', 'src/index.ts', 'README.md']
/**
 * Notices the driver asserts on. The newest is also painted as the status
 * line, so a driver can wait for an event instead of only reading the final
 * line after exit.
 */
const notices: string[] = []

function syncAtMenu(): void {
  const token = activeAtToken(composer.value(), composer.position())
  atMenu.update(token, token === undefined ? [] : filterFiles(token.query, CANDIDATES), undefined)
}

function acceptAt(): void {
  const chosen = atMenu.current?.()
  const token = activeAtToken(composer.value(), composer.position())
  if (chosen === undefined || token === undefined) return
  const edit = acceptToken(composer.value(), composer.position(), token, chosen.path)
  composer.adopt(edit.text, edit.cursor)
  atMenu.close()
}
// Mutable on purpose: the loop pushes a user turn on every enter, and
// Snapshot's readonly Message[] accepts a plain array.
const messages: Message[] = []

function snapshot(): Snapshot {
  return {
    columns: screen.size().columns,
    rows: screen.size().rows,
    title: 'pty subject',
    host: 'local harness',
    modelName: 'deepseek-chat',
    messages,
    streamingSegments: [],
    streamingReasoning: '',
    streaming: false,
    spinner: '⠋',
    status: notices.length === 0 ? '' : (notices.at(-1) ?? ''),
    statusIsError: false,
    overlay: '',
    showThinking: false,
    composer,
    palette: new Palette(),
    picker: new Picker(),
    scrollBack: 0,
    expandTools: false,
    sessions: [],
    background: [],
    expandBackground: false,
    elapsedSeconds: 0,
    promptTokens: 1200,
    completionTokens: 312,
    totalTokens: 1512,
    haveUsage: true,
    contextLimit: 65536,
    confirming: false,
    atMenu,
    panel: panel?.view(),
  }
}

let quit = false
let lastCtrlC = 0

function repaint(): void {
  const frame = render(snapshot())
  screen.setCursor(frame.cursor)
  screen.paint(frame.lines)
}

/** Two ctrl+c inside the window quits, the first one only arms. */
function handleDoubleCtrlC(key: { name: string }): boolean {
  if (key.name !== 'ctrl+c') return false
  const now = Date.now()
  if (now - lastCtrlC < 1500) {
    quit = true
    return true
  }
  lastCtrlC = now
  return true
}

/** Keys while a trust-surface panel owns the keyboard. */
function handlePanelKey(key: { name: string; text: string }): void {
  if (panel instanceof ApprovalPanel) {
    handleApprovalKey(panel, key)
    return
  }
  handleQuestionKey(key)
}

/** Keys for a waiting tool approval. */
function handleApprovalKey(approval: ApprovalPanel, key: { name: string }): void {
  if (key.name === '1') {
    notices.push(`allowed ${approval.toolName} once`)
    panel = undefined
    repaint()
    return
  }
  if (key.name === '2' || key.name === 'esc') {
    notices.push(`denied ${approval.toolName}`)
    panel = undefined
    repaint()
    return
  }
  approval.move(key.name === 'up' ? -1 : key.name === 'down' ? 1 : 0)
  repaint()
}

/** Keys for a waiting question set: toggle, answer, or cancel. */
function handleQuestionKey(key: { name: string; text: string }): void {
  if (!(panel instanceof QuestionsPanel)) return
  if (key.name === ' ' || key.text === ' ') {
    panel.toggle()
    repaint()
    return
  }
  if (key.name === 'enter') {
    const state = panel.advance()
    if (state === 'done') {
      const answer = panel.answers()[0]
      notices.push(`answered ${answer?.selected.join(',') ?? ''}`)
      panel = undefined
    }
    repaint()
    return
  }
  if (key.name === 'esc') {
    notices.push('cancelled the question')
    panel = undefined
    repaint()
  }
}


/** The app's own keys: menus, newlines, paste, and submitting the draft. */
function handleAppKey(key: { name: string; text: string }): boolean {
  if (key.name === 'tab' && atMenu.open) {
    acceptAt()
    repaint()
    return true
  }
  if (key.name === 'esc') {
    if (atMenu.open) {
      atMenu.close()
      notices.push('escape closed the menu')
      repaint()
    } else {
      notices.push('escape reached the app')
    }
    return true
  }
  if (key.name === 'shift+enter' || key.name === 'ctrl+j') {
    composer.insert('\n')
    repaint()
    return true
  }
  if (key.name === 'paste') {
    composer.insert(key.text)
    repaint()
    return true
  }
  if (key.name === 'enter') {
    submitDraft()
    return true
  }
  return false
}

/** Enter: an @-completion, a command the subject knows, or a plain prompt. */
function submitDraft(): void {
  const text = composer.value()
  if (atMenu.open) {
    acceptAt()
    repaint()
    return
  }
  if (submitCommand(text)) return
  if (text !== '') {
    messages.push(textMessage('user', text))
    composer.reset()
    repaint()
  }
}

/** The commands the pty subject answers itself; true when one matched. */
function submitCommand(text: string): boolean {
  const commands: Record<string, () => void> = {
    '/ask': () => {
      panel = new ApprovalPanel('shell', 'the command writes outside the workspace', 'rm -rf build')
      composer.reset()
      repaint()
    },
    '/question': () => {
      panel = new QuestionsPanel([
        {
          id: 'q1',
          question: 'Which tests?',
          multiSelect: true,
          options: [{ label: 'unit' }, { label: 'pty' }, { label: 'fleet' }],
        },
      ])
      composer.reset()
      repaint()
    },
    '/clear': () => {
      messages.length = 0
      composer.reset()
      repaint()
    },
    '/lang': () => {
      setLanguage('zh-CN')
      notices.push('language zh-CN')
      composer.reset()
      repaint()
    },
  }
  const run = commands[text]
  if (run === undefined) return false
  run()
  return true
}

/** The plain composer editing chords the subject keeps. */
function handleEditingKey(key: { name: string; text: string }): void {
  if (key.name === 'ctrl+a') {
    composer.home()
    repaint()
    return
  }
  if (key.name === 'ctrl+e') {
    composer.end()
    repaint()
    return
  }
  if (key.name === 'ctrl+u') {
    composer.reset()
    atMenu.close()
    repaint()
    return
  }
  if (key.text !== '') {
    composer.insert(key.text)
    syncAtMenu()
    repaint()
  }
}

const screen = new Screen({
  onKey(key: { name: string; text: string }): void {
    if (handleDoubleCtrlC(key)) return
    if (panel !== undefined) {
      handlePanelKey(key)
      return
    }
    if (handleAppKey(key)) return
    handleEditingKey(key)
  },
  onResize(): void {
    repaint()
  },
})

screen.start()
repaint()

function finish(): void {
  screen.stop()
  const line = `\nSUBJECT-DONE ${String(messages.length)} ${notices.join(' | ')}\n`
  process.stdout.write(line, () => {
    process.exit(0)
  })
  // Belt and braces: never hang the driver if the write never drains.
  setTimeout(() => process.exit(0), 500).unref()
}

function tick(): void {
  if (quit) {
    finish()
    return
  }
  setTimeout(tick, 50)
}

tick()
