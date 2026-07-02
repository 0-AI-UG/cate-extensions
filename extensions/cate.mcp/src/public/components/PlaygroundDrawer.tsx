// Playground drawer: hosts the tool / resource / prompt playgrounds for one
// inventory item, opened from a ServerView row.

import type { ServerSnapshot } from '../../shared/types'
import { PromptPlayground, ResourcePlayground, ToolPlayground, type HistoryEntry } from './Playground'
import { CloseIcon } from './util'

export type PlayItem =
  | { kind: 'tool'; name: string }
  | { kind: 'resource'; uri?: string }
  | { kind: 'prompt'; name: string }

export function PlaygroundDrawer({
  server,
  item,
  onHistory,
  onClose,
}: {
  server: ServerSnapshot
  item: PlayItem
  onHistory: (entry: HistoryEntry) => void
  onClose: () => void
}) {
  const tool = item.kind === 'tool' ? server.tools.find((t) => t.name === item.name) : undefined
  const prompt = item.kind === 'prompt' ? server.prompts.find((p) => p.name === item.name) : undefined
  const title = item.kind === 'tool' ? item.name : item.kind === 'prompt' ? item.name : (item.uri ?? 'Read resource')
  const desc = tool?.description ?? prompt?.description

  return (
    <>
      <div className="mcp-scrim" onClick={onClose} />
      <div className="mcp-modal" role="dialog" aria-label={title}>
        <div className="mcp-modal__head">
          <span className="mcp-modal__title mcp-mono" title={desc}>
            {title}
          </span>
          <span className="mcp-modal__spacer" />
          <button className="cate-iconbtn" type="button" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="mcp-modal__body">
          {desc && <div className="mcp-muted">{desc}</div>}
          {item.kind === 'tool' &&
            (tool ? (
              <ToolPlayground server={server.name} tool={tool} onHistory={onHistory} />
            ) : (
              <div className="mcp-muted">Tool no longer listed</div>
            ))}
          {item.kind === 'resource' && (
            <ResourcePlayground server={server.name} initialUri={item.uri} onHistory={onHistory} />
          )}
          {item.kind === 'prompt' &&
            (prompt ? (
              <PromptPlayground server={server.name} prompt={prompt} onHistory={onHistory} />
            ) : (
              <div className="mcp-muted">Prompt no longer listed</div>
            ))}
        </div>
      </div>
    </>
  )
}
