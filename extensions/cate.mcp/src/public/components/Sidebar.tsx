// Left sidebar: server rows in Cate's FileExplorer idiom (28px rows, status
// dot + name + muted transport suffix) plus pinned Discover/Endpoint nav rows.
// Row actions live in the detail view, never here.

import { useState } from 'react'
import type { StateSnapshot } from '../../shared/types'
import type { View } from '../view'
import { BracesIcon, BroadcastIcon, CompassIcon, DashboardIcon, PlusIcon, SidebarIcon, StatusDot, openConfigFile } from './util'

const FILTER_THRESHOLD = 8

export function Sidebar({
  state,
  view,
  onSelect,
  onAdd,
  onCollapse,
}: {
  state: StateSnapshot
  view: View
  onSelect: (view: View) => void
  onAdd: () => void
  onCollapse: () => void
}) {
  const [filter, setFilter] = useState('')
  const f = filter.trim().toLowerCase()
  const servers = f ? state.servers.filter((s) => s.name.toLowerCase().includes(f)) : state.servers

  return (
    <aside className="mcp-side">
      <div className="mcp-side__head">
        <button
          className="cate-iconbtn"
          type="button"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          onClick={onCollapse}
        >
          <SidebarIcon />
        </button>
        <span className="mcp-side__headspacer" />
        <button className="cate-iconbtn" type="button" title="Open mcp.json" onClick={() => openConfigFile(state.configPath)}>
          <BracesIcon />
        </button>
        <button className="cate-iconbtn" type="button" title="Add server" onClick={onAdd}>
          <PlusIcon />
        </button>
      </div>
      {state.servers.length > FILTER_THRESHOLD && (
        <div className="mcp-side__filter">
          <input className="cate-input" value={filter} placeholder="Filter" onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className="mcp-side__list">
        {servers.map((server) => (
          <button
            key={server.name}
            type="button"
            className={`mcp-item${view.kind === 'server' && view.name === server.name ? ' mcp-item--selected' : ''}`}
            onClick={() => onSelect({ kind: 'server', name: server.name })}
          >
            <StatusDot status={server.status} />
            <span className="mcp-item__name">{server.name}</span>
            <span className="mcp-item__suffix">{server.transport === 'stdio' ? 'stdio' : 'http'}</span>
          </button>
        ))}
      </div>
      <div className="mcp-side__foot">
        <button
          type="button"
          className={`mcp-item${view.kind === 'dashboard' ? ' mcp-item--selected' : ''}`}
          onClick={() => onSelect({ kind: 'dashboard' })}
        >
          <span className="mcp-item__icon">
            <DashboardIcon />
          </span>
          <span className="mcp-item__name">Dashboard</span>
        </button>
        <button
          type="button"
          className={`mcp-item${view.kind === 'discover' ? ' mcp-item--selected' : ''}`}
          onClick={() => onSelect({ kind: 'discover' })}
        >
          <span className="mcp-item__icon">
            <CompassIcon />
          </span>
          <span className="mcp-item__name">Discover</span>
        </button>
        <button
          type="button"
          className={`mcp-item${view.kind === 'endpoint' ? ' mcp-item--selected' : ''}`}
          onClick={() => onSelect({ kind: 'endpoint' })}
        >
          <span className="mcp-item__icon">
            <BroadcastIcon />
          </span>
          <span className="mcp-item__name">Endpoint</span>
        </button>
      </div>
    </aside>
  )
}
