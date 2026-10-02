/**
 * Transcript export: turn the in-app message list into a markdown document.
 *
 * Pure and free of Harness imports, like everything under `./tui/`, so it can
 * be tested without a profile.
 * @module
 */

import { messageText, type Message } from './state.ts'

/**
 * Render a transcript as markdown.
 *
 * User turns become `## >`-quoted sections and assistant turns `##` sections.
 * An assistant turn is written in the order it happened — each tool call as a
 * checklist line between the prose it came between — because a document that
 * collects the calls at the end tells you what the agent did but not when, and
 * the reason it said the next thing is usually what the call returned.
 */
export function transcriptMarkdown(messages: readonly Message[], title: string): string {
  const lines: string[] = [`# ${title === '' ? 'dsh transcript' : title}`, '']
  for (const message of messages) {
    if (message.role === 'user') {
      lines.push('## >', '', ...indented(messageText(message)), '')
      continue
    }
    lines.push(...assistantSection(message))
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** One assistant turn: the heading, the hidden thinking, then the segments. */
function assistantSection(message: Message): string[] {
  const label = message.command === undefined ? '' : ` (${message.command.ok ? 'ok' : 'failed'})`
  const lines: string[] = [`## assistant${label}`, '']
  if (message.reasoning !== undefined && message.reasoning !== '') {
    lines.push('<details><summary>thinking</summary>', '', '```', ...message.reasoning.split('\n'), '```', '', '</details>', '')
  }
  for (const segment of message.segments) {
    if (segment.kind === 'text') {
      if (segment.text.trim() !== '') lines.push(...segment.text.trim().split('\n'), '')
      continue
    }
    lines.push(...toolLine(segment.tool), '')
  }
  return lines
}

/** One tool call as a checklist line, marked by how it ended. */
function toolLine(tool: { name: string; status: string; detail?: string }): string[] {
  const mark = tool.status === 'ok' ? 'x' : tool.status === 'error' ? ' ' : '~'
  const detail = tool.detail === undefined ? '' : ` — ${tool.detail}`
  return [`- [${mark}] \`${tool.name}\`${detail}`]
}

/** Quote a user turn the way an email client quotes a reply. */
function indented(text: string): string[] {
  if (text.trim() === '') return []
  return text.split('\n').map((line) => (line === '' ? '>' : `> ${line}`))
}
