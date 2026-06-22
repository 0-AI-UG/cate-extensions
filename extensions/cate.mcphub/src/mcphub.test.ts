import { describe, it, expect } from 'vitest'
import { parseMcphubCmd, resolveLaunch, childEnv, MCPHUB_BASE_PATH } from './mcphub'

describe('parseMcphubCmd', () => {
  it('returns null for empty/undefined', () => {
    expect(parseMcphubCmd(undefined)).toBeNull()
    expect(parseMcphubCmd('')).toBeNull()
    expect(parseMcphubCmd('   ')).toBeNull()
  })

  it('splits a bare command', () => {
    expect(parseMcphubCmd('mcphub')).toEqual({ command: 'mcphub', args: [], via: 'env' })
  })

  it('splits a command with args', () => {
    expect(parseMcphubCmd('node /opt/mcphub/cli.js --foo')).toEqual({
      command: 'node',
      args: ['/opt/mcphub/cli.js', '--foo'],
      via: 'env',
    })
  })

  it('handles a docker invocation', () => {
    const spec = parseMcphubCmd('docker run --rm samanhappy/mcphub')
    expect(spec?.command).toBe('docker')
    expect(spec?.args).toEqual(['run', '--rm', 'samanhappy/mcphub'])
  })
})

describe('resolveLaunch', () => {
  it('prefers MCPHUB_CMD override', () => {
    const spec = resolveLaunch({ MCPHUB_CMD: 'mcphub --x' } as NodeJS.ProcessEnv, () => true)
    expect(spec).toEqual({ command: 'mcphub', args: ['--x'], via: 'env' })
  })

  it('uses mcphub on PATH when present', () => {
    const onPath = (cmd: string): boolean => cmd === 'mcphub'
    expect(resolveLaunch({} as NodeJS.ProcessEnv, onPath)).toEqual({
      command: 'mcphub',
      args: [],
      via: 'bin',
    })
  })

  it('falls back to npx when only npx is present', () => {
    const onPath = (cmd: string): boolean => cmd === 'npx'
    expect(resolveLaunch({} as NodeJS.ProcessEnv, onPath)).toEqual({
      command: 'npx',
      args: ['-y', '@samanhappy/mcphub'],
      via: 'npx-global',
    })
  })

  it('returns null when nothing is available', () => {
    expect(resolveLaunch({} as NodeJS.ProcessEnv, () => false)).toBeNull()
  })
})

describe('childEnv', () => {
  it('forces internal PORT and mounts MCPHub under the wrapper base path', () => {
    const env = childEnv(54321, { PORT: '3000', BASE_PATH: '/x' } as NodeJS.ProcessEnv)
    expect(env.PORT).toBe('54321')
    expect(env.BASE_PATH).toBe(MCPHUB_BASE_PATH)
  })

  it('strips Cate-internal secrets from the child env', () => {
    const env = childEnv(40000, {
      CATE_TOKEN: 'secret',
      CATE_API: 'http://127.0.0.1:9/api',
      ADMIN_PASSWORD: 'keep-me',
    } as NodeJS.ProcessEnv)
    expect(env.CATE_TOKEN).toBeUndefined()
    expect(env.CATE_API).toBeUndefined()
    expect(env.ADMIN_PASSWORD).toBe('keep-me')
  })
})
