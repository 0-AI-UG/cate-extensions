// Default view: server health at a glance (Overview) plus a live feed of tool
// calls flowing through the aggregated endpoint (Activity). The overview is
// derived from the /api/state snapshot the panel already polls; the feed
// self-fetches /api/activity on its own 2s poll (visibility-gated, mirroring
// main.tsx) so recording a call never has to churn the state serial.

import { useCallback, useEffect, useState } from 'react'
import type { ActivityEntry, ServerSnapshot, StateSnapshot } from '../../shared/types'
import { fetchActivity } from '../api'
import { StatusDot, formatUptime } from './util'

const POLL_MS = 2000
const FEED_LIMIT = 100

/** Per-server meta line: tool count + uptime, or a problem word in warn tone. */
function serverMeta(server: ServerSnapshot): { text: string; warn: boolean } {
  if (server.status === 'needs-auth') return { text: 'needs auth', warn: true }
  if (server.status === 'error') return { text: 'error', warn: true }
  if (server.status === 'disabled') return { text: 'disabled', warn: false }
  const parts = [`${server.tools.length} tools`]
  const up = formatUptime(server.startedAt)
  if (up) parts.push(`up ${up}`)
  return { text: parts.join(' · '), warn: server.status === 'degraded' }
}

function Stat({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="mcp-dash__stat">
      <span className={`mcp-dash__statval${warn && value > 0 ? ' mcp-dash__statval--warn' : ''}`}>{value}</span>
      <span className="mcp-dash__statlabel">{label}</span>
    </div>
  )
}

export function DashboardView({ state }: { state: StateSnapshot }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [summary, setSummary] = useState<{ total: number; errors: number }>({ total: 0, errors: 0 })

  const load = useCallback(async (): Promise<void> => {
    const res = await fetchActivity(FEED_LIMIT)
    if (res.ok && res.entries) {
      setEntries(res.entries)
      if (res.summary) setSummary(res.summary)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, POLL_MS)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  const servers = state.servers
  const totalTools = servers.reduce((n, s) => n + s.tools.length, 0)
  const running = servers.filter((s) => s.status === 'running').length
  const degraded = servers.filter((s) => s.status === 'degraded').length
  const needsAuth = servers.filter((s) => s.status === 'needs-auth').length

  return (
    <div className="mcp-view mcp-dash">
      <div className="mcp-dash__strip">
        <span className="mcp-dot mcp-dot--running" />
        <span className="mcp-dash__striplabel">Endpoint live</span>
        <span className="mcp-dash__stripurl mcp-mono" title={state.endpoint.url}>
          {state.endpoint.url}
        </span>
        <span className="mcp-dash__stripcount">
          {servers.length} servers · {totalTools} tools
        </span>
      </div>

      <div className="mcp-dash__stats">
        <Stat label="running" value={running} />
        <Stat label="degraded" value={degraded} warn />
        <Stat label="needs auth" value={needsAuth} warn />
        <Stat label="tools" value={totalTools} />
        <Stat label="recent calls" value={summary.total} />
        <Stat label="errors" value={summary.errors} warn />
      </div>

      {servers.length === 0 ? (
        <div className="mcp-dash__hint">
          No servers yet. Add a server, or open Discover to browse the registry.
        </div>
      ) : (
        <>
          <div className="cate-grouplabel mcp-grouplabel">Servers</div>
          <div className="mcp-dash__grid">
            {servers.map((server) => {
              const meta = serverMeta(server)
              return (
                <div className="mcp-dash__server" key={server.name}>
                  <StatusDot status={server.status} />
                  <span className="mcp-dash__servername" title={server.name}>
                    {server.name}
                  </span>
                  <span className={`mcp-dash__servermeta${meta.warn ? ' mcp-dash__servermeta--warn' : ''}`}>
                    {meta.text}
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}

      <div className="cate-grouplabel mcp-grouplabel">
        Activity <span className="mcp-dash__note">recent</span>
      </div>
      {entries.length === 0 ? (
        <div className="mcp-dash__empty">No calls yet — connect an agent to the endpoint.</div>
      ) : (
        <div className="mcp-dash__feed">
          {entries.map((e, i) => (
            <div className="mcp-dash__row" key={i}>
              <span className="mcp-dash__time">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="mcp-dash__tool mcp-mono" title={`${e.server}__${e.tool}`}>
                {e.server}__{e.tool}
              </span>
              {e.client && <span className="mcp-dash__chip">{e.client}</span>}
              <span className="mcp-dash__dur">{e.durationMs}ms</span>
              <span className={`mcp-dash__result${e.isError ? ' mcp-dash__result--err' : ''}`}>
                {e.isError ? 'err' : 'ok'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
