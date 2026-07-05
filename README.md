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

## Local development

```bash
./build.sh
```

With `CATALOG_BASE_URL` unset, this writes `dist/catalog/index.json` with
`file://` artifact URLs pointing at the on-disk `dist/artifacts/*.tgz`. Point
Cate's catalog source at the absolute path to that file. Local catalog entries
re-provision on panel open, so edits land without version bumps.

For a faster loop on a single extension, skip the catalog entirely and sideload
the extension folder in Cate: Settings, Extensions, "Add local folder...". On a
local workspace the folder is served in place, so edits only need a rebuild and
a panel reload.

## Contributing an extension

How to build one (the manifest, `cateApi` scopes, the `window.cate` host API,
the server contract, the kit) is documented in the Cate repo:
[`docs/extensions.md`](https://github.com/0-AI-UG/cate/blob/main/docs/extensions.md)
for the extension system and
[`skills/cate-extension/SKILL.md`](https://github.com/0-AI-UG/cate/blob/main/skills/cate-extension/SKILL.md)
for the field-by-field authoring guide. What this repo adds:

- One folder per extension: `extensions/<id>/` with a `manifest.json` and a
  `README.md` whose first line is the catalog description fallback.
- If it needs compiling, expose a `build` script in `package.json`; `build.sh`
  runs `npm install` + `npm run build`, and when a `dist/` exists the artifact
  ships only `manifest.json` + `dist/` (otherwise the whole folder ships
  as-is).
- To build on the shared UI kit, add the id to `KIT_CONSUMERS` (and
  `SERVER_CONSUMERS` for the Node HTTP scaffolding) in `scripts/sync-kit.mjs`,
  run `node scripts/sync-kit.mjs`, and commit the synced `src/_kit/` copies.
  Never edit `src/_kit/` directly; CI fails on stale copies.
- `./build.sh` must pass end to end, then open a PR.
- For later changes, bump `version` in `manifest.json` (and `package.json`);
  the artifact name embeds it.

## Publishing

- On a pull request, CI runs `./build.sh` to validate that every extension
  builds.
- On merge to `main`, CI runs `./build.sh` with `CATALOG_BASE_URL` pointing at
  the rolling `catalog` release, then uploads `index.json` and every artifact
  tarball as assets on that release (`gh release upload --clobber`).

Stale tarballs from retired extensions may linger as release assets; that is
harmless because `index.json` never references them.
