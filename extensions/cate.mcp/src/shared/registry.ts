// =============================================================================
// Official MCP registry (registry.modelcontextprotocol.io) response parsing and
// add-form prefill. Verified against the live API (2026-07):
//
//   GET /v0/servers?search=<substring>&version=latest&limit=<n>&cursor=<c>
//   -> { "servers": [ { "server": <server.json>, "_meta": {...} } ],
//        "metadata": { "nextCursor": "...", "count": n } }
//
// server.json (schema 2025-12-11): name (reverse-DNS "publisher/id"), title,
// description, version, packages[] { registryType, identifier, version,
// runtimeHint, runtimeArguments[], packageArguments[], environmentVariables[],
// transport }, remotes[] { type, url, headers[] }.
// =============================================================================

import { validateServerName } from './config'

export interface RegistryArgument {
  type?: string // 'positional' | 'named'
  name?: string
  value?: string
  isRequired?: boolean
  description?: string
}

export interface RegistryKeyValue {
  name: string
  value?: string
  isRequired?: boolean
  isSecret?: boolean
  description?: string
}

export interface RegistryPackage {
  registryType: string
  identifier: string
  version?: string
  runtimeHint?: string
  runtimeArguments?: RegistryArgument[]
  packageArguments?: RegistryArgument[]
  environmentVariables?: RegistryKeyValue[]
}

export interface RegistryRemote {
  type: string // 'streamable-http' | 'sse'
  url: string
  headers?: RegistryKeyValue[]
}

export interface RegistryEntry {
  name: string
  title?: string
  description: string
  version: string
  publisher: string
  packages: RegistryPackage[]
  remotes: RegistryRemote[]
}

export interface RegistrySearchPage {
  entries: RegistryEntry[]
  nextCursor: string | null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function parseKeyValues(v: unknown): RegistryKeyValue[] {
  if (!Array.isArray(v)) return []
  const out: RegistryKeyValue[] = []
  for (const item of v) {
    if (!isObject(item) || typeof item.name !== 'string') continue
    out.push({
      name: item.name,
      value: str(item.value),
      isRequired: item.isRequired === true,
      isSecret: item.isSecret === true,
      description: str(item.description),
    })
  }
  return out
}

function parseArguments(v: unknown): RegistryArgument[] {
  if (!Array.isArray(v)) return []
  const out: RegistryArgument[] = []
  for (const item of v) {
    if (!isObject(item)) continue
    out.push({
      type: str(item.type),
      name: str(item.name),
      value: str(item.value),
      isRequired: item.isRequired === true,
      description: str(item.description),
    })
  }
  return out
}

function parseServer(v: unknown): RegistryEntry | null {
  if (!isObject(v)) return null
  const name = str(v.name)
  if (!name) return null
  const packages: RegistryPackage[] = []
  if (Array.isArray(v.packages)) {
    for (const p of v.packages) {
      if (!isObject(p) || typeof p.identifier !== 'string' || typeof p.registryType !== 'string') continue
      packages.push({
        registryType: p.registryType,
        identifier: p.identifier,
        version: str(p.version),
        runtimeHint: str(p.runtimeHint),
        runtimeArguments: parseArguments(p.runtimeArguments),
        packageArguments: parseArguments(p.packageArguments),
        environmentVariables: parseKeyValues(p.environmentVariables),
      })
    }
  }
  const remotes: RegistryRemote[] = []
  if (Array.isArray(v.remotes)) {
    for (const r of v.remotes) {
      if (!isObject(r) || typeof r.url !== 'string') continue
      remotes.push({ type: str(r.type) ?? 'streamable-http', url: r.url, headers: parseKeyValues(r.headers) })
    }
  }
  return {
    name,
    title: str(v.title),
    description: str(v.description) ?? '',
    version: str(v.version) ?? '',
    publisher: name.includes('/') ? name.slice(0, name.indexOf('/')) : name,
    packages,
    remotes,
  }
}

/** Parse a /v0/servers response body. Tolerates and skips malformed entries. */
export function parseRegistryResponse(body: unknown): RegistrySearchPage {
  if (!isObject(body)) return { entries: [], nextCursor: null }
  const entries: RegistryEntry[] = []
  if (Array.isArray(body.servers)) {
    for (const wrapper of body.servers) {
      const entry = parseServer(isObject(wrapper) ? wrapper.server : undefined)
      if (entry) entries.push(entry)
    }
  }
  const metadata = isObject(body.metadata) ? body.metadata : {}
  return { entries, nextCursor: str(metadata.nextCursor) ?? null }
}

// --- add-form prefill --------------------------------------------------------------

export interface RegistryPrefill {
  /** Suggested local server name (valid per validateServerName). */
  suggestedName: string
  kind: 'stdio' | 'remote'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** Env vars / headers the user still has to fill in (no value in registry). */
  needsInput: string[]
}

/** Derive a valid local server name from a registry name like
 *  "io.github.foo/bar-server": take the last path segment and sanitize. */
export function suggestLocalName(registryName: string): string {
  const segment = registryName.split('/').pop() || registryName
  let name = segment.replace(/[^A-Za-z0-9._-]/g, '-')
  while (name.includes('__')) name = name.replace(/__/g, '_')
  name = name.replace(/^[^A-Za-z0-9]+/, '')
  if (name === '' || !validateServerName(name).ok) name = 'mcp-server'
  return name.slice(0, 64)
}

function argumentsToArgv(args: RegistryArgument[] | undefined, needsInput: string[]): string[] {
  const argv: string[] = []
  for (const arg of args ?? []) {
    if (arg.type === 'named' && arg.name) {
      argv.push(arg.name)
      if (arg.value !== undefined) argv.push(arg.value)
      else if (arg.isRequired) needsInput.push(`argument ${arg.name}`)
    } else if (arg.value !== undefined) {
      argv.push(arg.value)
    } else if (arg.isRequired) {
      needsInput.push(`argument ${arg.name ?? '(positional)'}`)
    }
  }
  return argv
}

function keyValuesToRecord(kvs: RegistryKeyValue[] | undefined, needsInput: string[], label: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const kv of kvs ?? []) {
    if (kv.value !== undefined) out[kv.name] = kv.value
    else {
      out[kv.name] = ''
      if (kv.isRequired) needsInput.push(`${label} ${kv.name}`)
    }
  }
  return out
}

