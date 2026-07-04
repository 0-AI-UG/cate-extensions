# Cate extension UI kit

Shared, framework-agnostic UI building blocks so every extension is visually
coherent with Cate and with the rest of the catalog. **This directory is the
single source of truth.**

| File | What it is |
|---|---|
| `cate-kit.css` | Design tokens (`--cate-*`) + base component classes (`cate-*`): app shell, buttons, inputs, cards, banners, drawer, empty state, spinner, and the service-connection card. |
| `theme.ts` | `applyTheme()` / `initTheme()`: maps `cate.theme.get()` onto the kit's `--cate-*` tokens. The one canonical theme bridge (replaces per-extension `pick(...)` guesswork). |
| `service-connection.ts` | `ServiceConnection`: vanilla state-machine widget that gates a content area behind a coherent connection card (provisioning / connecting / connect-form / error / ready). Used by cate.mcp. |
| `api-client.ts` | `proxyBasePath()` / `apiFetch()`: panel-to-server calls through Cate's proxy. Fetch relative paths and the proxy injects the bearer token, so the webview never holds it. |
| `cate-host.d.ts` | Typings for the injected `cate` host API, mirrored from the Cate repo's canonical `src/shared/cate-host-api.d.ts`. Imported for types only; does not augment global scope. |
| `server/http.ts` | Node HTTP scaffolding for server-backed extensions (bind `HOST`/`PORT`, token gate, JSON helpers). Ships in its own tier, see below. |

## How it ships

There is no monorepo and each extension must build self-contained, so the kit is
**copied** into each consuming extension at `src/_kit/` by
`scripts/sync-kit.mjs`. The copies are committed (tests and the IDE work with no
pre-step). `build.sh` runs the sync before compiling.

```bash
node scripts/sync-kit.mjs          # propagate kit/ -> consumers' src/_kit/ (+ src/_kitserver/)
node scripts/sync-kit.mjs --check  # CI: fail if any copy is stale
```

Two tiers, with separate consumer lists in `scripts/sync-kit.mjs`:

- Browser files sync to `src/_kit/` for the extensions in `KIT_CONSUMERS`.
- `server/*.ts` (imports Node builtins) syncs to `src/_kitserver/` for the
  extensions in `SERVER_CONSUMERS`, so browser tsconfigs never see it.

`cate.excalidraw` (full-bleed upstream app, no Cate chrome) and the
`cate.frontendkit` / `cate.kitchensink` dev references are deliberately not
consumers; they keep standalone copies.

**Never edit `src/_kit/` or `src/_kitserver/` directly**: edit here and re-run
the sync.
