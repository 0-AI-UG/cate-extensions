// =============================================================================
// One conversation turn. Text/thinking render as a chat bubble aligned by role
// (user right, assistant left); tool calls/results render full-width as cards in
// stream order. Injected-context turns (reclassified to `system`) collapse into
// a thin, expandable divider so they don't drown the real conversation.
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
        {open ? '▾' : '▸'} Thinking
      </button>
      {open && <div className="thinking-body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />}
    </div>
  )
}

function renderPart(part: Part, key: number) {
  switch (part.kind) {
    case 'text':
      return <Markdown key={key} text={part.text} />
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
      {open && <div className="system-body">{message.parts.map(renderPart)}</div>}
    </div>
  )
}

export function MessageView({ message }: { message: Msg }) {
  if (message.role === 'system') return <SystemTurn message={message} />

  // Split conversational text/thinking (which live in the aligned bubble) from
  // tool blocks (which span full width below).
  const bubbleParts = message.parts.filter((p) => p.kind === 'text' || p.kind === 'thinking' || p.kind === 'image')
  const toolParts = message.parts.filter((p) => p.kind === 'tool_use' || p.kind === 'tool_result')

  return (
    <div className={`row ${message.role}`}>
      {bubbleParts.length > 0 && (
        <div className="bubble">{bubbleParts.map(renderPart)}</div>
      )}
      {toolParts.length > 0 && <div className="tools">{toolParts.map((p, i) => renderPart(p, i))}</div>}
    </div>
  )
}
