// Discover view: search the official MCP registry and one-click prefill the
// add-server form from an entry's package/remote metadata. Registry failures
// stay inside this view; nothing else depends on it.

import { useEffect, useRef, useState } from 'react'
import { prefillFromRegistry, type RegistryEntry } from '../../shared/registry'
import { registrySearch } from '../api'
import type { AddPrefill } from './AddEditDrawer'

function entryTitle(entry: RegistryEntry): string {
  const parts: string[] = [entry.name + (entry.version ? ` v${entry.version}` : '')]
  if (entry.packages.length > 0) parts.push(`packages: ${entry.packages.map((p) => `${p.registryType}:${p.identifier}`).join(', ')}`)
  if (entry.remotes.length > 0) parts.push(`remote: ${entry.remotes.map((r) => r.url).join(', ')}`)
  return parts.join('\n')
}

export function DiscoverView({ onAdd }: { onAdd: (prefill: AddPrefill) => void }) {
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<RegistryEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const requestSeq = useRef(0)

  async function search(q: string, cursor: string | null): Promise<void> {
    const seq = ++requestSeq.current
    setLoading(true)
    setError(null)
    const result = await registrySearch(q, cursor)
    if (seq !== requestSeq.current) return // superseded by a newer search
    setLoading(false)
    setSearched(true)
    if (!result.ok) {
      setError(result.error ?? 'registry unavailable')
      if (!cursor) setEntries([])
      setNextCursor(null)
      return
    }
    setEntries((prev) => (cursor ? [...prev, ...(result.entries ?? [])] : (result.entries ?? [])))
    setNextCursor(result.nextCursor ?? null)
  }

  // Initial load: an unfiltered first page is a decent browsing start.
  useEffect(() => {
    void search('', null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function addEntry(entry: RegistryEntry): void {
    const prefill = prefillFromRegistry(entry)
    if (!prefill) {
      setError(`"${entry.name}" publishes no runnable package or remote URL; add it manually`)
      return
    }
    onAdd({
      name: prefill.suggestedName,
      kind: prefill.kind,
      command: prefill.command,
      args: prefill.args,
      env: prefill.env,
      url: prefill.url,
      headers: prefill.headers,
      note:
        prefill.needsInput.length > 0
          ? `From the registry entry "${entry.name}". Still needed: ${prefill.needsInput.join(', ')}.`
          : `From the registry entry "${entry.name}".`,
    })
  }

  return (
    <div className="mcp-view">
      <div className="mcp-disc__search">
        <input
          className="cate-input"
          value={query}
          placeholder="Search registry"
          title="registry.modelcontextprotocol.io — community-published; review what a server runs before adding it"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search(query.trim(), null)
          }}
        />
        <button className="cate-btn" type="button" disabled={loading} onClick={() => void search(query.trim(), null)}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>

      {error && (
        <div className="mcp-errorcard">
          {error}
          <div>
            <button className="cate-btn cate-btn--small" type="button" onClick={() => void search(query.trim(), null)}>
              Retry
            </button>
          </div>
        </div>
      )}

      <div className="mcp-disc__list">
        {!error && searched && !loading && entries.length === 0 && (
          <div className="mcp-muted">No matches{query ? ` for "${query}"` : ''}</div>
        )}
        {entries.map((entry, i) => (
          <div className="mcp-discrow" key={`${entry.name}-${i}`} title={entryTitle(entry)}>
            <span className="mcp-discrow__name">{entry.title || entry.name}</span>
            <span className="mcp-discrow__desc">{entry.description || entry.name}</span>
            <button className="cate-btn cate-btn--small mcp-discrow__add" type="button" onClick={() => addEntry(entry)}>
              Add
            </button>
          </div>
        ))}
      </div>

      {nextCursor && !error && (
        <div>
          <button className="cate-btn cate-btn--small" type="button" disabled={loading} onClick={() => void search(query.trim(), nextCursor)}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  )
}
