// Main-area server detail: compact header (name, status word, transport),
// one row of small lifecycle actions, the needs-auth connect flow, inventory
// sections (28px rows that open the playground modal), and collapsed Log /
// History sections. Copy stays out of the chrome; tooltips carry the detail.

import { useState } from 'react'
import type { ServerSnapshot } from '../../shared/types'
import { oauthStart, serverAction, deleteServer, type ServerAction } from '../api'
import type { HistoryEntry } from './Playground'
import type { PlayItem } from './PlaygroundDrawer'
import { CopyIconButton, InlineError, StatusDot, copyText, formatUptime, openUrlInPanel, statusWord } from './util'

function AuthBlock({ server }: { server: ServerSnapshot }) {
  const [authUrl, setAuthUrl] = useState<string | null>(server.authUrl)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function connect(): Promise<void> {
    setBusy(true)
    setError(null)
    const res = await oauthStart(server.name)
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? 'could not start authorization')
      return
    }
    setAuthUrl(res.authUrl ?? null)
  }

  const url = authUrl ?? server.authUrl
  return (
    <div className="mcp-auth">
      <div className="mcp-auth__row">
        <button
          className="cate-btn cate-btn--primary"
          type="button"
          disabled={busy}
          title="Approve access in the browser; the server connects automatically afterwards"
          onClick={() => void connect()}
        >
          {busy ? 'Starting…' : url ? 'Restart authorization' : 'Connect'}
        </button>
      </div>
      {url && (
        <div className="mcp-auth__link">
          <a
            className="mcp-authlink"
            href={url}
            title="Open the authorization page in a browser panel"
            onClick={(e) => {
              e.preventDefault()
              void openUrlInPanel(url).then((ok) => {
                if (!ok) void copyText(url)
              })
            }}
          >
            {url}
          </a>
          <CopyIconButton text={url} title="Copy link" />
        </div>
      )}
      <InlineError error={error} />
    </div>
  )
}

function InvRow({
  name,
  desc,
  title,
  aux = false,
  onClick,
}: {
  name: string
  desc: string
  title?: string
  /** De-emphasized utility row (e.g. free-form resource read). */
  aux?: boolean
  onClick: () => void
}) {
  return (
    <button className={`mcp-invrow${aux ? ' mcp-invrow--aux' : ''}`} type="button" title={title ?? desc} onClick={onClick}>
      <span className="mcp-invrow__name">{name}</span>
      <span className="mcp-invrow__desc">{desc}</span>
    </button>
  )
}

