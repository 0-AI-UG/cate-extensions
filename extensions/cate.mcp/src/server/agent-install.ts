// =============================================================================
// Install the aggregated /mcp endpoint into a coding agent's WORKSPACE-LOCAL
// config file, one click from the panel's Endpoint screen.
//
// Each supported agent stores MCP servers in a different file and shape, so an
// adapter owns three pure operations over the file's text: detect (is our entry
// there, and at what URL), install (upsert our entry, preserving every other
// key), and remove (delete just our entry). The AgentInstaller does the FS: read
// the file, run the adapter, write atomically.
//
// We only write INSIDE the workspace. Two agents Cate supports have no working
// workspace-local HTTP MCP config today (Antigravity reads only a global
// ~/.gemini file; PI has no built-in MCP), so they appear in the list as
// `supported: false` with a reason rather than being silently skipped or, worse,
// handed a config their tool ignores.
//
// The endpoint we write is a SNAPSHOT: the extension server's loopback port and
// bearer token are minted fresh each Cate session, so an install goes stale on
// the next restart. `detect` returns the stored URL so the panel can flag a
// stale entry and offer "Update"; the endpoint only serves while this panel is
// open, which the panel says out loud.
// =============================================================================

import fs from 'fs'
import path from 'path'
import type { AgentTargetStatus } from '../shared/types'

/** The server name we write into every agent config (recognisable, stable). */
export const ENTRY_NAME = 'cate'

export interface Endpoint {
  url: string
  token: string
}

interface DetectResult {
  installed: boolean
  /** URL of our entry when installed, for stale detection. */
  url?: string
}

type OpResult = { ok: true; text: string } | { ok: false; error: string }

interface Adapter {
  id: string
  label: string
  /** Workspace-relative config path (POSIX separators, for display + FS join). */
  relPath: string
  /** False when this agent can't take a workspace-local HTTP MCP config. */
  supported: boolean
  /** Shown as a tooltip when supported is false. */
  reason?: string
  detect: (text: string | null) => DetectResult
  install: (text: string | null, ep: Endpoint) => OpResult
  remove: (text: string | null) => OpResult
}

// --- JSON helpers -----------------------------------------------------------

type JsonObject = Record<string, unknown>

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse existing file text into a mutable object, or an error. Empty/missing
 *  starts a fresh document. */
function parseJsonDoc(text: string | null): { ok: true; doc: JsonObject } | { ok: false; error: string } {
  if (text === null || text.trim() === '') return { ok: true, doc: {} }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!isObject(root)) return { ok: false, error: 'config root must be a JSON object' }
  return { ok: true, doc: root }
}

