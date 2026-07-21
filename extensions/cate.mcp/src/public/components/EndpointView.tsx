// Endpoint view: the aggregated MCP endpoint as two definition rows (URL and
// Authorization header, each copyable), then a one-click install of that
// endpoint into each supported coding agent's workspace-local config.
//
// The endpoint only serves while this panel is open, and its port/token are
// reminted each Cate session — so the install is a snapshot. We say the first
// out loud, and flag a stale entry (port changed since install) with an Update
// action rather than pretending it still points somewhere live.

import { useCallback, useEffect, useState } from 'react'
import type { AgentTargetStatus, EndpointInfo } from '../../shared/types'
import { fetchAgents, installAgent, uninstallAgent } from '../api'
import { CopyIconButton, EyeIcon, EyeOffIcon } from './util'

function AgentRow({
  agent,
  busy,
  onInstall,
  onRemove,
}: {
  agent: AgentTargetStatus
  busy: boolean
  onInstall: () => void
  onRemove: () => void
}) {
  return (
    <div className="mcp-agentrow">
      <span className="mcp-agentrow__label">{agent.label}</span>
      <span className="mcp-agentrow__path mcp-mono" title={agent.reason ?? agent.path}>
        {agent.supported ? agent.path : agent.reason}
      </span>
      <span className="mcp-agentrow__actions">
        {!agent.supported ? (
          <span className="mcp-muted" title={agent.reason}>
            Unavailable
          </span>
        ) : agent.installed ? (
          <>
            {agent.stale && (
              <button className="cate-btn cate-btn--small" type="button" disabled={busy} title="Point at the current endpoint" onClick={onInstall}>
                Update
              </button>
            )}
            {!agent.stale && <span className="mcp-agentrow__ok">Installed</span>}
            <button className="cate-btn cate-btn--small" type="button" disabled={busy} onClick={onRemove}>
              Remove
            </button>
          </>
        ) : (
          <button className="cate-btn cate-btn--small" type="button" disabled={busy} onClick={onInstall}>
            Install
          </button>
        )}
      </span>
    </div>
  )
}

export function EndpointView({ endpoint }: { endpoint: EndpointInfo }) {
  const [revealed, setRevealed] = useState(false)
  const [agents, setAgents] = useState<AgentTargetStatus[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const masked = endpoint.authHeader.replace(/Bearer .*/, 'Bearer ••••••••')

  const load = useCallback(async (): Promise<void> => {
    const res = await fetchAgents()
    if (res.ok && res.agents) setAgents(res.agents)
    else setError(res.error ?? 'could not load agents')
  }, [])

  // Reload whenever the endpoint URL changes too: a new session mints a new
  // port, which turns a previously matching install stale.
  useEffect(() => {
    void load()
  }, [load, endpoint.url])

  async function act(id: string, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    setBusyId(id)
    setError(null)
    const res = await fn()
    if (!res.ok) setError(res.error ?? 'action failed')
    await load()
    setBusyId(null)
  }

  return (
    <div className="mcp-view">
      <div className="mcp-def">
        <span className="mcp-def__key">URL</span>
        <span className="mcp-def__value mcp-mono">{endpoint.url}</span>
        <CopyIconButton text={endpoint.url} title="Copy URL" />
      </div>
      <div className="mcp-def">
        <span className="mcp-def__key">Authorization</span>
        <span className="mcp-def__value mcp-mono">{revealed ? endpoint.authHeader : masked}</span>
        <button
          className="cate-iconbtn"
          type="button"
          title={revealed ? 'Hide' : 'Reveal'}
          onClick={() => setRevealed((r) => !r)}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </button>
        <CopyIconButton text={endpoint.authHeader} title="Copy header" />
      </div>
      <div className="mcp-muted" title="Streamable HTTP; every running server's tools, resources and prompts, namespaced <server>__<name>">
        Any MCP client can connect here.
      </div>

      <div className="cate-grouplabel mcp-grouplabel">Install into agents</div>
      {error && <div className="mcp-inline-error">{error}</div>}
      {agents && (
        <div className="mcp-agents">
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              busy={busyId === agent.id}
              onInstall={() => void act(agent.id, () => installAgent(agent.id))}
              onRemove={() => void act(agent.id, () => uninstallAgent(agent.id))}
            />
          ))}
        </div>
      )}
    </div>
  )
}
