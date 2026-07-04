// =============================================================================
// MCP Servers, the Cate extension panel.
//
// A native manager for the MCP servers configured in this workspace's
// .cate/mcp.json: lifecycle (start/stop/restart/enable/disable with supervised
// stdio children and remote connections), live inventory browsing, a tool
// playground, the official-registry Discover view, OAuth for remote servers,
// and the aggregated /mcp endpoint.
//
// Layout: left sidebar (server rows + pinned Discover/Endpoint nav) and a main
// detail area; add/edit and playground open as centered modals. The canvas
// node supplies the title bar, so the panel has no header of its own.
//
// Cate-native glue: kit theme (initTheme), cate.editor.openFile (edit
// mcp.json in Cate's editor), cate.storage.panel (remember the active view),
// cate.ui.notify (sparingly, for background failures).
//
// Live updates: polls GET /api/state every 2s gated by a monotonic state
// serial (the numbered-id convention; the server answers `unchanged` cheaply).
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { StateSnapshot } from '../shared/types'
import { fetchState } from './api'
import { Sidebar } from './components/Sidebar'
import { ServerView } from './components/ServerView'
import { DiscoverView } from './components/DiscoverView'
import { EndpointView } from './components/EndpointView'
import { AddEditDrawer, type AddPrefill } from './components/AddEditDrawer'
import { PlaygroundDrawer, type PlayItem } from './components/PlaygroundDrawer'
import type { HistoryEntry } from './components/Playground'
import { BroadcastIcon, SidebarIcon, openConfigFile } from './components/util'
import '../_kit/cate-kit.css'
import './styles.css'
import { initTheme } from '../_kit/theme'

const POLL_MS = 2000
const VIEW_KEY = 'activeTab'

export type View = { kind: 'server'; name: string } | { kind: 'discover' } | { kind: 'endpoint' }

type Drawer =
  | { kind: 'add'; prefill?: AddPrefill }
  | { kind: 'edit'; name: string }
  | { kind: 'play'; server: string; item: PlayItem }
  | null

function serializeView(view: View): string {
  return view.kind === 'server' ? `server:${view.name}` : view.kind
}

function parseView(raw: unknown): View | null {
  if (typeof raw !== 'string') return null
  if (raw === 'discover' || raw === 'endpoint') return { kind: raw }
  if (raw.startsWith('server:')) return { kind: 'server', name: raw.slice('server:'.length) }
  return null // legacy 'servers' value falls through to auto-select
}

