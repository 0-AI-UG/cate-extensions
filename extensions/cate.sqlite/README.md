Browse and query the SQLite databases in your workspace, right on the Cate canvas.

# SQLite viewer for Cate

A self-contained SQLite browser: it finds the `.db` / `.sqlite` / `.sqlite3`
files in your workspace and lets you explore their tables and views, page
through rows, sort by any column, and run read-only SQL.

Unlike a Datasette-style wrapper, **nothing is installed or spawned**. SQLite is
compiled to WebAssembly and bundled into the extension (`sql.js`), so the reader
runs in-process on any Node ≥ 18, on local and remote workspaces alike.

## What it does

- **Scans the workspace** (bounded depth, skips `node_modules`/`.git`/build
  dirs) for SQLite files, verified by the `SQLite format 3` magic header — a
  stray non-SQLite `.db` file is never listed. Capped at 20 databases.
- **Lists** each database's tables and views in a sidebar.
- **Table view**: rows load in bounded chunks; a "Load more" row at the end of
  the scrolled grid appends the next chunk (25 / 100 / 500, selectable), with
  primary-key markers, column types, and click-to-sort headers. The sidebar is
  collapsible to a slim rail (agent-panel idiom).
- **SQL box** (button in the sidebar head): run read-only queries (`SELECT` /
  `WITH` / `EXPLAIN` / `PRAGMA`) against the selected database; results are
  capped at 1000 rows. Writes and DDL are rejected.
- **Auto-detection**: the workspace is re-scanned when the panel regains
  visibility and every 60 seconds while visible, so new database files appear
  without manual chrome (the sidebar updates in place; the open table is never
  reloaded underneath the reader).

## Notes

- **Read-only.** The file is loaded into a private in-memory copy; nothing here
  ever writes back to your databases.
- The server binds `127.0.0.1` and is reachable only through Cate's token-gated
  proxy. It reads database files with a bundled WASM engine — no child process,
  no network.
- BLOB values are shown as a `⟨blob N bytes⟩` placeholder rather than raw bytes.

## Develop

```bash
npm install && npm run build && npm test
```
