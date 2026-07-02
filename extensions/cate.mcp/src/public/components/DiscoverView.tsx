// Discover view: a marketplace over the official MCP registry. Each result is
// an accordion that expands to the full server detail (description, publisher,
// every remote endpoint and runnable package) with a per-option Add button, so
// nothing is truncated and the user picks exactly what to install. Registry
// failures stay inside this view; nothing else depends on it.

import { useEffect, useRef, useState } from 'react'
import {
  prefillFromPackage,
  prefillFromRemote,
  type RegistryEntry,
  type RegistryPackage,
  type RegistryPrefill,
  type RegistryRemote,
} from '../../shared/registry'
import { registrySearch } from '../api'
import type { AddPrefill } from './AddEditDrawer'
import { PlusIcon } from './util'

const RUNNABLE = new Set(['npm', 'pypi', 'oci'])

type Filter = 'all' | 'remote' | 'local'

function pickRemote(entry: RegistryEntry): RegistryRemote | null {
  return entry.remotes.find((r) => r.type === 'streamable-http') ?? entry.remotes[0] ?? null
}

function firstRunnablePackage(entry: RegistryEntry): RegistryPrefill | null {
  for (const p of entry.packages) {
    const pf = prefillFromPackage(entry, p)
    if (pf) return pf
  }
  return null
}

function matchesFilter(entry: RegistryEntry, filter: Filter): boolean {
  if (filter === 'remote') return entry.remotes.length > 0
  if (filter === 'local') return firstRunnablePackage(entry) !== null
  return true
}

/** Quick-add prefill, biased by the active transport filter. Prefers a runnable
 *  local package (the safe default), except under the remote filter. */
function quickPrefill(entry: RegistryEntry, filter: Filter): RegistryPrefill | null {
  const remote = pickRemote(entry)
  const remotePf = remote ? prefillFromRemote(entry, remote) : null
  const localPf = firstRunnablePackage(entry)
  if (filter === 'remote') return remotePf ?? localPf
  return localPf ?? remotePf
}

function allowedKindsFor(entry: RegistryEntry): ('stdio' | 'remote')[] {
  const kinds: ('stdio' | 'remote')[] = []
  if (firstRunnablePackage(entry)) kinds.push('stdio')
  if (entry.remotes.length > 0) kinds.push('remote')
  return kinds
}

function prefillToAdd(entry: RegistryEntry, prefill: RegistryPrefill): AddPrefill {
  return {
    name: prefill.suggestedName,
    kind: prefill.kind,
    command: prefill.command,
    args: prefill.args,
    env: prefill.env,
    url: prefill.url,
    headers: prefill.headers,
    allowedKinds: allowedKindsFor(entry),
    note:
      prefill.needsInput.length > 0
        ? `From "${entry.name}". Still needed: ${prefill.needsInput.join(', ')}.`
        : `From "${entry.name}".`,
  }
}

function transportBadges(entry: RegistryEntry): string[] {
  const badges: string[] = []
  if (entry.remotes.length > 0) badges.push('remote')
  for (const p of entry.packages) badges.push(p.registryType)
  return [...new Set(badges)]
}

function RemoteOption({ entry, remote, onAdd }: { entry: RegistryEntry; remote: RegistryRemote; onAdd: (p: AddPrefill) => void }) {
  return (
    <div className="mcp-mktopt">
      <div className="mcp-mktopt__main">
        <div className="mcp-mktopt__head">
          <span className="cate-chip">remote</span>
          <span className="mcp-mktopt__kind">{remote.type}</span>
        </div>
        <div className="mcp-mktopt__addr mcp-mono">{remote.url}</div>
        {remote.headers && remote.headers.length > 0 && (
          <div className="mcp-mktopt__meta">
            Headers: {remote.headers.map((h) => h.name + (h.isRequired ? '*' : '')).join(', ')}
          </div>
        )}
      </div>
      <button className="cate-btn cate-btn--small" type="button" onClick={() => onAdd(prefillToAdd(entry, prefillFromRemote(entry, remote)))}>
        <PlusIcon /> Add
      </button>
    </div>
  )
}

function PackageOption({ entry, pkg, onAdd }: { entry: RegistryEntry; pkg: RegistryPackage; onAdd: (p: AddPrefill) => void }) {
  const prefill = prefillFromPackage(entry, pkg)
  const runnable = RUNNABLE.has(pkg.registryType)
  const envNames = (pkg.environmentVariables ?? []).map((e) => e.name + (e.isRequired ? '*' : ''))
  return (
    <div className="mcp-mktopt">
      <div className="mcp-mktopt__main">
        <div className="mcp-mktopt__head">
          <span className="cate-chip">{pkg.registryType}</span>
          {prefill?.command && <span className="mcp-mktopt__kind">{prefill.command}</span>}
        </div>
        <div className="mcp-mktopt__addr mcp-mono">
          {pkg.identifier}
          {pkg.version ? `@${pkg.version}` : ''}
        </div>
        {envNames.length > 0 && <div className="mcp-mktopt__meta">Env: {envNames.join(', ')}</div>}
        {!runnable && <div className="mcp-mktopt__meta">No no-install runner for {pkg.registryType}; add manually.</div>}
      </div>
      <button
        className="cate-btn cate-btn--small"
        type="button"
        disabled={!prefill}
        title={prefill ? undefined : 'Not directly runnable'}
        onClick={() => prefill && onAdd(prefillToAdd(entry, prefill))}
      >
        <PlusIcon /> Add
      </button>
    </div>
  )
}