function serializeJson(doc: JsonObject): string {
  return JSON.stringify(doc, null, 2) + '\n'
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/** Adapter over a JSON file that keys MCP servers under `sectionKey` and, for
 *  our entry, builds the per-agent shape via `buildEntry`. Covers Claude Code
 *  (mcpServers) and OpenCode (mcp) — they differ only in the section key, the
 *  entry shape, and whether a fresh file gets a `$schema`. */
function jsonAdapter(opts: {
  id: string
  label: string
  relPath: string
  sectionKey: string
  buildEntry: (ep: Endpoint) => JsonObject
  /** Applied only when creating the file from scratch (e.g. opencode $schema). */
  freshDefaults?: JsonObject
}): Adapter {
  const section = (doc: JsonObject): JsonObject => {
    if (!isObject(doc[opts.sectionKey])) doc[opts.sectionKey] = {}
    return doc[opts.sectionKey] as JsonObject
  }
  return {
    id: opts.id,
    label: opts.label,
    relPath: opts.relPath,
    supported: true,
    detect: (text) => {
      const parsed = parseJsonDoc(text)
      if (!parsed.ok) return { installed: false }
      const sec = parsed.doc[opts.sectionKey]
      const entry = isObject(sec) ? sec[ENTRY_NAME] : undefined
      if (!isObject(entry)) return { installed: false }
      return { installed: true, url: typeof entry.url === 'string' ? entry.url : undefined }
    },
    install: (text, ep) => {
      const fresh = text === null || text.trim() === ''
      const parsed = parseJsonDoc(text)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      const doc = parsed.doc
      if (fresh && opts.freshDefaults) {
        for (const [k, v] of Object.entries(opts.freshDefaults)) if (!(k in doc)) doc[k] = v
      }
      section(doc)[ENTRY_NAME] = opts.buildEntry(ep)
      return { ok: true, text: serializeJson(doc) }
    },
    remove: (text) => {
      const parsed = parseJsonDoc(text)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      const sec = parsed.doc[opts.sectionKey]
      if (isObject(sec) && ENTRY_NAME in sec) delete sec[ENTRY_NAME]
      return { ok: true, text: serializeJson(parsed.doc) }
    },
  }
}

// --- Codex TOML adapter -----------------------------------------------------
// Codex config is TOML. Rather than pull in a TOML library to round-trip an
// entire user file, we edit only our own `[mcp_servers.cate]` block as text:
// replace it in place if present, else append it. Detection and URL extraction
// are scoped to that block. Every other line is left byte-for-byte untouched.

const CODEX_HEADER = `[mcp_servers.${ENTRY_NAME}]`

/** [start,end) line indices of our TOML block (header line through the line
 *  before the next `[` table header or EOF), or null if absent. */
function findCodexBlock(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((l) => l.trim() === CODEX_HEADER)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('[')) {
      end = i
      break
    }
  }
  return { start, end }
}

function codexBlock(ep: Endpoint): string {
  // TOML basic strings share JSON's escaping for the safe chars in a URL/token.
  return [
    CODEX_HEADER,
    `url = ${JSON.stringify(ep.url)}`,
    `http_headers = { "Authorization" = ${JSON.stringify(`Bearer ${ep.token}`)} }`,
  ].join('\n')
}

const codexAdapter: Adapter = {
  id: 'codex',
  label: 'Codex',
  relPath: '.codex/config.toml',
  supported: true,
  detect: (text) => {
    if (text === null) return { installed: false }
    const lines = text.split('\n')
    const block = findCodexBlock(lines)
    if (!block) return { installed: false }
    for (let i = block.start + 1; i < block.end; i++) {
      const m = lines[i].match(/^\s*url\s*=\s*"([^"]*)"/)
      if (m) return { installed: true, url: m[1] }
    }
    return { installed: true }
  },
  install: (text, ep) => {
    const block = codexBlock(ep)
    if (text === null || text.trim() === '') return { ok: true, text: block + '\n' }
    const lines = text.split('\n')
    const found = findCodexBlock(lines)
    if (found) {
      lines.splice(found.start, found.end - found.start, ...block.split('\n'))
      return { ok: true, text: lines.join('\n') }
    }
    const sep = text.endsWith('\n') ? '\n' : '\n\n'
    return { ok: true, text: text.replace(/\n*$/, '') + sep + '\n' + block + '\n' }
  },
  remove: (text) => {
    if (text === null) return { ok: true, text: '' }
    const lines = text.split('\n')
    const found = findCodexBlock(lines)
    if (!found) return { ok: true, text }
    // Drop the block plus one trailing blank separator line, if any.
    let end = found.end
    if (lines[end] !== undefined && lines[end].trim() === '') end++
    lines.splice(found.start, end - found.start)
    return { ok: true, text: lines.join('\n').replace(/\n{3,}/g, '\n\n') }
  },
}

// --- unsupported placeholders ----------------------------------------------

function unsupported(id: string, label: string, relPath: string, reason: string): Adapter {
  const no = (): OpResult => ({ ok: false, error: reason })
  return {
    id,
    label,
    relPath,
    supported: false,
    reason,
    detect: () => ({ installed: false }),
    install: no,
    remove: no,
  }
}

// --- registry ---------------------------------------------------------------

