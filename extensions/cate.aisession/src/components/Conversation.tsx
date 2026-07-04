// =============================================================================
// The rendered conversation: a scrollable list of turns filling the panel.
// (The conversation title lives in the Cate panel tab via panel.setTitle, so
// there is no in-panel header.) The turn list mirrors Cate's agent panel —
// user messages as right-aligned bubbles, assistant messages full-width. Very
// long sessions are capped to the most recent turns (with a "show earlier"
// escape hatch) so a multi-MB transcript doesn't render thousands of Markdown
// turns in one commit.
// =============================================================================

import { useEffect, useState } from 'react'
import type { Conversation as Convo } from '../parsers/types'
import { MessageView } from './Message'

/** Initial render budget. Recent turns matter most in a session log. */
const INITIAL_TURNS = 300

export function ConversationView({ convo }: { convo: Convo }) {
  const [showAll, setShowAll] = useState(false)
  // Re-cap when a different conversation is loaded into the same panel.
  useEffect(() => setShowAll(false), [convo])

  const hidden = showAll ? 0 : Math.max(0, convo.messages.length - INITIAL_TURNS)
  const visible = hidden > 0 ? convo.messages.slice(hidden) : convo.messages

  return (
    <div className="conversation">
      <div className="messages">
        {hidden > 0 && (
          <button className="show-earlier" onClick={() => setShowAll(true)}>
            Show {hidden} earlier {hidden === 1 ? 'turn' : 'turns'}
          </button>
        )}
        {visible.map((m, i) => (
          <MessageView key={hidden + i} message={m} />
        ))}
      </div>
    </div>
  )
}
