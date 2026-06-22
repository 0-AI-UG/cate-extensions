// =============================================================================
// Reuse Cate's configured AI provider for DeepWiki.
//
// Cate stores provider credentials in `<workspace>/.cate/pi-agent/auth.json`
// (mirrored from userData) as a map { <providerId>: { type: 'api_key', key } }.
// A custom OpenAI-compatible endpoint lives in `models.json` as
// { custom: { baseUrl, models: [...] } }.
//
// DeepWiki-Open is configured by env (OPENAI_API_KEY / OPENAI_BASE_URL /
// GOOGLE_API_KEY / OPENROUTER_API_KEY ...). DeepWiki's OPENAI_BASE_URL
// explicitly supports OpenAI-compatible services and local proxies, so a custom
// Cate endpoint maps cleanly onto it.
//
// This module is pure (no Node fs/Cate imports) so it unit-tests trivially: it
// takes already-parsed auth.json / models.json objects and returns the env a
// DeepWiki instance would need. The server (server.ts) does the file reads.
// =============================================================================

/** Minimal shape of an entry in pi-agent/auth.json. */
export interface AuthEntry {
  type: 'api_key' | 'oauth' | string
  key?: string
}

/** pi-agent/auth.json: { <providerId>: AuthEntry }. */
export type AuthJson = Record<string, AuthEntry>

/** The custom OpenAI-compatible endpoint block of pi-agent/models.json. */
export interface ModelsJson {
  custom?: {
    baseUrl?: string
    models?: unknown[]
  }
}

/** The DeepWiki-relevant env we can derive from Cate's provider config. */
export interface DeepWikiProviderEnv {
  /** OpenAI / OpenAI-compatible key, if Cate has one. */
  OPENAI_API_KEY?: string
  /** Custom OpenAI-compatible base URL (Cate's `custom` endpoint), if set. */
  OPENAI_BASE_URL?: string
  /** Google Gemini key (DeepWiki's GOOGLE_API_KEY). */
  GOOGLE_API_KEY?: string
  /** OpenRouter key. */
  OPENROUTER_API_KEY?: string
}

/** Map Cate provider id -> the DeepWiki env var name it should populate.
 *  Cate's `google` provider uses GEMINI_API_KEY internally but the credential
 *  value is the same Google AI Studio key DeepWiki wants as GOOGLE_API_KEY. */
const PROVIDER_TO_DEEPWIKI_ENV: Record<string, keyof DeepWikiProviderEnv> = {
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

function apiKeyFor(auth: AuthJson | null | undefined, providerId: string): string | undefined {
  const entry = auth?.[providerId]
  if (entry && entry.type === 'api_key' && typeof entry.key === 'string' && entry.key.length > 0) {
    return entry.key
  }
  return undefined
}

/**
 * Derive the DeepWiki provider env from Cate's parsed auth.json + models.json.
 * Never throws; returns an object with only the keys we could resolve.
 */
export function deriveProviderEnv(
  auth: AuthJson | null | undefined,
  models?: ModelsJson | null | undefined,
): DeepWikiProviderEnv {
  const env: DeepWikiProviderEnv = {}

  for (const [providerId, envName] of Object.entries(PROVIDER_TO_DEEPWIKI_ENV)) {
    const key = apiKeyFor(auth, providerId)
    if (key) env[envName] = key
  }

  // A custom OpenAI-compatible endpoint: point DeepWiki's OpenAI client at it.
  // (DeepWiki documents OPENAI_BASE_URL as supporting local proxies.) We only
  // surface the base URL; the key it pairs with is Cate's `openai`/`custom`
  // credential, already handled above when present.
  const baseUrl = models?.custom?.baseUrl
  if (typeof baseUrl === 'string' && baseUrl.length > 0) {
    env.OPENAI_BASE_URL = baseUrl
  }

  return env
}

/** Which Cate providers are connected (have a usable api_key). For surfacing
 *  reuse status in the panel without leaking the keys themselves. */
export function connectedProviders(auth: AuthJson | null | undefined): string[] {
  if (!auth) return []
  return Object.keys(PROVIDER_TO_DEEPWIKI_ENV).filter((id) => apiKeyFor(auth, id) != null)
}

/** True if Cate has at least one provider DeepWiki can use. */
export function hasReusableProvider(
  auth: AuthJson | null | undefined,
  models?: ModelsJson | null | undefined,
): boolean {
  const env = deriveProviderEnv(auth, models)
  return Boolean(env.OPENAI_API_KEY || env.GOOGLE_API_KEY || env.OPENROUTER_API_KEY)
}