function MarketCard({ entry, filter, onAdd }: { entry: RegistryEntry; filter: Filter; onAdd: (p: AddPrefill) => void }) {
  const [open, setOpen] = useState(false)
  const badges = transportBadges(entry)
  const quick = quickPrefill(entry, filter)

  return (
    <div className={`mcp-mktcard${open ? ' mcp-mktcard--open' : ''}`}>
      <div className="mcp-mktcard__head" role="button" tabIndex={0} onClick={() => setOpen((v) => !v)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) } }}>
        <span className={`mcp-mktcard__chev${open ? ' mcp-mktcard__chev--open' : ''}`} aria-hidden="true">›</span>
        <div className="mcp-mktcard__title">
          <div className="mcp-mktcard__name">{entry.title || entry.name}</div>
          <div className="mcp-mktcard__sub">
            <span className="mcp-mktcard__pub">{entry.publisher}</span>
            {entry.version && <span className="mcp-mktcard__ver">v{entry.version}</span>}
            {badges.map((b) => (
              <span className="cate-chip" key={b}>{b}</span>
            ))}
          </div>
        </div>
        {quick && (
          <button
            className="cate-btn cate-btn--small mcp-mktcard__add"
            type="button"
            title="Add (remote endpoint preferred)"
            onClick={(e) => { e.stopPropagation(); onAdd(prefillToAdd(entry, quick)) }}
          >
            <PlusIcon /> Add
          </button>
        )}
      </div>
      {open && (
        <div className="mcp-mktcard__body">
          {entry.description && <p className="mcp-mktcard__desc">{entry.description}</p>}
          <div className="mcp-mktcard__id mcp-mono">{entry.name}</div>
          {entry.remotes.length === 0 && entry.packages.length === 0 && (
            <div className="mcp-muted">This entry publishes no remote endpoint or runnable package; add it manually.</div>
          )}
          {entry.remotes.map((r, i) => (
            <RemoteOption entry={entry} remote={r} onAdd={onAdd} key={`r-${i}`} />
          ))}
          {entry.packages.map((p, i) => (
            <PackageOption entry={entry} pkg={p} onAdd={onAdd} key={`p-${i}`} />
          ))}
        </div>
      )}
    </div>
  )
}

const FILTERS: { key: Filter; label: string; title: string }[] = [
  { key: 'all', label: 'All', title: 'Every server' },
  { key: 'remote', label: 'Remote', title: 'Servers with a hosted HTTP endpoint' },
  { key: 'local', label: 'Local', title: 'Servers with a runnable local package' },
]

export function DiscoverView({ onAdd }: { onAdd: (prefill: AddPrefill) => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
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

  const visible = entries.filter((e) => matchesFilter(e, filter))

  return (
    <div className="mcp-view mcp-mkt">
      <div className="mcp-mkt__intro">
        <div className="mcp-mkt__title">Browse MCP servers</div>
        <div className="mcp-muted">
          From the community registry (registry.modelcontextprotocol.io). Review what a server runs before adding it.
        </div>
      </div>

      <div className="mcp-disc__search">
        <input
          className="cate-input"
          value={query}
          placeholder="Search by name, publisher, or keyword…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search(query.trim(), null)
          }}
        />
        <button className="cate-btn" type="button" disabled={loading} onClick={() => void search(query.trim(), null)}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>

      <div className="mcp-disc__filters">
        <span className="mcp-muted">Transport</span>
        <div className="mcp-seg">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`mcp-seg__btn${filter === f.key ? ' mcp-seg__btn--active' : ''}`}
              title={f.title}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
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

      {!error && searched && (
        <div className="mcp-mkt__count">
          {entries.length === 0
            ? `No matches${query ? ` for "${query}"` : ''}`
            : filter === 'all'
              ? `${visible.length} server${visible.length === 1 ? '' : 's'}${query ? ` for "${query}"` : ''}`
              : `${visible.length} ${filter} of ${entries.length} loaded`}
        </div>
      )}

      <div className="mcp-mkt__list">
        {visible.map((entry, i) => (
          <MarketCard entry={entry} filter={filter} onAdd={onAdd} key={`${entry.name}-${i}`} />
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
