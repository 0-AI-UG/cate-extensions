// =============================================================================
// MCPHub child-process resolution and lifecycle.
//
// MCPHub (samanhappy/mcphub, Apache-2.0 + ISC) is a heavy app (~90 deps, native
// builds) and CANNOT be bundled into Cate's catalog artifact, which ships only
// manifest.json + dist/ (no runtime node_modules). So this wrapper resolves a
// MCPHub install from the user's machine ("connect to user instance" model) and
// supervises it as a child bound to loopback on a private internal port.
//
// MCPHub honors process.env.PORT (default 3000) and process.env.BASE_PATH, but
// NOT a HOST var: its Express server calls `app.listen(port)` and so binds
// 0.0.0.0. The wrapper therefore never hands MCPHub the Cate-injected PORT;
// instead it runs MCPHub on a random internal port and proxies to it over
// 127.0.0.1. The wrapper itself binds 127.0.0.1 to satisfy Cate's contract.
// =============================================================================

import { spawn, ChildProcess, execFileSync } from 'child_process'

/** How the wrapper invokes MCPHub, in priority order. The first that resolves
 *  wins. Override the whole thing with the MCPHUB_CMD env var (space-split, or
 *  honoring a single command + args, e.g. "docker run ...") for power users. */
export interface McphubLaunchSpec {
  /** Executable to spawn. */
  command: string
  /** Argv passed to it. */
  args: string[]
  /** How this spec was resolved, for diagnostics/logging. */
  via: 'env' | 'bin' | 'npx-global' | 'docker'
}

/** Parse a user-provided MCPHUB_CMD into a launch spec. Very small shell-ish
 *  split on whitespace (no quoting); enough for "mcphub", "node /path/cli.js",
 *  or "docker run --rm -p ... samanhappy/mcphub". */
export function parseMcphubCmd(raw: string | undefined): McphubLaunchSpec | null {
  if (!raw) return null
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  return { command: parts[0], args: parts.slice(1), via: 'env' }
}

/** True if `cmd` resolves to an executable on PATH (uses `which`/`where`). */
export function isOnPath(cmd: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(probe, [cmd], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Decide how to launch MCPHub. Resolution order:
 *   1. MCPHUB_CMD env override (any command, e.g. a docker invocation).
 *   2. `mcphub` on PATH (global/linked install of @samanhappy/mcphub).
 *   3. `npx -y @samanhappy/mcphub` if npx is on PATH (last resort; first run
 *      downloads the package into the npx cache).
 * Returns null if none is available — the wrapper then surfaces a clear,
 * actionable error to the panel instead of a cryptic spawn failure.
 *
 * `env` and `path` are injectable for tests.
 */
export function resolveLaunch(
  env: NodeJS.ProcessEnv = process.env,
  onPath: (cmd: string) => boolean = isOnPath,
): McphubLaunchSpec | null {
  const override = parseMcphubCmd(env.MCPHUB_CMD)
  if (override) return override

  if (onPath('mcphub')) {
    return { command: 'mcphub', args: [], via: 'bin' }
  }

  if (onPath('npx')) {
    return { command: 'npx', args: ['-y', '@samanhappy/mcphub'], via: 'npx-global' }
  }

  return null
}

/** Sub-path the wrapper mounts MCPHub under (via its BASE_PATH). The shell page
 *  lives at the panel root `/`; MCPHub and all its absolute-path assets/API live
 *  under this prefix so they route cleanly through the reverse proxy without URL
 *  rewriting. Kept in sync with the proxy route in server.ts. */
export const MCPHUB_BASE_PATH = '/__mcphub/dash'

/** Build the child environment for MCPHub: force the internal PORT, mount it
 *  under MCPHUB_BASE_PATH so it never collides with the wrapper shell, and pass
 *  through everything else so the user's MCPHub config/credentials still apply.
 *  Cate-internal vars are stripped so MCPHub never sees the wrapper's PORT or
 *  the bearer token. */
export function childEnv(
  internalPort: number,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent }
  delete env.CATE_TOKEN
  delete env.CATE_API
  env.PORT = String(internalPort)
  env.BASE_PATH = MCPHUB_BASE_PATH
  // MCPHub prints a generated admin password if none is set; keep that behavior
  // (visible in captured stderr) rather than silently fixing one here.
  return env
}

export interface McphubProcess {
  child: ChildProcess
  spec: McphubLaunchSpec
  internalPort: number
}

/** Spawn MCPHub on `internalPort`. stdio is piped so the caller can capture
 *  stderr for Cate's error surface. Throws synchronously only if resolution
 *  fails; spawn errors arrive as 'error'/'exit' events on the returned child. */
export function spawnMcphub(
  internalPort: number,
  env: NodeJS.ProcessEnv = process.env,
  spec: McphubLaunchSpec | null = resolveLaunch(env),
): McphubProcess {
  if (!spec) {
    throw new Error(
      'MCPHub not found. Install it (`npm i -g @samanhappy/mcphub`), or set ' +
        'MCPHUB_CMD to a launch command (e.g. "docker run --rm -p ${PORT}:${PORT} samanhappy/mcphub").',
    )
  }
  const child = spawn(spec.command, spec.args, {
    env: childEnv(internalPort, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { child, spec, internalPort }
}
