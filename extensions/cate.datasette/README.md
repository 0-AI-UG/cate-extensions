Explore the SQLite databases in your workspace with Datasette, launched locally and embedded as a Cate panel.

# Datasette for Cate

[Datasette](https://datasette.io) (Apache-2.0) turns SQLite files into an
explorable web UI: browse tables, filter, facet, run SQL, export CSV/JSON. This
extension launches a local Datasette over the `.db` / `.sqlite` / `.sqlite3`
files found in your workspace and embeds it in a panel on the canvas.

Datasette is a Python app, so it is **not bundled** (official Cate extension
artifacts ship only JS + static assets). The wrapper resolves a way to run it
from your machine, in this order:

1. `DATASETTE_CMD` env override (e.g. `python3 -m datasette`)
2. `datasette` on PATH (`uv tool install datasette`, `pipx install datasette`, `pip install datasette`)
3. `uvx datasette` (first run downloads into uv's cache)
4. `pipx run datasette`

If none is available the panel shows an actionable error instead of a spawn
failure.

## What it does

- **Scans the workspace** (bounded depth, skips `node_modules`/`.git`/build
  dirs) for SQLite files, verified by the `SQLite format 3` magic header — a
  stray non-SQLite `.db` file is never passed along. Capped at 20 databases.
- **Launches Datasette read-only** on a private loopback port and
  reverse-proxies it into the panel. Datasette's `base_url` is set to the
  panel's own proxied prefix, so its links and assets resolve with no URL
  rewriting.
- **Rescan** button restarts Datasette with a fresh scan (picks up newly
  created database files).
- No SQLite files? Datasette starts with an in-memory database so the UI (and
  its SQL prompt) still works.

## Notes

- Datasette serves reads only by default; nothing in this panel writes to your
  databases.
- The child process binds `127.0.0.1` and is reachable only through Cate's
  token-gated proxy.
- First launch via `uvx`/`pipx run` downloads Datasette; the panel shows the
  captured install log while it provisions (up to 90s).

## Develop

```bash
npm install && npm run build && npm test
```
