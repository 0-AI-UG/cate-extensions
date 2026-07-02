// Add / edit server drawer: stdio vs remote toggle, args editor (one per
// line), env/headers key-value editors, client-side name validation mirroring
// the server's rules (which re-checks everything anyway).

import { useState } from 'react'
import { validateServerName } from '../../shared/config'
import type { ServerConfigInput, ServerSnapshot } from '../../shared/types'
import { addServer, updateServer } from '../api'
import { CloseIcon, InlineError } from './util'
import { KVEditor, kvRowsFromRecord, recordFromKvRows, type KVRow } from './KVEditor'

export interface AddPrefill {
  name?: string
  kind?: 'stdio' | 'remote'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  note?: string
}

const ENV_TITLE = 'Values support ${env:VAR}, expanded from the host environment at launch, never written to the file'

export function AddEditDrawer({
  existing,
  prefill,
  onClose,
  onSaved,
}: {
  /** Set when editing; add mode otherwise. */
  existing: ServerSnapshot | null
  prefill?: AddPrefill
  onClose: () => void
  /** Called with the saved server's name so the shell can select it. */
  onSaved: (name: string) => void
}) {
  const initial = existing?.config
  const [name, setName] = useState(existing?.name ?? prefill?.name ?? '')
  const [kind, setKind] = useState<'stdio' | 'remote'>(
    existing ? existing.transport : (prefill?.kind ?? 'stdio'),
  )
  const [command, setCommand] = useState(initial?.command ?? prefill?.command ?? '')
  const [argsText, setArgsText] = useState((initial?.args ?? prefill?.args ?? []).join('\n'))
  const [cwd, setCwd] = useState(initial?.cwd ?? '')
  const [env, setEnv] = useState<KVRow[]>(kvRowsFromRecord(initial?.env ?? prefill?.env))
  const [url, setUrl] = useState(initial?.url ?? prefill?.url ?? '')
  const [headers, setHeaders] = useState<KVRow[]>(kvRowsFromRecord(initial?.headers ?? prefill?.headers))
  const [disabled, setDisabled] = useState(initial?.disabled === true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save(): Promise<void> {
    setError(null)
    if (!existing) {
      const nameCheck = validateServerName(name.trim())
      if (!nameCheck.ok) {
        setError(nameCheck.error)
        return
      }
    }
    const config: ServerConfigInput = { disabled }
    if (kind === 'stdio') {
      if (command.trim() === '') {
        setError('command is required for a stdio server')
        return
      }
      config.command = command.trim()
      config.args = argsText
        .split('\n')
        .map((a) => a.trim())
        .filter((a) => a !== '')
      config.env = recordFromKvRows(env)
      if (cwd.trim() !== '') config.cwd = cwd.trim()
    } else {
      if (url.trim() === '') {
        setError('URL is required for a remote server')
        return
      }
      config.url = url.trim()
      config.headers = recordFromKvRows(headers)
    }
    setSaving(true)
    const result = existing ? await updateServer(existing.name, config) : await addServer(name.trim(), config)
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onSaved(existing ? existing.name : name.trim())
  }

  return (
    <>
      <div className="mcp-scrim" onClick={onClose} />
      <div className="mcp-modal" role="dialog" aria-label={existing ? `Edit ${existing.name}` : 'Add MCP server'}>
        <div className="mcp-modal__head">
          <span className="mcp-modal__title">{existing ? `Edit ${existing.name}` : 'Add server'}</span>
          <span className="mcp-modal__spacer" />
          <button className="cate-iconbtn" type="button" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="mcp-modal__body">
          {prefill?.note && <div className="mcp-muted mcp-note">{prefill.note}</div>}
          <label className="cate-field">
            <span className="cate-label">Name</span>
            <input
              className="cate-input"
              value={name}
              disabled={existing !== null}
              placeholder="e.g. filesystem"
              title={'Letters, digits, ".", "-", "_" — no "__" (reserved for namespacing)'}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="cate-field">
            <span className="cate-label">Transport</span>
            <div className="mcp-seg">
              <button
                className={`mcp-seg__btn${kind === 'stdio' ? ' mcp-seg__btn--active' : ''}`}
                type="button"
                title="Local command"
                onClick={() => setKind('stdio')}
              >
                stdio
              </button>
              <button
                className={`mcp-seg__btn${kind === 'remote' ? ' mcp-seg__btn--active' : ''}`}
                type="button"
                title="HTTP"
                onClick={() => setKind('remote')}
              >
                remote
              </button>
            </div>
          </div>

          {kind === 'stdio' ? (
            <>
              <label className="cate-field">
                <span className="cate-label">Command</span>
                <input
                  className="cate-input mcp-mono"
                  value={command}
                  placeholder="npx"
                  onChange={(e) => setCommand(e.target.value)}
                />
              </label>
              <label className="cate-field">
                <span className="cate-label">Arguments (one per line)</span>
                <textarea
                  className="cate-input mcp-mono"
                  rows={4}
                  value={argsText}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir'}
                  onChange={(e) => setArgsText(e.target.value)}
                />
              </label>
              <label className="cate-field">
                <span className="cate-label">Working directory (optional)</span>
                <input className="cate-input mcp-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} />
              </label>
              <div className="cate-field">
                <span className="cate-label" title={ENV_TITLE}>
                  Environment variables
                </span>
                <KVEditor rows={env} onChange={setEnv} keyPlaceholder="NAME" valuePlaceholder="value or ${env:VAR}" />
              </div>
            </>
          ) : (
            <>
              <label className="cate-field">
                <span className="cate-label">URL</span>
                <input
                  className="cate-input mcp-mono"
                  value={url}
                  placeholder="https://example.com/mcp"
                  onChange={(e) => setUrl(e.target.value)}
                />
              </label>
              <div className="cate-field">
                <span className="cate-label" title={ENV_TITLE}>
                  Headers
                </span>
                <KVEditor
                  rows={headers}
                  onChange={setHeaders}
                  keyPlaceholder="Header"
                  valuePlaceholder="value or ${env:VAR}"
                />
              </div>
            </>
          )}

          <label className="cate-field mcp-check" title="Kept in config, never started">
            <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
            <span>Disabled</span>
          </label>

          <InlineError error={error} />
        </div>
        <div className="mcp-modal__foot">
          <button className="cate-btn cate-btn--ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="cate-btn cate-btn--primary" type="button" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : existing ? 'Save' : 'Add server'}
          </button>
        </div>
      </div>
    </>
  )
}