function App() {
  const [state, setState] = useState<StateSnapshot | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [history, setHistory] = useState<(HistoryEntry & { server: string })[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const serialRef = useRef<number | null>(null)

  const load = useCallback(async (force = false): Promise<void> => {
    const res = await fetchState(force ? null : serialRef.current)
    if ('error' in res && res.ok === false) {
      setFetchError(res.error)
      return
    }
    const data = res as { serial: number; unchanged?: boolean; state?: StateSnapshot }
    setFetchError(null)
    serialRef.current = data.serial
    if (!data.unchanged && data.state) setState(data.state)
  }, [])

  useEffect(() => {
    void initTheme()
    try {
      void window.cate?.storage.panel.get(VIEW_KEY).then((saved) => {
        const restored = parseView(saved)
        if (restored) setView(restored)
      })
    } catch {
      /* outside Cate */
    }
    void load(true)
    // Poll only while visible; skip the fetch when the panel/document is
    // hidden and refresh immediately when it becomes visible again.
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

  function selectView(next: View): void {
    setView(next)
    try {
      void window.cate?.storage.panel.set(VIEW_KEY, serializeView(next))
    } catch {
      /* best effort */
    }
  }

  if (!state) {
    return (
      <div className="cate-app mcp-center">
        {fetchError ? (
          <div className="mcp-errorcard">Cannot reach the extension server: {fetchError}</div>
        ) : (
          <div className="mcp-muted">Loading…</div>
        )}
      </div>
    )
  }

  // Effective view: honor the selection when it still resolves, otherwise
  // fall back to the first server (spec: auto-select when servers exist).
  const effective: View =
    view && (view.kind !== 'server' || state.servers.some((s) => s.name === view.name))
      ? view
      : state.servers.length > 0
        ? { kind: 'server', name: state.servers[0].name }
        : { kind: 'server', name: '' }

  const detailServer =
    effective.kind === 'server' ? (state.servers.find((s) => s.name === effective.name) ?? null) : null
  const editServer = drawer?.kind === 'edit' ? (state.servers.find((s) => s.name === drawer.name) ?? null) : null
  const playServer = drawer?.kind === 'play' ? (state.servers.find((s) => s.name === drawer.server) ?? null) : null

  return (
    <div className="cate-app mcp-shell">
      {sidebarOpen && (
        <Sidebar
          state={state}
          view={effective}
          onSelect={selectView}
          onAdd={() => setDrawer({ kind: 'add' })}
          onCollapse={() => setSidebarOpen(false)}
        />
      )}

      <main className="mcp-main">
        {/* Agent-panel idiom: when the sidebar is collapsed, its toggle moves
         *  to the top-left of the main pane. */}
        {!sidebarOpen && (
          <div className="mcp-main__bar">
            <button
              className="cate-iconbtn"
              type="button"
              title="Open sidebar"
              aria-label="Open sidebar"
              onClick={() => setSidebarOpen(true)}
            >
              <SidebarIcon />
            </button>
          </div>
        )}
        {fetchError && <div className="mcp-errorcard">Connection lost, retrying: {fetchError}</div>}
        {state.configError && (
          <div className="mcp-errorcard">
            <div>mcp.json has a problem: {state.configError}</div>
            <div title="Watching for changes; the panel recovers when the file is fixed">
              <button className="cate-btn cate-btn--small" type="button" onClick={() => openConfigFile(state.configPath)}>
                Open mcp.json
              </button>
            </div>
          </div>
        )}

        {effective.kind === 'discover' && (
          <DiscoverView
            onAdd={(prefill) => setDrawer({ kind: 'add', prefill })}
          />
        )}
        {effective.kind === 'endpoint' && <EndpointView endpoint={state.endpoint} />}
        {effective.kind === 'server' && detailServer && (
          <ServerView
            key={detailServer.name}
            server={detailServer}
            history={history.filter((h) => h.server === detailServer.name)}
            onEdit={() => setDrawer({ kind: 'edit', name: detailServer.name })}
            onOpenPlay={(item) => setDrawer({ kind: 'play', server: detailServer.name, item })}
            refresh={() => void load(true)}
          />
        )}
        {effective.kind === 'server' && !detailServer && !state.configError && (
          <div className="cate-empty">
            <div className="cate-empty__icon">
              <BroadcastIcon />
            </div>
            <h2>No MCP servers</h2>
            <div className="mcp-empty__actions">
              <button className="cate-btn cate-btn--primary" type="button" onClick={() => setDrawer({ kind: 'add' })}>
                Add server
              </button>
              <button className="cate-btn" type="button" onClick={() => selectView({ kind: 'discover' })}>
                Browse registry
              </button>
            </div>
            <p>Stored in .cate/mcp.json</p>
          </div>
        )}
      </main>

      {drawer?.kind === 'add' && (
        <AddEditDrawer
          existing={null}
          prefill={drawer.prefill}
          onClose={() => setDrawer(null)}
          onSaved={(name) => {
            setDrawer(null)
            selectView({ kind: 'server', name })
            void load(true)
          }}
        />
      )}
      {drawer?.kind === 'edit' && editServer && (
        <AddEditDrawer
          existing={editServer}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null)
            void load(true)
          }}
        />
      )}
      {drawer?.kind === 'play' && playServer && (
        <PlaygroundDrawer
          server={playServer}
          item={drawer.item}
          onHistory={(entry) => setHistory((prev) => [{ ...entry, server: playServer.name }, ...prev].slice(0, 20))}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
