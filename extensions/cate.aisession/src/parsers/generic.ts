// =============================================================================
// Generic fallback parser for chat exports that aren't one of the known agent
// formats: a JSON array of { role, content } messages, an object with a
// `messages` array (OpenAI/Anthropic request shape), or JSONL of { role,
// content } rows. Content may be a plain string or Anthropic-style blocks.
// =============================================================================

import type { Conversation, Message, Role } from './types'
import { deriveTitle, parseJsonl, pruneEmpty } from './types'
import { mapAnthropicContent } from './blocks'

function toMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!('role' in o) || !('content' in o)) return null
  const role = (o.role === 'assistant' ? 'assistant'
    : o.role === 'system' ? 'system'
    : o.role === 'tool' ? 'tool'
    : 'user') as Role
  const parts = mapAnthropicContent(o.content)
  if (parts.length === 0) return null
  return { role, parts }
}

/** Returns a Conversation or null if nothing chat-shaped could be recovered. */
export function parseGeneric(raw: string): Conversation | null {
  let rows: unknown[] | null = null

  const trimmed = raw.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const doc = JSON.parse(trimmed)
      if (Array.isArray(doc)) rows = doc
      else if (doc && Array.isArray((doc as Record<string, unknown>).messages)) {
        rows = (doc as Record<string, unknown>).messages as unknown[]
      }
    } catch {
      /* fall through to JSONL */
    }
  }
  if (!rows) rows = parseJsonl(raw)

  const messages = rows.map(toMessage).filter((m): m is Message => m !== null)
  if (messages.length === 0) return null

  const pruned = pruneEmpty(messages)
  return { source: 'generic', title: deriveTitle(pruned), messages: pruned }
}
