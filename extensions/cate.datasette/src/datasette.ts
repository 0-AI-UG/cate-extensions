// =============================================================================
// Datasette child-process resolution and launch arguments.
//
// Datasette is a Python app and CANNOT be bundled into Cate's catalog artifact,
// which ships only manifest.json + dist/ (official extensions are JS/TS). So
// this wrapper resolves a way to RUN Datasette from the user's machine and
// supervises it as a child bound to loopback on a private internal port.
//
// Datasette has first-class subpath support (`--setting base_url <prefix>`),
// which this wrapper leans on: Cate serves panels under an opaque
// `/ext/<routeToken>/` prefix and strips it before forwarding, so the child is
// started with base_url = <publicBase>db/ (the panel reports its publicBase at
// start time). Every URL Datasette emits then already carries the full public
// prefix and resolves through Cate's proxy with no rewriting.
// =============================================================================

import { spawn, ChildProcess, execFileSync } from 'child_process'

/** Sub-path (relative to the panel's public base) the wrapper mounts Datasette
 *  under. The shell page lives at the panel root `/`; Datasette and all its
 *  absolute-path assets/links live under this prefix. Kept in sync with the
 *  proxy route in server.ts and the iframe src in public/app.ts. */
export const DATASETTE_SUBPATH = 'db/'

/** How the wrapper invokes Datasette, in priority order. The first that
 *  resolves wins. Override the whole thing with the DATASETTE_CMD env var
 *  (space-split, no quoting; e.g. "python3 -m datasette"). */
export interface DatasetteLaunchSpec {
  /** Executable to spawn. */
  command: string
  /** Argv prefix before the wrapper-owned args (db files, port, base_url). */
  args: string[]
  /** How this spec was resolved, for diagnostics/logging. */
  via: 'env' | 'bin' | 'uvx' | 'pipx'
}

/** Parse a user-provided DATASETTE_CMD into a launch spec. Very small shell-ish
 *  split on whitespace (no quoting); enough for "datasette",
 *  "python3 -m datasette", or "/opt/venv/bin/datasette". */
export function parseDatasetteCmd(raw: string | undefined): DatasetteLaunchSpec | null {
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
 * Decide how to launch Datasette. Resolution order:
 *   1. DATASETTE_CMD env override (any command).
 *   2. `datasette` on PATH (pip/pipx/uv tool install).
 *   3. `uvx datasette` if uvx is on PATH (first run downloads into uv's cache).
 *   4. `pipx run datasette` if pipx is on PATH (same, into pipx's cache).
 * Returns null if none is available — the wrapper then surfaces a clear,
 * actionable error to the panel instead of a cryptic spawn failure.
 *
 * `env` and `onPath` are injectable for tests.
 */
export function resolveLaunch(
  env: NodeJS.ProcessEnv = process.env,
  onPath: (cmd: string) => boolean = isOnPath,
): DatasetteLaunchSpec | null {
  const override = parseDatasetteCmd(env.DATASETTE_CMD)
  if (override) return override

  if (onPath('datasette')) {
    return { command: 'datasette', args: [], via: 'bin' }
  }

  if (onPath('uvx')) {
    return { command: 'uvx', args: ['datasette'], via: 'uvx' }
  }

  if (onPath('pipx')) {
    return { command: 'pipx', args: ['run', 'datasette'], via: 'pipx' }
  }

  return null
}

/**
 * Validate + normalize the public base path the PANEL reports (its
 * `location.pathname` directory, e.g. `/ext/a1b2c3/`). It is the only
 * client-supplied value that reaches the child's command line, so it is
 * strictly shape-checked rather than trusted: absolute, trailing slash,
 * conservative path characters, no traversal. Returns null when unusable.
 */
export function normalizePublicBase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s.startsWith('/') || !s.endsWith('/')) return null
  if (s.length > 256) return null
  if (!/^\/(?:[A-Za-z0-9._-]+\/)*$/.test(s)) return null
  if (s.includes('..')) return null
  return s
}

/** The base_url Datasette is started with: the panel's public prefix plus the
 *  wrapper's own db/ mount. All links/assets Datasette emits start with this. */
export function baseUrlFor(publicBase: string): string {
  return publicBase + DATASETTE_SUBPATH
}

/**
 * Wrapper-owned argv appended after the launch spec's own args: the discovered
 * database files (or --memory when none, so the UI still comes up), loopback
 * binding on the internal port, and the base_url subpath mount.
 */
export function childArgs(dbFiles: string[], internalPort: number, publicBase: string): string[] {
  const files = dbFiles.length > 0 ? dbFiles : ['--memory']
  return [
    ...files,
    '--host',
    '127.0.0.1',
    '--port',
    String(internalPort),
    '--setting',
    'base_url',
    baseUrlFor(publicBase),
  ]
}

/** Build the child environment: pass the parent through (so the user's PATH /
 *  python config applies) minus Cate-internal vars the child must never see. */
export function childEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent }
  delete env.CATE_TOKEN
  delete env.CATE_API
  delete env.PORT
  return env
}

export interface DatasetteProcess {
  child: ChildProcess
  spec: DatasetteLaunchSpec
  internalPort: number
}

/** Spawn Datasette on `internalPort` serving `dbFiles` under the panel's public
 *  base. stdio is piped so the caller can capture stderr for Cate's error
 *  surface. Throws synchronously only if resolution fails; spawn errors arrive
 *  as 'error'/'exit' events on the returned child. */
export function spawnDatasette(
  dbFiles: string[],
  internalPort: number,
  publicBase: string,
  env: NodeJS.ProcessEnv = process.env,
  spec: DatasetteLaunchSpec | null = resolveLaunch(env),
): DatasetteProcess {
  if (!spec) {
    throw new Error(
      'Datasette not found. Install it (`uv tool install datasette`, `pipx install datasette` ' +
        'or `pip install datasette`), or set DATASETTE_CMD to a launch command (e.g. "python3 -m datasette").',
    )
  }
  const child = spawn(spec.command, [...spec.args, ...childArgs(dbFiles, internalPort, publicBase)], {
    env: childEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { child, spec, internalPort }
}
