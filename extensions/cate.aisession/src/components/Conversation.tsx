// =============================================================================
// The rendered conversation: a thin header (title only) over a scrollable list
// of turns. The turn list mirrors Cate's agent panel — user messages as
// right-aligned bubbles, assistant messages full-width.
// =============================================================================

import type { Conversation as Convo } from '../parsers/types'
import { MessageView } from './Message'

export function ConversationView({ convo, fileName }: { convo: Convo; fileName?: string }) {
  return (
    <div className="conversation">
      <header className="convo-header">
        <span className="convo-title" title={convo.title ?? fileName}>
          {convo.title ?? fileName ?? 'Conversation'}
        </span>
      </header>
      <div className="messages">
        {convo.messages.map((m, i) => (
          <MessageView key={i} message={m} />
        ))}
      </div>
    </div>
  )
}
