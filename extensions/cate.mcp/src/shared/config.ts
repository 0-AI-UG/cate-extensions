// =============================================================================
// .cate/mcp.json model. Claude-Desktop-style config:
//
//   {
//     "mcpServers": {
//       "<name>": { "command": "...", "args": [], "env": {}, "cwd": "..." }
//                | { "url": "https://...", "headers": {} }
//       // either form may add "disabled": true
//     }
//   }
//
// Mutations work on the PARSED document (parse -> mutate known paths ->
// re-serialize) so unknown keys anywhere in the file survive panel edits.
// `${env:VAR}` placeholders are expanded at launch time only; the file always
// keeps the placeholder form.
// =============================================================================

import type { ServerConfig, ServerConfigInput } from './types'

export const CONFIG_RELATIVE_PATH = '.cate/mcp.json'

/** Reserved separator for the unified endpoint's `<server>__<tool>` names. */
export const NAMESPACE_SEP = '__'

export type JsonObject = Record<string, unknown>

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// --- names ---------------------------------------------------------------------

/** Validate a server name. `__` is reserved for endpoint namespacing, and the
 *  name shows up in URLs/logs, so keep it to a tame charset. */
export function validateServerName(name: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: 'server name must be a non-empty string' }
  }
  if (name.length > 64) return { ok: false, error: 'server name must be 64 characters or fewer' }
  if (name.includes(NAMESPACE_SEP)) {
    return { ok: false, error: `server name must not contain "${NAMESPACE_SEP}" (reserved for endpoint namespacing)` }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return { ok: false, error: 'server name may only contain letters, digits, ".", "_" and "-", and must start with a letter or digit' }
  }
  return { ok: true }
}

// --- per-entry normalization -----------------------------------------------------

function stringRecord(v: unknown, what: string): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, value: {} }
  if (!isObject(v)) return { ok: false, error: `${what} must be an object of strings` }
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') return { ok: false, error: `${what}.${k} must be a string` }
    out[k] = val
  }
  return { ok: true, value: out }
}

/** Normalize one raw mcpServers entry into a typed ServerConfig. */
export function normalizeServerEntry(raw: unknown): { ok: true; config: ServerConfig } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: 'server entry must be an object' }
  const disabled = raw.disabled === true
  const hasCommand = raw.command !== undefined
  const hasUrl = raw.url !== undefined
  if (hasCommand && hasUrl) return { ok: false, error: 'server entry must have either "command" or "url", not both' }
  if (hasUrl) {
    if (typeof raw.url !== 'string' || raw.url.trim() === '') return { ok: false, error: '"url" must be a non-empty string' }
    const headers = stringRecord(raw.headers, 'headers')
    if (!headers.ok) return headers
    return { ok: true, config: { kind: 'remote', url: raw.url, headers: headers.value, disabled } }
  }
  if (hasCommand) {
    if (typeof raw.command !== 'string' || raw.command.trim() === '') {
      return { ok: false, error: '"command" must be a non-empty string' }
    }
    let args: string[] = []
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
        return { ok: false, error: '"args" must be an array of strings' }
      }
      args = raw.args as string[]
    }
    const env = stringRecord(raw.env, 'env')
    if (!env.ok) return env
    let cwd: string | undefined
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== 'string' || raw.cwd.trim() === '') return { ok: false, error: '"cwd" must be a non-empty string' }
      cwd = raw.cwd
    }
    return { ok: true, config: { kind: 'stdio', command: raw.command, args, env: env.value, cwd, disabled } }
  }
  return { ok: false, error: 'server entry needs "command" (stdio) or "url" (remote)' }
}

// --- whole-document parsing -------------------------------------------------------

export interface ParsedServerEntry {
  raw: JsonObject
  config: ServerConfig | null
  error: string | null
}

export interface ParsedConfigDoc {
  /** The full parsed document; mutations go through this to keep unknown keys. */
  doc: JsonObject
  /** name -> normalized entry (config null when the entry is invalid). */
  servers: Map<string, ParsedServerEntry>
}

