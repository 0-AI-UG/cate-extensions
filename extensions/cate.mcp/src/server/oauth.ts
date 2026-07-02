// =============================================================================
// OAuth support for remote MCP servers, built on the SDK's OAuthClientProvider.
//
// Tokens NEVER go into mcp.json. They live in <workspace>/.cate/mcp-auth.json,
// written 0600 via temp+rename, and .cate/.gitignore is made to contain
// mcp-auth.json (idempotent create/append) so the secrets can't be committed.
//
// The interactive part is inverted from a normal app: the SDK calls
// redirectToAuthorization(url); we cannot redirect anything from a headless
// server, so we capture the URL, surface it on the connection (status
// needs-auth), and the panel presents it to the user. The extension server
// hosts GET /oauth/callback on its loopback port as the redirect URI; the
// `state` parameter maps the callback back to the owning server.
// =============================================================================

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

const AUTH_FILE = 'mcp-auth.json'
const GITIGNORE = '.gitignore'

interface StoredServerAuth {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
}

type AuthFileShape = Record<string, StoredServerAuth>

/** File-backed token store, one entry per server name. Reads go to disk every
 *  time (the file is small and external edits should win); writes are atomic
 *  and 0600. */
export class AuthStore {
  readonly file: string
  private readonly cateDir: string

  constructor(workspaceRoot: string) {
    this.cateDir = path.join(workspaceRoot, '.cate')
    this.file = path.join(this.cateDir, AUTH_FILE)
  }

  private load(): AuthFileShape {
    let text: string
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch {
      return {}
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as AuthFileShape
    } catch {
      // Corrupt auth file: treat as empty; the next save rewrites it. Losing
      // tokens forces a re-auth, which is the safe failure direction.
    }
    return {}
  }

  get(server: string): StoredServerAuth {
    return this.load()[server] ?? {}
  }

  patch(server: string, patch: Partial<StoredServerAuth>): void {
    const all = this.load()
    const entry = { ...(all[server] ?? {}), ...patch }
    for (const key of Object.keys(entry) as (keyof StoredServerAuth)[]) {
      if (entry[key] === undefined) delete entry[key]
    }
    all[server] = entry
    this.save(all)
  }

  clear(server: string, scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const all = this.load()
    const entry = all[server]
    if (!entry) return
    if (scope === 'all') delete all[server]
    else {
      if (scope === 'client') delete entry.clientInformation
      if (scope === 'tokens') delete entry.tokens
      if (scope === 'verifier') delete entry.codeVerifier
    }
    this.save(all)
  }

  remove(server: string): void {
    this.clear(server, 'all')
  }

  private save(all: AuthFileShape): void {
    fs.mkdirSync(this.cateDir, { recursive: true })
    ensureGitignored(this.cateDir)
    const tmp = `${this.file}.cate-${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, this.file)
    // rename preserves the tmp file's 0600 mode; enforce anyway in case an
    // older world-readable file predates this write.
    try {
      fs.chmodSync(this.file, 0o600)
    } catch {
      /* best effort */
    }
  }
}

/** Make sure .cate/.gitignore ignores mcp-auth.json (create or append once). */
export function ensureGitignored(cateDir: string): void {
  const file = path.join(cateDir, GITIGNORE)
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    text = ''
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  if (lines.includes(AUTH_FILE)) return
  const next = text === '' ? `${AUTH_FILE}\n` : `${text.replace(/\n?$/, '\n')}${AUTH_FILE}\n`
  fs.writeFileSync(file, next, 'utf8')
}

/** In-flight authorization flows: state -> server name. States are single-use
 *  and expire so a stale callback can't be replayed. */
export class PendingAuthRegistry {
  private pending = new Map<string, { server: string; expires: number }>()

  issue(server: string): string {
    const state = crypto.randomBytes(24).toString('hex')
    this.pending.set(state, { server, expires: Date.now() + 10 * 60_000 })
    return state
  }

  consume(state: string): string | null {
    const entry = this.pending.get(state)
    if (!entry) return null
    this.pending.delete(state)
    if (entry.expires < Date.now()) return null
    return entry.server
  }
}

export interface ProviderHooks {
  /** The SDK asked to send the user to this URL (surfaced in the panel). */
  onAuthorizationUrl(url: string): void
  registry: PendingAuthRegistry
}

/** OAuthClientProvider persisting per-server credentials in AuthStore. */
export class FileOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly store: AuthStore,
    private readonly server: string,
    private readonly callbackUrl: string,
    private readonly hooks: ProviderHooks,
  ) {}

  get redirectUrl(): string {
    return this.callbackUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Cate MCP Servers',
      redirect_uris: [this.callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string {
    return this.hooks.registry.issue(this.server)
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.get(this.server).clientInformation
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.store.patch(this.server, { clientInformation })
  }

  tokens(): OAuthTokens | undefined {
    return this.store.get(this.server).tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.patch(this.server, { tokens })
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.hooks.onAuthorizationUrl(authorizationUrl.toString())
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.patch(this.server, { codeVerifier })
  }

  codeVerifier(): string {
    const verifier = this.store.get(this.server).codeVerifier
    if (!verifier) throw new Error('no PKCE code verifier saved; restart the authorization flow')
    return verifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'discovery') return // nothing cached
    this.store.clear(this.server, scope)
  }
}
