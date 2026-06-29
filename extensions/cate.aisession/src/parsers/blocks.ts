// =============================================================================
// Anthropic-style content-block mapping, shared by the Claude Code and pi
// parsers (both persist message content as `string | Block[]` with the same
// block vocabulary: text / thinking / tool_use / tool_result / image).
// =============================================================================

import type { Part } from './types'
import { stringify } from './types'

type Block = Record<string, unknown>

/** Flatten a tool_result's `content` (string, or array of text blocks) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as Block).text === 'string' ? (b as Block).text : stringify(b)))
      .join('\n')
  }
  return stringify(content)
}

/** Map `message.content` (string or block array) to renderable parts. */
export function mapAnthropicContent(content: unknown): Part[] {
  if (content == null) return []
  if (typeof content === 'string') return content.trim() ? [{ kind: 'text', text: content }] : []
  if (!Array.isArray(content)) return [{ kind: 'text', text: stringify(content) }]

  const parts: Part[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const b = raw as Block
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' && b.text.length) parts.push({ kind: 'text', text: b.text })
        break
      case 'thinking': {
        const text = typeof b.thinking === 'string' ? b.thinking : typeof b.text === 'string' ? b.text : ''
        if (text.length) parts.push({ kind: 'thinking', text })
        break
      }
      case 'redacted_thinking':
        parts.push({ kind: 'thinking', text: '[redacted reasoning]' })
        break
      case 'tool_use':
        parts.push({
          kind: 'tool_use',
          name: typeof b.name === 'string' ? b.name : 'tool',
          input: b.input,
          id: typeof b.id === 'string' ? b.id : undefined,
        })
        break
      case 'tool_result':
        parts.push({
          kind: 'tool_result',
          output: toolResultText(b.content),
          isError: b.is_error === true,
        })
        break
      case 'image':
        parts.push({ kind: 'image', alt: 'image' })
        break
      default:
        // Unknown block: show its JSON rather than dropping content silently.
        if (b.text && typeof b.text === 'string') parts.push({ kind: 'text', text: b.text })
        break
    }
  }
  return parts
}
