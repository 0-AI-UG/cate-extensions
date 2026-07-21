# cate-extensions

Extensions for [Cate](https://github.com/0-AI-UG/cate). Each folder under
`extensions/` is one extension, published to the catalog Cate ships by default:

```
https://github.com/0-AI-UG/cate-extensions/releases/download/catalog/index.json
```

## Extensions

| Id | Shape | What it is |
| --- | --- | --- |
| `cate.aisession` | frontend-only | Read-only chat viewer for AI coding-agent session files: drop a session `.jsonl` onto the panel. |
| `cate.excalidraw` | frontend-only | The Excalidraw whiteboard as a canvas panel, themed and autosaved per panel. |
| `cate.mcp` | server-backed | MCP server manager: configure and supervise servers in `.cate/mcp.json`, explore tools, one aggregated `/mcp` endpoint. |
| `cate.mermaid` | frontend-only | Split-pane Mermaid editor with live render, per-panel autosave, SVG/PNG export. |
| `cate.sqlite` | server-backed | Read-only SQLite browser for workspace databases (bundled WASM engine, nothing installed or spawned). |
| `cate.usage` | server-backed | Agent usage and cost dashboard powered by ccusage. |

Two more folders are reference implementations, not products. They carry
`"dev": true` in their manifest, so `gen-catalog.mjs` leaves them out of the
published catalog and you only get them by sideloading:

| Id | Shape | What it is |
| --- | --- | --- |
| `cate.frontendkit` | frontend-only | Smallest useful extension: static assets, no server, no build step. |
| `cate.kitchensink` | server-backed | Exercises the host API: most `cate.*` scopes, a Node server, WebSockets. |

## Repo layout

```
cate-extensions/
  extensions/<id>/            # one folder per extension
  kit/                        # shared UI kit: tokens, theme bridge, host typings,
                              #   ServiceConnection, proxy api-client, server
                              #   HTTP scaffolding (see kit/README.md)
  scripts/sync-kit.mjs        # copies kit/ into consumers' src/_kit/ (+ src/_kitserver/)
  scripts/gen-catalog.mjs     # builds dist/catalog/index.json
  build.sh                    # sync-kit, npm builds, tars extensions, then gen-catalog
  .github/workflows/publish.yml
  dist/                       # build output (gitignored)
```

## Local development

`./build.sh` writes `dist/catalog/index.json` with `file://` artifact URLs;
add its absolute path as a catalog source in Cate. Local entries re-provision
on panel open, so edits land without version bumps.

Faster for a single extension: sideload its folder via Settings, Extensions,
"Add local folder...".

## Contributing

Authoring (manifest, scopes, `window.cate` API, server contract) is documented
in the Cate repo:
[`docs/extensions.md`](https://github.com/0-AI-UG/cate/blob/main/docs/extensions.md)
and
[`skills/cate-extension/SKILL.md`](https://github.com/0-AI-UG/cate/blob/main/skills/cate-extension/SKILL.md).
In this repo:

- `extensions/<id>/` with a `manifest.json`; the README's first line is the
  catalog description fallback.
- With a `build` script in `package.json`, `build.sh` compiles it and the
  artifact ships only `manifest.json` + `dist/`; otherwise the folder ships
  as-is.
- Kit consumers: add the id in `scripts/sync-kit.mjs`, run it, commit the
  synced `src/_kit/` (never edit it directly). `--check` reports stale copies
  without writing.
- A reference or work-in-progress extension that should not reach users gets
  `"dev": true`; the catalog skips it and it stays sideload-only.
- `./build.sh` must pass; bump `version` for every published change.

## Publishing

PR CI validates `./build.sh`; merge to `main` rebuilds against the rolling
`catalog` release and uploads `index.json` plus the artifact tarballs as its
assets.
