// =============================================================================
// pi session parser (Cate's bundled agent). Files live at
//   <project>/.cate/pi-agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl
// First line is `{ type: 'session', version, id, cwd }`; `model_change` carries
// the provider/model; conversation turns are `{ type: 'message', message: {
// role, content } }`. The pi-ai message shape differs from Anthropic's in two
// ways we handle here: an assistant `content` array can include `toolCall`
// blocks (mapped in blocks.ts), and a tool *result* is its own message with
// `role: 'toolResult'` (toolName / content / isError) rather than a block.
// =============================================================================

import type { Conversation, Message, Part, Role } from './types'
import { deriveTitle, pruneEmpty } from './types'
import { mapAnthropicContent, toolResultText } from './blocks'

export function parsePi(lines: Record<string, unknown>[]): Conversation {
  const messages: Message[] = []
  let model: string | undefined
  let cwd: string | undefined

  for (const o of lines) {
    if (o.type === 'session' && typeof o.cwd === 'string') cwd = o.cwd
    if (o.type === 'model_change') {
      const id = typeof o.modelId === 'string' ? o.modelId : undefined
      const provider = typeof o.provider === 'string' ? o.provider : undefined
      model = [provider, id].filter(Boolean).join('/') || model
    }
    if (o.type !== 'message') continue

    const msg = o.message as Record<string, unknown> | undefined
    if (!msg) continue
    const ts = typeof o.timestamp === 'string' ? o.timestamp : undefined

    // pi stores a tool result as its own message, not as a block inside a user
    // turn. Surface it as a `tool` turn so the result card renders.
    if (msg.role === 'toolResult') {
      const part: Part = {
        kind: 'tool_result',
        output: toolResultText(msg.content),
        name: typeof msg.toolName === 'string' ? msg.toolName : undefined,
        isError: msg.isError === true,
        id: typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined,
      }
      messages.push({ role: 'tool', parts: [part], ts })
      continue
    }

    const role = (msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user') as Role
    const parts = mapAnthropicContent(msg.content)
    if (parts.length === 0) continue
    messages.push({ role, parts, ts })
  }

  const pruned = pruneEmpty(messages)
  return { source: 'pi', title: deriveTitle(pruned), model, cwd, messages: pruned }
}
