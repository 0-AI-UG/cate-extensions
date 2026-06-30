// =============================================================================
// One conversation turn, mirroring Cate's agent panel. User text renders as a
// right-aligned plain-text bubble; assistant text renders full-width as
// Markdown. Tool calls/results render full-width as cards in stream order.
// Injected-context turns (reclassified to `system`) collapse into a thin,
// expandable divider so they don't drown the real conversation.
// =============================================================================

import { useState } from 'react'
import type { Message as Msg, Part } from '../parsers/types'
import { renderMarkdown } from '../lib/markdown'
import { ToolUse, ToolResult } from './ToolBlock'

function Markdown({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking">
      <button className="thinking-head" onClick={() => setOpen((o) => !o)}>
        Thinking
      </button>
      {open && <pre className="thinking-body">{text}</pre>}
    </div>
  )
}

function renderPart(part: Part, key: number, plainText = false) {
  switch (part.kind) {
    case 'text':
      return plainText ? (
        <div key={key} className="plain-text">{part.text}</div>
      ) : (
        <Markdown key={key} text={part.text} />
      )
    case 'thinking':
      return <Thinking key={key} text={part.text} />
    case 'tool_use':
      return <ToolUse key={key} part={part} />
    case 'tool_result':
      return <ToolResult key={key} part={part} />
    case 'image':
      return <div key={key} className="image-part">🖼 {part.alt}</div>
    default:
      return null
  }
}

function SystemTurn({ message }: { message: Msg }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="row system">
      <button className="system-head" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} context
      </button>
      {open && <div className="system-body">{message.parts.map((p, i) => renderPart(p, i))}</div>}
    </div>
  )
}

export function MessageView({ message }: { message: Msg }) {
  if (message.role === 'system') return <SystemTurn message={message} />

  // Split conversational text/thinking (the role-aligned content) from tool
  // blocks (which span full width below).
  const contentParts = message.parts.filter((p) => p.kind === 'text' || p.kind === 'thinking' || p.kind === 'image')
  const toolParts = message.parts.filter((p) => p.kind === 'tool_use' || p.kind === 'tool_result')
  const isUser = message.role === 'user'

  return (
    <div className={`row ${message.role}`}>
      {contentParts.length > 0 &&
        (isUser ? (
          // User: a right-aligned plain-text bubble (no Markdown), like the agent panel.
          <div className="bubble">{contentParts.map((p, i) => renderPart(p, i, true))}</div>
        ) : (
          // Assistant: full-width Markdown, no bubble.
          <div className="assistant-content">{contentParts.map((p, i) => renderPart(p, i))}</div>
        ))}
      {toolParts.length > 0 && <div className="tools">{toolParts.map((p, i) => renderPart(p, i))}</div>}
    </div>
  )
}
