// =============================================================================
// Codex (OpenAI) session parser. Files live at
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
// Each line is `{ timestamp, type, payload }`. The conversation is carried by
// `response_item` payloads:
//   - message            { role, content: [{type:input_text|output_text, text}] }
//   - reasoning          { summary: [{type:summary_text, text}], ... }  (thinking)
//   - function_call      { name, arguments }                            (tool call)
//   - function_call_output { call_id, output }                          (tool result)
//   - custom_tool_call / custom_tool_call_output                        (likewise)
// `session_meta` carries cwd; `event_msg` / `turn_context` are runtime noise.
// Items are kept in stream order, each becoming its own message so calls and
// their outputs interleave the way they actually ran.
// =============================================================================

import type { Conversation, Message, Part, Role } from './types'
import { deriveTitle, pruneEmpty, stringify } from './types'

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return stringify(content)
  return content
    .map((b) => (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string'
      ? (b as Record<string, unknown>).text as string
      : ''))
    .filter(Boolean)
    .join('\n')
}

function reasoningText(summary: unknown): string {
  if (!Array.isArray(summary)) return ''
  return summary
    .map((b) => (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string'
      ? (b as Record<string, unknown>).text as string
      : ''))
    .filter(Boolean)
    .join('\n\n')
}

function tryParseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args
  try { return JSON.parse(args) } catch { return args }
}

export function parseCodex(lines: Record<string, unknown>[]): Conversation {
  const messages: Message[] = []
  let cwd: string | undefined
  let model: string | undefined

  const push = (role: Role, part: Part, ts?: unknown): void => {
    messages.push({ role, parts: [part], ts: typeof ts === 'string' ? ts : undefined })
  }

  for (const o of lines) {
    const ts = o.timestamp
    if (o.type === 'session_meta') {
      const p = o.payload as Record<string, unknown> | undefined
      if (p) {
        if (typeof p.cwd === 'string') cwd = p.cwd
        if (typeof p.model === 'string') model = p.model
      }
      continue
    }
    if (o.type !== 'response_item') continue
    const p = o.payload as Record<string, unknown> | undefined
    if (!p) continue

    switch (p.type) {
      case 'message': {
        const role = (p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : 'system') as Role
        const text = messageText(p.content)
        if (text.trim()) push(role, { kind: 'text', text }, ts)
        break
      }
      case 'reasoning': {
        const text = reasoningText(p.summary)
        if (text.trim()) push('assistant', { kind: 'thinking', text }, ts)
        break
      }
      case 'function_call':
      case 'custom_tool_call':
        push('assistant', {
          kind: 'tool_use',
          name: typeof p.name === 'string' ? p.name : 'tool',
          input: tryParseArgs(p.arguments ?? p.input),
          id: typeof p.call_id === 'string' ? p.call_id : undefined,
        }, ts)
        break
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const out = p.output
        push('tool', {
          kind: 'tool_result',
          output: typeof out === 'string' ? out : stringify(out),
          id: typeof p.call_id === 'string' ? p.call_id : undefined,
        }, ts)
        break
      }
      default:
        break
    }
  }

  const pruned = pruneEmpty(messages)
  return { source: 'codex', title: deriveTitle(pruned), model, cwd, messages: pruned }
}