export function ServerView({
  server,
  history,
  onEdit,
  onOpenPlay,
  refresh,
}: {
  server: ServerSnapshot
  history: HistoryEntry[]
  onEdit: () => void
  onOpenPlay: (item: PlayItem) => void
  refresh: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [filter, setFilter] = useState('')

  async function act(action: ServerAction): Promise<void> {
    setBusy(true)
    setActionError(null)
    const result = await serverAction(server.name, action)
    setBusy(false)
    if (!result.ok) setActionError(`${action} failed: ${result.error}`)
    refresh()
  }

  async function remove(): Promise<void> {
    setBusy(true)
    const result = await deleteServer(server.name)
    setBusy(false)
    setConfirmDelete(false)
    if (!result.ok) setActionError(`delete failed: ${result.error}`)
    refresh()
  }

  const stoppedish = server.status === 'stopped' || server.status === 'error' || server.status === 'needs-auth'
  const live = server.status === 'running' || server.status === 'degraded'
  const cfg = server.config

  const f = filter.trim().toLowerCase()
  const tools = server.tools.filter(
    (t) => !f || t.name.toLowerCase().includes(f) || (t.description ?? '').toLowerCase().includes(f),
  )
  const resources = server.resources.filter(
    (r) => !f || r.uri.toLowerCase().includes(f) || (r.name ?? '').toLowerCase().includes(f),
  )
  const prompts = server.prompts.filter(
    (p) => !f || p.name.toLowerCase().includes(f) || (p.description ?? '').toLowerCase().includes(f),
  )

  const handshakeTitle = server.handshake
    ? `Reports as ${server.handshake.name} ${server.handshake.version}` +
      (server.handshake.capabilities.length > 0 ? ` (${server.handshake.capabilities.join(', ')})` : '')
    : undefined

  return (
    <div className="mcp-view">
      <header className="mcp-detail__head">
        <span className="mcp-detail__name" title={handshakeTitle}>
          {server.name}
        </span>
        <span className="mcp-detail__status">
          <StatusDot status={server.status} />
          {statusWord(server.status, server.restartAttempt)}
        </span>
        {server.startedAt !== null && <span className="mcp-detail__uptime">up {formatUptime(server.startedAt)}</span>}
        <span className="cate-chip">{server.transport}</span>
      </header>

      <div className="mcp-detail__actions">
        {server.status === 'disabled' ? (
          <button className="cate-btn cate-btn--small" type="button" disabled={busy} onClick={() => void act('enable')}>
            Enable
          </button>
        ) : (
          <>
            {stoppedish && (
              <button className="cate-btn cate-btn--small" type="button" disabled={busy} onClick={() => void act('start')}>
                Start
              </button>
            )}
            {!stoppedish && (
              <>
                <button className="cate-btn cate-btn--small" type="button" disabled={busy} onClick={() => void act('stop')}>
                  Stop
                </button>
                <button className="cate-btn cate-btn--small" type="button" disabled={busy} onClick={() => void act('restart')}>
                  Restart
                </button>
              </>
            )}
            <button
              className="cate-btn cate-btn--small"
              type="button"
              disabled={busy}
              title="Keep in config, never start"
              onClick={() => void act('disable')}
            >
              Disable
            </button>
          </>
        )}
        <button className="cate-btn cate-btn--small" type="button" onClick={onEdit}>
          Edit
        </button>
        <button className="cate-btn cate-btn--small" type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>
          Delete
        </button>
      </div>

      {confirmDelete && (
        <div className="mcp-confirm">
          <span>Remove "{server.name}" from mcp.json?</span>
          <button className="cate-btn cate-btn--small" type="button" onClick={() => void remove()}>
            Delete
          </button>
          <button className="cate-btn cate-btn--small" type="button" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      )}

      <div className="mcp-detail__meta mcp-mono" title={server.transport === 'stdio' ? 'Command' : 'URL'}>
        {server.transport === 'stdio' ? `${cfg.command ?? ''} ${(cfg.args ?? []).join(' ')}`.trim() : cfg.url}
      </div>

      <InlineError error={actionError} />
      {server.error && <div className="mcp-errorcard">{server.error}</div>}
      {server.configError && <div className="mcp-errorcard">Config problem: {server.configError}</div>}

      {server.status === 'needs-auth' && <AuthBlock server={server} />}

      {live && (
        <div className="mcp-inv">
          {server.tools.length + server.resources.length + server.prompts.length > 8 && (
            <input
              className="cate-input mcp-inv__filter"
              value={filter}
              placeholder="Filter"
              onChange={(e) => setFilter(e.target.value)}
            />
          )}

          <div className="cate-grouplabel mcp-grouplabel">Tools ({tools.length})</div>
          {tools.map((tool) => (
            <InvRow
              key={tool.name}
              name={tool.name}
              desc={tool.description ?? ''}
              onClick={() => onOpenPlay({ kind: 'tool', name: tool.name })}
            />
          ))}

          <div className="cate-grouplabel mcp-grouplabel">Resources ({resources.length})</div>
          {resources.map((res) => (
            <InvRow
              key={res.uri}
              name={res.name ?? res.uri}
              desc={res.uri}
              onClick={() => onOpenPlay({ kind: 'resource', uri: res.uri })}
            />
          ))}
          <InvRow name="Read by URI" desc="" title="Read any resource URI" aux onClick={() => onOpenPlay({ kind: 'resource' })} />

          <div className="cate-grouplabel mcp-grouplabel">Prompts ({prompts.length})</div>
          {prompts.map((prompt) => (
            <InvRow
              key={prompt.name}
              name={prompt.name}
              desc={prompt.description ?? ''}
              onClick={() => onOpenPlay({ kind: 'prompt', name: prompt.name })}
            />
          ))}
        </div>
      )}

      {server.transport === 'stdio' && server.stderrTail.length > 0 && (
        <details className="mcp-fold">
          <summary className="cate-grouplabel mcp-grouplabel">Log</summary>
          <pre className="cate-pre mcp-stderr">{server.stderrTail.join('\n')}</pre>
        </details>
      )}

      {history.length > 0 && (
        <details className="mcp-fold">
          <summary className="cate-grouplabel mcp-grouplabel">History</summary>
          <div className="mcp-history">
            {history.map((entry, i) => (
              <div className="mcp-history__row" key={i}>
                <span>{new Date(entry.at).toLocaleTimeString()}</span>
                <span>{entry.kind}</span>
                <span>{entry.label}</span>
                <span>{entry.ok ? 'ok' : 'error'}</span>
                {entry.durationMs !== undefined && <span>{entry.durationMs}ms</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
