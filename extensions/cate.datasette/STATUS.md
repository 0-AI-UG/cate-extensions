# cate.datasette — status

## License

Datasette is Apache-2.0. It is still **not bundled**: catalog artifacts ship
only `manifest.json` + `dist/` (JS + static assets), and Datasette is a Python
package. The wrapper resolves an install from the user's machine
(`DATASETTE_CMD` → `datasette` on PATH → `uvx` → `pipx run`) — the mcphub
"run-for-me" model.

## Run model

- Wrapper binds Cate's `PORT` on `127.0.0.1` and answers `/health` immediately
  (bind-fast; Datasette itself starts lazily on the panel's start request).
- Panel POSTs `/__datasette/start` with its `publicBase` (`location.pathname`
  directory, i.e. `/ext/<routeToken>/`). The wrapper spawns
  `datasette <dbs> --host 127.0.0.1 --port <internal> --setting base_url <publicBase>db/`
  and probes that base path until it answers (90s window — a first
  `uvx`/`pipx run` also downloads the package).
- `/db/*` requests are forwarded to the child at `<publicBase>db/*` (the child
  serves under its full base_url; Cate's proxy strips the prefix, the wrapper
  re-adds it). Because base_url carries the public prefix, every URL Datasette
  emits — links, assets, redirects — resolves through Cate's proxy untouched.
- `/__datasette/restart` stops the child and relaunches with a fresh workspace
  scan (panel "Rescan" button).
- Supervision mirrors mcphub: stderr tail captured for the error card (reset
  per run), early-exit detection during startup, SIGTERM→SIGKILL teardown,
  restart via the panel's Retry. Each (re)start is generation-numbered so a
  replaced child's late exit/output can't clobber the run that superseded it;
  a readiness-timeout child is reaped before the error is reported; a
  process-exit hook SIGKILLs any surviving child on abnormal wrapper exit.

## Verified vs. assumed

- Verified: launch resolution order, arg building, publicBase validation, and
  the SQLite scan (magic header, skip dirs, caps) are unit-tested; the wrapper
  builds + typechecks (server, browser, tests).
- Assumed (needs a live run): Datasette's UI under a two-level proxy
  (`/ext/<token>/db/`), uvx first-run download time within the 90s window.

## Known limits

- New `.db` files require a Rescan (Datasette only attaches files present at
  launch).
- `publicBase` is in-memory; after a Cate restart the panel re-reports it on
  the next start request (route tokens are per-app-run).
- Locked databases (e.g. a WAL DB held open by a running app) are attached
  read-only by Datasette; heavily locked files may error inside Datasette's
  own UI, which the panel surfaces as-is.
