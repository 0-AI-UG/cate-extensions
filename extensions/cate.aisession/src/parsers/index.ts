// =============================================================================
// Format detection + dispatch. Sniffs the first lines of a dropped file to pick
// a parser, then normalizes to the common Conversation model. Detection is
// structural (distinctive top-level keys per format) rather than filename-based,
// since every agent writes `.jsonl` and names files differently.
// =============================================================================

import type { Conversation, Source } from './types'
import { deriveTitle, pairToolResults, parseJsonl, reclassifyContextNoise } from './types'
import { parseClaude } from './claude'
import { parseCodex } from './codex'
import { parsePi } from './pi'
import { parseGeneric } from './generic'

export type { Conversation, Message, Part, Role, Source } from './types'

/** Inspect parsed JSONL rows and decide which agent wrote them. */
export function detectSource(rows: Record<string, unknown>[]): Source | null {
  // Only the first rows matter; scan a bounded window for the marker keys.
  const head = rows.slice(0, 100)

  // Codex: every line is { timestamp, type, payload } with these envelope types.
  const codexTypes = new Set(['session_meta', 'response_item', 'event_msg', 'turn_context'])
  if (head.some((o) => 'payload' in o && typeof o.type === 'string' && codexTypes.has(o.type))) {
    return 'codex'
  }

  // Claude Code: turns are typed `user` / `assistant` with a nested `message`.
  if (head.some((o) => (o.type === 'user' || o.type === 'assistant') && o.message != null)) {
    return 'claude'
  }

  // pi: a `session` header, `model_change`, or `message`-typed turns.
  if (head.some((o) => o.type === 'session' || o.type === 'model_change' || o.type === 'message')) {
    return 'pi'
  }

  return null
}

export interface ParseResult {
  conversation: Conversation
  /** Bytes/rows seen, for a small footer. */
  messageCount: number
}

/** Parse a dropped file's text into a Conversation. Throws if nothing
 *  chat-shaped can be recovered, with a message suitable for display. */
export function parseSession(text: string): Conversation {
  const rows = parseJsonl(text)

  let conversation: Conversation | null = null
  if (rows.length > 0) {
    const source = detectSource(rows)
    if (source === 'codex') conversation = parseCodex(rows)
    else if (source === 'claude') conversation = parseClaude(rows)
    else if (source === 'pi') conversation = parsePi(rows)
  }
  // Unknown JSONL or a single JSON document: try the generic chat shapes.
  if (!conversation) conversation = parseGeneric(text)

  if (!conversation) {
    throw new Error('Unrecognized session file — expected a Claude Code, Codex, or pi .jsonl, or a JSON chat export.')
  }

  // Uniform post-processing: fold tool results into their call cards, collapse
  // injected-context turns, and title from the first real user line.
  const messages = reclassifyContextNoise(pairToolResults(conversation.messages))
  // A recognized format can still yield zero turns (e.g. a file of pure
  // bookkeeping lines). Surface that as an error rather than a blank panel.
  if (messages.length === 0) {
    throw new Error('No conversation turns found — the file parsed, but contains no chat messages.')
  }
  return { ...conversation, messages, title: deriveTitle(messages) ?? conversation.title }
}
