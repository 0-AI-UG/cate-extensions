// =============================================================================
// The rendered conversation: a header (source, title, model, counts) over a
// scrollable list of turns.
// =============================================================================

import type { Conversation as Convo } from '../parsers/types'
import { MessageView } from './Message'

const SOURCE_LABEL: Record<Convo['source'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'pi',
  generic: 'Chat',
}

export function ConversationView({ convo, fileName }: { convo: Convo; fileName?: string }) {
  return (
    <div className="conversation">
      <header className="convo-header">
        <span className={`source-badge source-${convo.source}`}>{SOURCE_LABEL[convo.source]}</span>
        <div className="convo-titles">
          <div className="convo-title" title={convo.title ?? fileName}>{convo.title ?? fileName ?? 'Conversation'}</div>
          <div className="convo-meta">
            {convo.model && <span>{convo.model}</span>}
            <span>{convo.messages.length} messages</span>
            {convo.cwd && <span className="convo-cwd" title={convo.cwd}>{convo.cwd}</span>}
          </div>
        </div>
      </header>
      <div className="messages">
        {convo.messages.map((m, i) => (
          <MessageView key={i} message={m} />
        ))}
      </div>
    </div>
  )
}
