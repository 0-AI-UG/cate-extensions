# cate-extensions

Extensions for [Cate](https://github.com/0-AI-UG/cate). One folder per extension
under `extensions/`, published to the catalog Cate ships by default.

## Extensions

- **AI** — `cate.aisession` (session file viewer), `cate.mcp` (MCP server
  manager), `cate.usage` (agent usage and cost)
- **Data** — `cate.sqlite` (read-only SQLite browser)
- **Design** — `cate.excalidraw` (whiteboard), `cate.mermaid` (diagram editor)
- **Development** — `cate.frontendkit`, `cate.kitchensink` (reference apps,
  `"dev": true`, sideload only)

## Layout

- `extensions/<id>/` — one extension
- `kit/` — shared UI kit: tokens, theme bridge, host typings, ServiceConnection,
  proxy api-client, server scaffolding (see `kit/README.md`)
- `scripts/sync-kit.mjs` — copies `kit/` into consumers' `src/_kit/`
- `scripts/gen-catalog.mjs` — builds `dist/catalog/index.json`
- `build.sh` — sync-kit, npm builds, tars artifacts, generates the catalog

## Development

- `./build.sh`, then add the absolute path of `dist/catalog/index.json` as a
  catalog source in Cate. Local entries re-provision on panel open.
- Single extension: sideload its folder via Settings, Extensions, "Add local
  folder...".

## Contributing

Authoring (manifest, scopes, `window.cate` API, server contract) lives in the
Cate repo: [`docs/extensions.md`](https://github.com/0-AI-UG/cate/blob/main/docs/extensions.md),
[`skills/cate-extension/SKILL.md`](https://github.com/0-AI-UG/cate/blob/main/skills/cate-extension/SKILL.md).
Here:

- `extensions/<id>/` with `manifest.json`; a README's first line is the catalog
  description fallback.
- `category` in the manifest: `ai`, `development`, `data`, `design`,
  `productivity`, `communication`, `sales`, `other`. Pick by what it is for, not
  how it is built. The list stays short; use `other` rather than adding one.
- With a `build` script, the artifact ships `manifest.json` + `dist/`;
  otherwise the folder as-is.
- Kit consumers: add the id in `scripts/sync-kit.mjs`, run it, commit
  `src/_kit/` (never edit it directly). `--check` reports stale copies.
- Not meant for users yet: `"dev": true` keeps it out of the catalog.
- `./build.sh` must pass; bump `version` for every published change.

## Publishing

PR CI runs `./build.sh`; merging to `main` rebuilds and uploads `index.json`
plus the artifact tarballs to the rolling `catalog` release.
