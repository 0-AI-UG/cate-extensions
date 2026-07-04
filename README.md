# cate-extensions

Catalog repo for [Cate](https://github.com/0-AI-UG/cate) extensions. Each folder
under `extensions/` is one extension. CI builds each into a `.tgz` and uploads a
catalog index plus the artifacts to a rolling GitHub Release; Cate ships the
index URL as its default catalog source.

## Extensions

| Id | Shape | What it is |
| --- | --- | --- |
| `cate.aisession` | frontend-only | Read-only chat viewer for AI coding-agent session files: drop a session `.jsonl` onto the panel. |
| `cate.excalidraw` | frontend-only | The Excalidraw whiteboard as a canvas panel, themed and autosaved per panel. |
| `cate.mcp` | server-backed | MCP server manager: configure and supervise servers in `.cate/mcp.json`, explore tools, one aggregated `/mcp` endpoint. |
| `cate.mermaid` | frontend-only | Split-pane Mermaid editor with live render, per-panel autosave, SVG/PNG export. |
| `cate.sqlite` | server-backed | Read-only SQLite browser for workspace databases (bundled WASM engine, nothing installed or spawned). |
| `cate.usage` | server-backed | Agent usage and cost dashboard powered by ccusage. |

Two dev-only reference apps (`"dev": true` in the manifest: built and validated
by CI, excluded from the published catalog) demonstrate the two shapes end to
end:

- `cate.frontendkit`: frontend-only (static assets, no server).
- `cate.kitchensink`: server-backed (HTTP/WebSocket server, CATE_API, agent).

The shared UI kit at [`kit/`](kit/) keeps the extensions visually coherent with
Cate; see its README for how it syncs into each extension.

## Adding the catalog to Cate

Cate ships this index URL as a default catalog source, so nothing to configure.
To add it on an installation where it was removed, open Settings, Extensions,
Catalog sources, and add:

```
https://github.com/0-AI-UG/cate-extensions/releases/download/catalog/index.json
```

Then Refresh catalog. Listed extensions can be installed and enabled from the
same screen.

## Publishing

The trust boundary is PR review: changes land via pull request, and merging to
`main` publishes them.

- On a pull request, CI runs `./build.sh` to validate that every extension
  builds.
- On push to `main`, CI runs `./build.sh` with `CATALOG_BASE_URL` pointing at
  the rolling `catalog` release, then uploads `index.json` and every artifact
  tarball as assets on that one GitHub Release (`gh release upload --clobber`).
  GitHub serves them over its CDN:
  - `https://github.com/0-AI-UG/cate-extensions/releases/download/catalog/index.json`
  - `https://github.com/0-AI-UG/cate-extensions/releases/download/catalog/<id>-<version>.tgz`

Nothing is committed back to the repo and no GitHub Pages deploy is involved.
Stale tarballs from retired extensions may linger as release assets; that is
harmless because `index.json` (the source of truth) never references them.

## Index shape

A catalog source is an `http(s)://` URL; Cate fetches the index JSON:

```json
{
  "extensions": [
    {
      "manifest": { "...": "full ExtensionManifest" },
      "artifactUrl": "https://github.com/0-AI-UG/cate-extensions/releases/download/catalog/<id>-<version>.tgz",
      "sha256": "<hex>",
      "description": "..."
    }
  ]
}
```

For a remote index, `artifactUrl` must be an absolute `https://` URL; Cate
treats any URL without an `http(s)` scheme as a local filesystem path. The
`.tgz` has `manifest.json` at its root.

## Local development

```bash
./build.sh
```

With `CATALOG_BASE_URL` unset, this writes `dist/catalog/index.json` with
`file://` artifact URLs pointing at the on-disk `dist/artifacts/*.tgz`. Point
Cate's catalog source at the absolute path to that file:

```
/path/to/cate-extensions/dist/catalog/index.json
```

`build.sh` recreates `dist/` fresh each run: it syncs the kit, compiles every
extension that has a `package.json` build script, tars each `extensions/<id>/`
into `dist/artifacts/<id>-<version>.tgz`, then runs `scripts/gen-catalog.mjs` to
compute each sha256 and emit the index.

For a faster loop on a single extension, skip the catalog entirely and sideload
the extension folder in Cate: Settings, Extensions, "Add local folder...". On a
local workspace the folder is served in place, so edits only need a rebuild and
a panel reload.

## Repo layout

```
cate-extensions/
  extensions/<id>/            # one folder per extension
  kit/                        # shared UI kit: tokens, theme bridge, host typings,
                              #   ServiceConnection, server HTTP scaffolding
  scripts/sync-kit.mjs        # copies kit/ into consumers' src/_kit/ (+ src/_kitserver/)
  scripts/gen-catalog.mjs     # builds dist/catalog/index.json
  build.sh                    # sync-kit, npm builds, tars extensions, then gen-catalog
  .github/workflows/publish.yml
  dist/                       # build output (gitignored)
```

## Adding an extension

1. Create `extensions/<your-id>/` with a `manifest.json` (and a `README.md`
   whose first line is the catalog description if the manifest has no
   `description`).
2. If it needs compiling, add a `package.json` with a `build` script; `build.sh`
   runs `npm install` + `npm run build`, and when a `dist/` exists the artifact
   ships only `manifest.json` + `dist/`. Otherwise the whole folder ships as-is.
3. To build on the shared UI kit, add the id to `KIT_CONSUMERS` (and
   `SERVER_CONSUMERS` for the Node HTTP scaffolding) in `scripts/sync-kit.mjs`,
   run `node scripts/sync-kit.mjs`, and commit the synced `src/_kit/` copies.
   Never edit `src/_kit/` directly; CI fails on stale copies.
4. Open a PR. CI validates the build. Expect the review to double as a security
   review: servers run unsandboxed on user machines.
5. On merge to `main` it is published automatically. For later changes, bump
   `version` in `manifest.json` (and `package.json`); the artifact name embeds
   it.

### Manifest fields

| Field | Purpose |
| --- | --- |
| `id` | Unique extension id (e.g. `cate.kitchensink`); also the artifact name prefix. Must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` (it becomes a filesystem path). |
| `name` | Display name shown in the catalog. |
| `version` | SemVer; the artifact is `<id>-<version>.tgz`. Bump it for every published change. |
| `panels` | `[{ id, label, icon?, defaultSize? }]`, the panels the extension contributes. Required, non-empty; `icon` is an inline SVG string, `defaultSize` is `{ width, height }`. |
| `frontend` | Entry HTML for frontend-only extensions (e.g. `dist/index.html`). Ignored when `server` is present: the server serves its own frontend. |
| `server` | Optional, for server-backed extensions: `{ command, readyPath, portEnv }`. `readyPath` defaults to `/health`, `portEnv` to `PORT`. |
| `cateApi` | Scopes the extension uses (default-deny, host-enforced): `workspace.read`, `theme`, `ui`, `editor.read`/`editor.write`, `storage`, `canvas`, `files.drop`, `agent`. A bare namespace like `editor` grants its sub-scopes. |
| `description` | Optional; overrides the README first line in the catalog. |
| `dev` | `true` keeps the extension out of the published catalog (still built and validated); for reference apps. |
