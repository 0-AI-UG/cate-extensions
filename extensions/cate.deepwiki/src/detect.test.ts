// Unit tests for the pure parsers in the shared service-detect kit module.
// (The scanning/probing themselves shell out / hit the network; only the
// fiddly lsof/docker output parsing and URL normalization are tested here.)
import { describe, it, expect } from 'vitest'
import { parseLsofPorts, parseDockerPorts, normalizeCandidate } from './_kit/service-detect'

describe('parseDockerPorts', () => {
  const out = [
    'ghcr.io/sourcebot-dev/sourcebot:latest\t0.0.0.0:3000->3000/tcp, :::3000->3000/tcp',
    'postgres:16\t0.0.0.0:5432->5432/tcp',
    'my-org/sourcebot-extras\t0.0.0.0:8080->8080/tcp',
  ].join('\n')

  it('returns host ports of images matching the name', () => {
    expect(parseDockerPorts(out, /sourcebot/i).sort()).toEqual([3000, 8080])
  })

  it('ignores non-matching images', () => {
    expect(parseDockerPorts(out, /sourcebot/i)).not.toContain(5432)
  })

  it('dedupes the IPv4 + IPv6 publishing of one port', () => {
    expect(parseDockerPorts('img/sourcebot\t0.0.0.0:3000->3000/tcp, :::3000->3000/tcp', /sourcebot/i)).toEqual([3000])
  })

  it('is empty for blank input', () => {
    expect(parseDockerPorts('', /sourcebot/i)).toEqual([])
  })
})

describe('parseLsofPorts', () => {
  const out = [
    'COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'deepwiki  12345 anton   23u  IPv4 0xabc           0t0  TCP 127.0.0.1:3000 (LISTEN)',
    'node      22222 anton   30u  IPv6 0xdef           0t0  TCP *:9999 (LISTEN)',
    'deepwiki  12345 anton   24u  IPv4 0xabc           0t0  TCP 127.0.0.1:8001 (LISTEN)',
    'deepwiki  12345 anton   90u  IPv4 0xabc           0t0  TCP 127.0.0.1:54321->1.2.3.4:443 (ESTABLISHED)',
  ].join('\n')

  it('returns LISTEN ports for matching command names', () => {
    expect(parseLsofPorts(out, /deepwiki/i).sort((a, b) => a - b)).toEqual([3000, 8001])
  })

  it('ignores non-matching commands', () => {
    expect(parseLsofPorts(out, /deepwiki/i)).not.toContain(9999)
  })

  it('ignores non-LISTEN (ESTABLISHED) connections', () => {
    expect(parseLsofPorts(out, /deepwiki/i)).not.toContain(54321)
  })
})

describe('normalizeCandidate', () => {
  it('prepends http:// to a bare host:port and keeps the origin only', () => {
    expect(normalizeCandidate('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeCandidate('http://localhost:3000/wiki/foo')).toBe('http://localhost:3000')
  })

  it('preserves https', () => {
    expect(normalizeCandidate('https://sb.example.com')).toBe('https://sb.example.com')
  })

  it('rejects non-http(s) schemes and junk', () => {
    expect(normalizeCandidate('ftp://host')).toBeNull()
    expect(normalizeCandidate('')).toBeNull()
    expect(normalizeCandidate('   ')).toBeNull()
    expect(normalizeCandidate(undefined)).toBeNull()
    expect(normalizeCandidate(42)).toBeNull()
  })
})