export function parseConfigText(text: string): { ok: true; parsed: ParsedConfigDoc } | { ok: false; error: string } {
  if (text.trim() === '') {
    return { ok: true, parsed: { doc: { mcpServers: {} }, servers: new Map() } }
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `mcp.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!isObject(root)) return { ok: false, error: 'mcp.json must be a JSON object' }
  const rawServers = root.mcpServers
  if (rawServers !== undefined && !isObject(rawServers)) {
    return { ok: false, error: '"mcpServers" must be an object' }
  }
  const servers = new Map<string, ParsedServerEntry>()
  for (const [name, raw] of Object.entries(rawServers ?? {})) {
    const nameCheck = validateServerName(name)
    const entryRaw = isObject(raw) ? raw : {}
    if (!nameCheck.ok) {
      servers.set(name, { raw: entryRaw, config: null, error: nameCheck.error })
      continue
    }
    const norm = normalizeServerEntry(raw)
    servers.set(name, norm.ok ? { raw: entryRaw, config: norm.config, error: null } : { raw: entryRaw, config: null, error: norm.error })
  }
  return { ok: true, parsed: { doc: root, servers } }
}

export function serializeConfigDoc(doc: JsonObject): string {
  return JSON.stringify(doc, null, 2) + '\n'
}

// --- document mutations (unknown-key preserving) ------------------------------------

function serversObject(doc: JsonObject): JsonObject {
  if (!isObject(doc.mcpServers)) doc.mcpServers = {}
  return doc.mcpServers as JsonObject
}

/** Fields the panel manages; everything else in an entry is left untouched. */
const STDIO_KEYS = ['command', 'args', 'env', 'cwd'] as const
const REMOTE_KEYS = ['url', 'headers'] as const

/** Validate a ServerConfigInput coming from the API. */
export function validateConfigInput(input: unknown): { ok: true; value: ServerConfigInput } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: 'config must be an object' }
  const hasCommand = input.command !== undefined
  const hasUrl = input.url !== undefined
  if (hasCommand === hasUrl) {
    return { ok: false, error: 'config needs exactly one of "command" (stdio) or "url" (remote)' }
  }
  // Reuse the entry normalizer for field-level validation.
  const norm = normalizeServerEntry(input)
  if (!norm.ok) return norm
  const value: ServerConfigInput = { disabled: input.disabled === true }
  if (norm.config.kind === 'stdio') {
    value.command = norm.config.command
    value.args = norm.config.args
    value.env = norm.config.env
    if (norm.config.cwd !== undefined) value.cwd = norm.config.cwd
  } else {
    value.url = norm.config.url
    value.headers = norm.config.headers
  }
  return { ok: true, value }
}

/** Insert or update one server entry in the document, preserving unknown keys
 *  of an existing entry. Switching transport kinds removes the other kind's
 *  managed keys (a stdio entry that keeps a stale "url" would be ambiguous). */
export function upsertServerInDoc(doc: JsonObject, name: string, input: ServerConfigInput): void {
  const servers = serversObject(doc)
  const existing = isObject(servers[name]) ? (servers[name] as JsonObject) : {}
  const entry: JsonObject = { ...existing }
  const isStdio = input.command !== undefined
  const drop: readonly string[] = isStdio ? REMOTE_KEYS : STDIO_KEYS
  for (const key of drop) delete entry[key]
  if (isStdio) {
    entry.command = input.command
    if (input.args && input.args.length > 0) entry.args = input.args
    else delete entry.args
    if (input.env && Object.keys(input.env).length > 0) entry.env = input.env
    else delete entry.env
    if (input.cwd) entry.cwd = input.cwd
    else delete entry.cwd
  } else {
    entry.url = input.url
    if (input.headers && Object.keys(input.headers).length > 0) entry.headers = input.headers
    else delete entry.headers
  }
  if (input.disabled) entry.disabled = true
  else delete entry.disabled
  servers[name] = entry
}

export function removeServerFromDoc(doc: JsonObject, name: string): boolean {
  const servers = serversObject(doc)
  if (!(name in servers)) return false
  delete servers[name]
  return true
}

/** Toggle just the "disabled" flag, leaving the rest of the entry alone. */
export function setDisabledInDoc(doc: JsonObject, name: string, disabled: boolean): boolean {
  const servers = serversObject(doc)
  const entry = servers[name]
  if (!isObject(entry)) return false
  if (disabled) entry.disabled = true
  else delete entry.disabled
  return true
}

// --- diffing (hot-apply on external edits) -------------------------------------------

export interface ConfigDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

/** Compare two parsed configs by each entry's raw JSON. A changed entry means
 *  "restart that server"; unchanged servers keep running. */
export function diffConfigs(prev: ParsedConfigDoc | null, next: ParsedConfigDoc): ConfigDiff {
  const prevServers = prev?.servers ?? new Map<string, ParsedServerEntry>()
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [name, entry] of next.servers) {
    const old = prevServers.get(name)
    if (!old) added.push(name)
    else if (JSON.stringify(old.raw) !== JSON.stringify(entry.raw)) changed.push(name)
  }
  for (const name of prevServers.keys()) {
    if (!next.servers.has(name)) removed.push(name)
  }
  return { added, removed, changed }
}

// --- ${env:VAR} expansion --------------------------------------------------------------

const PLACEHOLDER = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

function expandString(value: string, env: Record<string, string | undefined>, missing: Set<string>): string {
  return value.replace(PLACEHOLDER, (_m, name: string) => {
    const v = env[name]
    if (v === undefined) {
      missing.add(name)
      return ''
    }
    return v
  })
}

function expandRecord(
  rec: Record<string, string>,
  env: Record<string, string | undefined>,
  missing: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec)) out[k] = expandString(v, env, missing)
  return out
}

/** Expand `${env:VAR}` in command/args/env/cwd/url/headers at launch time.
 *  Returns a NEW config; the stored config keeps its placeholders. A missing
 *  variable is an error (silently launching with '' hides misconfiguration). */
export function expandConfig(
  config: ServerConfig,
  env: Record<string, string | undefined>,
): { ok: true; config: ServerConfig } | { ok: false; error: string } {
  const missing = new Set<string>()
  let expanded: ServerConfig
  if (config.kind === 'stdio') {
    expanded = {
      ...config,
      command: expandString(config.command, env, missing),
      args: config.args.map((a) => expandString(a, env, missing)),
      env: expandRecord(config.env, env, missing),
      cwd: config.cwd === undefined ? undefined : expandString(config.cwd, env, missing),
    }
  } else {
    expanded = {
      ...config,
      url: expandString(config.url, env, missing),
      headers: expandRecord(config.headers, env, missing),
    }
  }
  if (missing.size > 0) {
    return { ok: false, error: `environment variable(s) not set: ${[...missing].sort().join(', ')}` }
  }
  return { ok: true, config: expanded }
}
