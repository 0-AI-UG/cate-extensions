import { describe, expect, it } from 'vitest'
import { parseRegistryResponse, prefillFromRegistry, suggestLocalName } from './registry'

// Shape captured from a live GET /v0/servers response (2026-07), trimmed.
const FIXTURE = {
  servers: [
    {
      server: {
        $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
        name: 'io.github.example/brave-search',
        title: 'Brave Search',
        description: 'Web search via the Brave API.',
        version: '1.0.2',
        packages: [
          {
            registryType: 'npm',
            identifier: '@example/server-brave-search',
            version: '1.0.2',
            transport: { type: 'stdio' },
            packageArguments: [
              { type: 'positional', value: '--stdio' },
              { type: 'named', name: '--depth', value: '2' },
            ],
            environmentVariables: [
              { name: 'BRAVE_API_KEY', isRequired: true, isSecret: true },
              { name: 'BRAVE_REGION', value: 'us' },
            ],
          },
        ],
      },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
    },
    {
      server: {
        name: 'ac.inference.sh/mcp',
        title: 'inference.sh',
        description: 'Run AI apps.',
        version: '1.0.1',
        remotes: [
          { type: 'streamable-http', url: 'https://api.inference.sh/mcp', headers: [{ name: 'X-Key', isRequired: true }] },
          { type: 'sse', url: 'https://api.inference.sh/sse' },
        ],
      },
      _meta: {},
    },
    { server: { description: 'malformed, no name' } },
    'garbage',
  ],
  metadata: { nextCursor: 'abc:1.0.1', count: 2 },
}

describe('parseRegistryResponse', () => {
  it('parses entries, publisher, cursor; skips malformed items', () => {
    const page = parseRegistryResponse(FIXTURE)
    expect(page.entries).toHaveLength(2)
    expect(page.nextCursor).toBe('abc:1.0.1')
    const [pkg, remote] = page.entries
    expect(pkg.name).toBe('io.github.example/brave-search')
    expect(pkg.publisher).toBe('io.github.example')
    expect(pkg.packages[0].identifier).toBe('@example/server-brave-search')
    expect(remote.remotes).toHaveLength(2)
  })

  it('tolerates junk bodies', () => {
    expect(parseRegistryResponse(null).entries).toEqual([])
    expect(parseRegistryResponse('x').entries).toEqual([])
    expect(parseRegistryResponse({ servers: 'not-an-array' }).entries).toEqual([])
  })
})

describe('prefillFromRegistry', () => {
  const page = parseRegistryResponse(FIXTURE)

  it('prefers an npm package and builds an npx command with args and env', () => {
    const prefill = prefillFromRegistry(page.entries[0])
    expect(prefill).not.toBeNull()
    expect(prefill!.kind).toBe('stdio')
    expect(prefill!.command).toBe('npx')
    expect(prefill!.args).toEqual(['-y', '@example/server-brave-search@1.0.2', '--stdio', '--depth', '2'])
    expect(prefill!.env).toEqual({ BRAVE_API_KEY: '', BRAVE_REGION: 'us' })
    expect(prefill!.needsInput).toContain('env BRAVE_API_KEY')
    expect(prefill!.suggestedName).toBe('brave-search')
  })

  it('falls back to the streamable-http remote with header placeholders', () => {
    const prefill = prefillFromRegistry(page.entries[1])
    expect(prefill).not.toBeNull()
    expect(prefill!.kind).toBe('remote')
    expect(prefill!.url).toBe('https://api.inference.sh/mcp')
    expect(prefill!.headers).toEqual({ 'X-Key': '' })
    expect(prefill!.needsInput).toContain('header X-Key')
  })

  it('returns null when nothing is runnable or connectable', () => {
    expect(prefillFromRegistry({ name: 'x/y', description: '', version: '', publisher: 'x', packages: [], remotes: [] })).toBeNull()
  })

  it('pypi packages prefill uvx', () => {
    const prefill = prefillFromRegistry({
      name: 'x/py-server',
      description: '',
      version: '2.0.0',
      publisher: 'x',
      packages: [{ registryType: 'pypi', identifier: 'mcp-py-server', version: '2.0.0' }],
      remotes: [],
    })
    expect(prefill!.command).toBe('uvx')
    expect(prefill!.args).toEqual(['mcp-py-server@2.0.0'])
  })
})

describe('suggestLocalName', () => {
  it('takes the last segment and sanitizes to a valid server name', () => {
    expect(suggestLocalName('io.github.foo/bar-server')).toBe('bar-server')
    expect(suggestLocalName('weird/na__me!!x')).toBe('na_me--x')
    expect(suggestLocalName('///')).toBe('mcp-server')
  })
})
