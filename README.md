# cate-extensions

Catalog repo for [Cate](https://github.com/0-AI-UG/cate) extensions. Each folder
under `extensions/` is one extension. CI builds each into a `.tgz` and publishes
a catalog index plus the artifacts to GitHub Pages; Cate points at the index URL
as a catalog source.

Two example extensions:

- `cate.frontendkit`: frontend-only (static assets, no server).
- `cate.kitchensink`: server-backed (HTTP/WebSocket server, CATE_API, agent).

## Adding the catalog to Cate

In Cate, open Settings, Extensions, Catalog sources, and add:

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

`build.sh` recreates `dist/` fresh each run: it tars each `extensions/<id>/`
into `dist/artifacts/<id>-<version>.tgz`, then runs `scripts/gen-catalog.mjs` to
compute each sha256 and emit the index.

## Repo layout

```
cate-extensions/
  extensions/<id>/            # one folder per extension
    cate.kitchensink/         # server-backed demo
    cate.frontendkit/         # frontend-only demo
  scripts/gen-catalog.mjs     # builds dist/catalog/index.json
  build.sh                    # tars extensions, then gen-catalog
  .github/workflows/publish.yml
  dist/                       # build output (gitignored)
```

## Adding an extension

1. Create `extensions/<your-id>/` with a `manifest.json` (and a `README.md`
   whose first line is the catalog description if the manifest has no
   `description`).
2. Open a PR. CI validates the build.
3. On merge to `main` it is published automatically.

### Manifest fields

| Field | Purpose |
| --- | --- |
| `id` | Unique extension id (e.g. `cate.kitchensink`); also the artifact name prefix. |
| `name` | Display name shown in the catalog. |
| `version` | SemVer; the artifact is `<id>-<version>.tgz`. |
| `panels` | `[{ id, label }]`, the panels the extension contributes. |
| `server` | Optional, for server-backed extensions: `{ command, readyPath, portEnv }`. |
| `cateApi` | Scopes the extension uses (default-deny, host-enforced): `workspace.read`, `theme`, `ui`, `editor.read`/`editor.write`, `storage`, `canvas`, `agent`. A bare namespace like `editor` grants its sub-scopes. |
| `description` | Optional; overrides the README first line in the catalog. |
