# cate.sqlite — status

Replaces the old `cate.datasette` wrapper. Same goal (explore workspace SQLite
on the canvas), but self-contained: no external `datasette`/`sqlite` install and
no child process.

## Engine

- SQLite is read via **sql.js** (SQLite compiled to WASM), a runtime dependency
  bundled into the artifact. `build:server` esbuild-bundles the JS engine into
  `dist/server.js`; `copy-static.mjs` copies `sql-wasm.wasm` next to it, and
  `db.ts` points `initSqlJs({ locateFile })` at that copy. So the shipped
  artifact (`manifest.json` + `dist/`) needs no `node_modules` and no network.
- A file is loaded fully into memory (sql.js has no incremental backend) and the
  opened `Database` is cached per absolute path, keyed on the file's mtime —
  pagination reuses the load; a changed file (or a Rescan) reloads transparently.
- **Read-only end to end**: the in-memory copy is never written back, and the
  query endpoint gates on `isReadOnlySql` (leader keyword must be
  SELECT / WITH / EXPLAIN / PRAGMA / VALUES; batches with a hidden write are
  rejected).

## Run model

- Server binds Cate's `PORT` on `127.0.0.1` and answers `/health` immediately.
- Panel talks to a small JSON API (all URLs relative, so they tunnel through
  Cate's proxy which injects the bearer):
  - `GET /api/databases` — scanned databases + each one's tables/views.
  - `GET /api/table?db&table&limit&offset&orderBy&dir` — one bounded page.
    `table`/`orderBy` are whitelisted against the live schema and quoted;
    limit/offset are clamped integers.
  - `POST /api/query {db, sql}` — read-only query, results capped at 1000 rows.
  - `POST /api/rescan` — re-scan the workspace + drop the db cache.
- `db` is always a workspace-relative path resolved against the scanned index;
  an arbitrary path never opens a file.

## Verified vs. assumed

- Verified: the pure helpers (clamp, quoteIdent, isReadOnlySql), and the
  sql.js-backed reader (listTables, readTable pagination/sort/whitelist,
  runQuery read-only gate, mtime cache reload) are unit + integration tested;
  the extension builds + typechecks (server, browser, tests).
- Assumed (needs a live run): the panel UI under Cate's `/ext/<token>/` proxy,
  and WASM load time on first open in the packaged app.
