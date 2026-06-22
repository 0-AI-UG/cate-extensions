import { describe, it, expect } from 'vitest'
import {
  deriveProviderEnv,
  connectedProviders,
  hasReusableProvider,
  type AuthJson,
  type ModelsJson,
} from './auth'

const openaiAuth: AuthJson = { openai: { type: 'api_key', key: 'sk-test-123' } }

describe('deriveProviderEnv', () => {
  it('maps Cate provider keys to DeepWiki env vars', () => {
    const auth: AuthJson = {
      openai: { type: 'api_key', key: 'sk-oai' },
      google: { type: 'api_key', key: 'goog-key' },
      openrouter: { type: 'api_key', key: 'or-key' },
    }
    expect(deriveProviderEnv(auth)).toEqual({
      OPENAI_API_KEY: 'sk-oai',
      GOOGLE_API_KEY: 'goog-key',
      OPENROUTER_API_KEY: 'or-key',
    })
  })

  it('ignores oauth entries and missing keys', () => {
    const auth: AuthJson = {
      openai: { type: 'oauth' },
      google: { type: 'api_key' }, // no key field
    }
    expect(deriveProviderEnv(auth)).toEqual({})
  })

  it('surfaces a custom OpenAI-compatible base URL from models.json', () => {
    const models: ModelsJson = { custom: { baseUrl: 'http://localhost:4000/v1', models: ['x'] } }
    expect(deriveProviderEnv(openaiAuth, models)).toEqual({
      OPENAI_API_KEY: 'sk-test-123',
      OPENAI_BASE_URL: 'http://localhost:4000/v1',
    })
  })

  it('tolerates null / empty inputs without throwing', () => {
    expect(deriveProviderEnv(null)).toEqual({})
    expect(deriveProviderEnv(undefined, null)).toEqual({})
    expect(deriveProviderEnv({}, {})).toEqual({})
  })
})

describe('connectedProviders', () => {
  it('lists only providers with a usable api_key', () => {
    const auth: AuthJson = {
      openai: { type: 'api_key', key: 'k' },
      google: { type: 'oauth' },
      anthropic: { type: 'api_key', key: 'a' }, // not a DeepWiki-mapped provider
    }
    expect(connectedProviders(auth)).toEqual(['openai'])
  })

  it('returns [] for null', () => {
    expect(connectedProviders(null)).toEqual([])
  })
})

describe('hasReusableProvider', () => {
  it('is true when any LLM key is present', () => {
    expect(hasReusableProvider(openaiAuth)).toBe(true)
    expect(hasReusableProvider({ google: { type: 'api_key', key: 'g' } })).toBe(true)
  })

  it('is false with only a base URL and no key', () => {
    expect(hasReusableProvider({}, { custom: { baseUrl: 'http://x/v1' } })).toBe(false)
  })

  it('is false for empty config', () => {
    expect(hasReusableProvider(null)).toBe(false)
  })
})
