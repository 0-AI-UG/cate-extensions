# cate-extensions

The dedicated catalog repo for [Cate](https://github.com/0-AI-UG/cate)
extensions. Each folder under `extensions/` is one extension; CI builds each
into a distributable `.tgz` and publishes a catalog index plus the artifacts to
GitHub Pages. Cate points at the published index URL as a catalog source.

## Adding the catalog to Cate

In Cate, open **Settings → Extensions → Catalog sources** and add:

```
https://0-ai-ug.github.io/cate-extensions/catalog/index.json
```

Then **Refresh catalog**. Listed extensions can be installed and enabled from
the same screen.

## How publishing works

The trust boundary is **PR review**: new extensions and changes land via pull
request, and merging to `main` is what publishes them.

- On a **pull request**, CI runs `./build.sh` to validate that every extension
  builds (no deploy).
- On **push to `main`**, CI runs
  `CATALOG_BASE_URL=https://0-ai-ug.github.io/cate-extensions ./build.sh` and
  deploys `dist/` to GitHub Pages. This makes the following live:
  - `https://0-ai-ug.github.io/cate-extensions/catalog/index.json`
  - `https://0-ai-ug.github.io/cate-extensions/artifacts/<id>-<version>.tgz`

(GitHub Pages for the `0-AI-UG` org is served from the lowercased
`0-ai-ug.github.io` host.)

## How Cate consumes the index

A catalog source is an `http(s)://` URL; Cate fetches the index JSON. Shape:

```json
{
  "extensions": [
    {
      "manifest": { "...": "full ExtensionManifest" },
      "artifactUrl": "https://0-ai-ug.github.io/cate-extensions/artifacts/<id>-<version>.tgz",
      "sha256": "<hex>",
      "description": "..."
    }
  ]
}
```

For a remote index, `artifactUrl` **must be an absolute `https://` URL** — Cate
treats any URL without an `http(s)` scheme as a **local filesystem path**. The
`.tgz` artifact has `manifest.json` at its **root** (built with the extension
dir as the tar CWD) and excludes macOS `._*` junk.

## Local development

```bash
./build.sh
```

With `CATALOG_BASE_URL` unset, this writes `dist/catalog/index.json` with
`file://` artifact URLs pointing at the on-disk `dist/artifacts/*.tgz`. Point
Cate's catalog source at the **absolute path** to that file, e.g.:

```
/path/to/cate-extensions/dist/catalog/index.json
```

`build.sh` recreates `dist/` fresh on each run and (1) tars each
`extensions/<id>/` into `dist/artifacts/<id>-<version>.tgz`, then (2) runs
`scripts/gen-catalog.mjs` to compute each artifact's sha256 and emit the index.

## Repo layout

```
cate-extensions/
  extensions/<id>/            # extension sources (one folder per extension)
    cate.kitchensink/         # full-stack (server-backed) API demo
    cate.frontendkit/         # frontend-only (static assets, no server) API demo
  scripts/gen-catalog.mjs     # builds dist/catalog/index.json (dependency-free)
  build.sh                    # tars extensions -> dist/artifacts, then gen-catalog
  .github/workflows/publish.yml  # PR build + Pages deploy on main
  dist/                       # build output (gitignored): artifacts/ + catalog/
```

## Adding an extension

1. Create `extensions/<your-id>/` with a `manifest.json` (and a `README.md`
   whose first line is used as the catalog description if the manifest has no
   `description` field).
2. Open a PR. CI validates the build.
3. On merge to `main` it is published to the catalog automatically.

### Manifest fields

| Field | Purpose |
| --- | --- |
| `id` | Unique extension id (e.g. `cate.kitchensink`); also the artifact name prefix. |
| `name` | Display name shown in the catalog. |
| `version` | SemVer; the artifact is `<id>-<version>.tgz`. |
| `panels` | `[{ id, label }]` — panels the extension contributes. |
| `server` | Optional, for server-backed extensions: `{ command, readyPath, portEnv }`. |
| `cateApi` | Scopes the extension uses; default-deny and enforced by the host. One of `workspace.read`, `theme`, `ui`, `editor.read`/`editor.write`, `storage`, `canvas`, `agent` (a bare namespace like `editor` grants its sub-scopes). |
| `description` | Optional; overrides the README first line in the catalog. |

## Verifying an extension in the running app

After building locally and adding the catalog source, open the extension's
panel and check each stack layer. For the kitchen-sink demo:

| Section in the panel | What to check | Proves |
| --- | --- | --- |
| **cateHost bridge** | `cate.version` shows a number; `panel.id` is set; `workspace` shows your workspace root; `theme` matches Cate's active theme. | Preload bridge + `version`/`workspace.get`/`theme.get`. |
| **Notes (autosave)** | Type in the textarea; status flips to "autosaved". Reopen the panel — text is restored. | `cate.storage.get/set` persistence. |
| **Cate actions** | Open package.json in an editor panel; spawn a second panel; set the panel title. | Reverse API: `editor.openFile`, `canvas.createPanel`, `panel.setTitle`. |
| **HTTP tunnel** | `GET /api/info` returns workspace/pid/time; `POST /api/echo` echoes the body. | Page → proxy → daemon-hosted server HTTP tunneling. |
| **WebSocket echo** | Shows "WebSocket open"; sending round-trips `echo: <message>`. | WS upgrade tunneling. |
| **Server → Cate round-trip** | Prints `OK` with matching `wrote`/`read`. | `CATE_API` reverse channel. |
| **Run the agent** | Enter a prompt and run; first use prompts for consent, the turn appears in the Agent panel, and the final text shows in the panel. | `cate.agent.run` (server delegates a turn to Cate's bundled agent). |
| **CATE_TOKEN injection** | The page loads and works at all (server 401s any non-`/health` request lacking the bearer). | The proxy injects `Authorization: Bearer <CATE_TOKEN>`. |