/** Runner command for a package registry type. Only ecosystems with a
 *  no-install runner are prefillable; others return null and the UI says so. */
function runnerFor(pkg: RegistryPackage): { command: string; args: string[] } | null {
  const spec = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier
  switch (pkg.registryType) {
    case 'npm':
      return { command: pkg.runtimeHint || 'npx', args: ['-y', spec] }
    case 'pypi':
      return { command: pkg.runtimeHint || 'uvx', args: [spec] }
    case 'oci':
      return { command: pkg.runtimeHint || 'docker', args: ['run', '--rm', '-i', spec] }
    default:
      return null
  }
}

/** Prefill from one specific package (local stdio). Null when the package's
 *  ecosystem has no no-install runner we can launch. */
export function prefillFromPackage(entry: RegistryEntry, pkg: RegistryPackage): RegistryPrefill | null {
  const runner = runnerFor(pkg)
  if (!runner) return null
  const needsInput: string[] = []
  const args = [
    ...runner.args,
    ...argumentsToArgv(pkg.runtimeArguments, needsInput),
    ...argumentsToArgv(pkg.packageArguments, needsInput),
  ]
  const env = keyValuesToRecord(pkg.environmentVariables, needsInput, 'env')
  return { suggestedName: suggestLocalName(entry.name), kind: 'stdio', command: runner.command, args, env, needsInput }
}

/** Prefill from one specific remote (HTTP) endpoint. */
export function prefillFromRemote(entry: RegistryEntry, remote: RegistryRemote): RegistryPrefill {
  const needsInput: string[] = []
  const headers = keyValuesToRecord(remote.headers, needsInput, 'header')
  return { suggestedName: suggestLocalName(entry.name), kind: 'remote', url: remote.url, headers, needsInput }
}

/** Build the add-server prefill from a registry entry. Prefers a runnable
 *  package (local stdio) and falls back to a remote URL. Null when the entry
 *  carries nothing we can launch or connect to. */
export function prefillFromRegistry(entry: RegistryEntry): RegistryPrefill | null {
  for (const pkg of entry.packages) {
    const prefill = prefillFromPackage(entry, pkg)
    if (prefill) return prefill
  }
  const remote = entry.remotes.find((r) => r.type === 'streamable-http') ?? entry.remotes[0]
  if (remote) return prefillFromRemote(entry, remote)
  return null
}
