// =============================================================================
// Claude Code session parser. Files live at
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// One JSON object per line; the conversation is the `user` / `assistant` lines,
// each with a `message: { role, content }` (content = string | Anthropic blocks).
// Everything else (mode, file-history-snapshot, ai-title, attachment, system,
// summary) is bookkeeping we skip. `isMeta` / `isSidechain` lines are injected
// caveats and sub-agent traffic — skipped so the thread reads like the real chat.
// =============================================================================

import type { Conversation, Message, Role } from './types'
import { deriveTitle, pruneEmpty } from './types'
import { mapAnthropicContent } from './blocks'

export function parseClaude(lines: Record<string, unknown>[]): Conversation {
  const messages: Message[] = []
  let model: string | undefined
  let cwd: string | undefined
  let title: string | undefined

  for (const o of lines) {
    if (typeof o.cwd === 'string' && !cwd) cwd = o.cwd
    if (o.type === 'ai-title' && typeof o.title === 'string') title = o.title

    if (o.type !== 'user' && o.type !== 'assistant') continue
    if (o.isMeta === true || o.isSidechain === true) continue

    const msg = o.message as Record<string, unknown> | undefined
    if (!msg) continue
    if (typeof msg.model === 'string' && !model) model = msg.model

    const role = (msg.role === 'assistant' ? 'assistant' : 'user') as Role
    const parts = mapAnthropicContent(msg.content)
    if (parts.length === 0) continue
    messages.push({ role, parts, ts: typeof o.timestamp === 'string' ? o.timestamp : undefined })
  }

  const pruned = pruneEmpty(messages)
  return { source: 'claude', title: title ?? deriveTitle(pruned), model, cwd, messages: pruned }
}
