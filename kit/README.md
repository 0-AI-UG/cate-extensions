# Cate extension UI kit

Shared, framework-agnostic UI building blocks so every extension is visually
coherent with Cate and with the rest of the catalog. **This directory is the
single source of truth.**

| File | What it is |
|---|---|
| `cate-kit.css` | Design tokens (`--cate-*`) + base component classes (`cate-*`): app shell, buttons, inputs, cards, banners, drawer, empty state, spinner, and the service-connection card. |
| `theme.ts` | `applyTheme()` / `initTheme()` — maps `cate.theme.get()` onto the kit's `--cate-*` tokens. The one canonical theme bridge (replaces per-extension `pick(...)` guesswork). |
| `service-connection.ts` | `ServiceConnection` — vanilla state-machine widget that gates a content area behind a coherent connection card (provisioning / connecting / connect-form / error / ready). Used by datasette. |
| `cate-host.d.ts` | Canonical typings for the injected `cate` host API. Imported for types only; does not augment global scope. |

## How it ships

There is no monorepo and each extension must build self-contained, so the kit is
**copied** into each consuming extension at `src/_kit/` by
`scripts/sync-kit.mjs`. The copies are committed (tests and the IDE work with no
pre-step). `build.sh` runs the sync before compiling.

```bash
node scripts/sync-kit.mjs          # propagate kit/ -> consumers' src/_kit/
node scripts/sync-kit.mjs --check  # CI: fail if any copy is stale
```

Consuming extensions are listed in `KIT_CONSUMERS` in `scripts/sync-kit.mjs`.
**Never edit `src/_kit/` directly** — edit here and re-run the sync.