const ADAPTERS: Adapter[] = [
  // The in-app agent panel (pi). pi has no native MCP, so this targets the
  // `pi-mcp-adapter` package's project-local pi config (`.pi/mcp.json`): a
  // top-level mcpServers map where a remote server is `url` + `headers`. The
  // adapter reads it on session start and proxies each server's tools.
  jsonAdapter({
    id: 'agent-panel',
    label: 'Agent panel',
    relPath: '.pi/mcp.json',
    sectionKey: 'mcpServers',
    buildEntry: (ep) => ({ url: ep.url, headers: bearer(ep.token) }),
  }),
  jsonAdapter({
    id: 'claude-code',
    label: 'Claude Code',
    relPath: '.mcp.json',
    sectionKey: 'mcpServers',
    buildEntry: (ep) => ({ type: 'http', url: ep.url, headers: bearer(ep.token) }),
  }),
  jsonAdapter({
    id: 'cursor',
    label: 'Cursor',
    relPath: '.cursor/mcp.json',
    sectionKey: 'mcpServers',
    // Cursor infers HTTP from the presence of `url`; no `type` key needed.
    buildEntry: (ep) => ({ url: ep.url, headers: bearer(ep.token) }),
  }),
  jsonAdapter({
    id: 'opencode',
    label: 'OpenCode',
    relPath: 'opencode.json',
    sectionKey: 'mcp',
    buildEntry: (ep) => ({ type: 'remote', url: ep.url, enabled: true, headers: bearer(ep.token) }),
    freshDefaults: { $schema: 'https://opencode.ai/config.json' },
  }),
  codexAdapter,
  unsupported(
    'antigravity',
    'Antigravity',
    '~/.gemini/config/mcp_config.json',
    'Antigravity only reads a global (~/.gemini) MCP config; it ignores a workspace-local file, so there is nothing to install here.',
  ),
  unsupported(
    'pi',
    'PI Agent',
    '—',
    'PI has no built-in MCP support yet.',
  ),
]

export class AgentInstaller {
  constructor(private readonly workspaceRoot: string) {}

  private file(a: Adapter): string {
    return path.join(this.workspaceRoot, ...a.relPath.split('/'))
  }

  private readText(a: Adapter): string | null {
    try {
      return fs.readFileSync(this.file(a), 'utf8')
    } catch {
      return null
    }
  }

  /** Current install status for every agent, against `ep` (to flag staleness). */
  list(ep: Endpoint): AgentTargetStatus[] {
    return ADAPTERS.map((a) => {
      const det = a.supported ? a.detect(this.readText(a)) : { installed: false }
      return {
        id: a.id,
        label: a.label,
        path: a.relPath,
        supported: a.supported,
        reason: a.reason,
        installed: det.installed,
        stale: det.installed && det.url !== undefined && det.url !== ep.url,
      }
    })
  }

  install(id: string, ep: Endpoint): { ok: true } | { ok: false; error: string } {
    const a = ADAPTERS.find((x) => x.id === id)
    if (!a) return { ok: false, error: `unknown agent "${id}"` }
    if (!a.supported) return { ok: false, error: a.reason ?? 'not supported' }
    const res = a.install(this.readText(a), ep)
    if (!res.ok) return { ok: false, error: `could not edit ${a.relPath}: ${res.error}` }
    return this.write(a, res.text)
  }

  uninstall(id: string): { ok: true } | { ok: false; error: string } {
    const a = ADAPTERS.find((x) => x.id === id)
    if (!a) return { ok: false, error: `unknown agent "${id}"` }
    if (!a.supported) return { ok: false, error: a.reason ?? 'not supported' }
    const res = a.remove(this.readText(a))
    if (!res.ok) return { ok: false, error: `could not edit ${a.relPath}: ${res.error}` }
    return this.write(a, res.text)
  }

  /** Atomic temp+rename write, creating parent dirs. */
  private write(a: Adapter, text: string): { ok: true } | { ok: false; error: string } {
    const file = this.file(a)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.cate-${process.pid}.tmp`
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, file)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
