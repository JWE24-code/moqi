/**
 * Adapters from Harness objects to the shapes this app's surfaces take: the
 * content blocks one sent prompt becomes, the label a background agent gets
 * in a picker, and the login prompt shape the panel draws.
 * @module
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { LoginPrompt } from './tui/panels.ts'

/** Content blocks for one prompt: its text plus any staged image blocks. */
export function promptBlocks(prompt: { text: string; images: readonly ImageAttachmentRef[] }): { type: 'text'; text: string }[] | ({ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef })[] {
  if (prompt.images.length === 0) return [{ type: 'text', text: prompt.text }]
  return [
    { type: 'text', text: prompt.text },
    ...prompt.images.map(
      (attachment): { type: 'image'; attachment: ImageAttachmentRef } => ({
        type: 'image',
        attachment,
      }),
    ),
  ]
}

/**
 * A short label for a background agent: the preset it was composed from when
 * there is one, else its origin, else a short form of the session id.
 */
export function labelFor(agent: Agent): string {
  const header = agent.session.header
  const preset = header.agentPreset
  if (preset !== undefined && preset !== '') return preset
  if (header.origin === 'subagent') return 'subagent'
  return String(header.id).replace(/^session-/, '').slice(0, 8)
}

/**
 * Narrow a Harness `AuthorizationPrompt` to the shape the login panel draws.
 *
 * Drops only the prompt's own `signal` — the caller wires that separately,
 * since the panel may depend on nothing from the Harness, abort signals
 * included.
 */
export function toLoginPrompt(prompt: AuthorizationPrompt): LoginPrompt {
  if (prompt.kind === 'select') {
    return { kind: 'select', message: prompt.message, options: prompt.options }
  }
  return { kind: prompt.kind, message: prompt.message, placeholder: prompt.placeholder }
}
