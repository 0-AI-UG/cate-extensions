Agent usage and cost dashboard powered by ccusage. Reads the local Claude Code data (~/.claude) on the machine running the extension server and shows a stat strip for today, this week, this month, and everything still on disk, a daily cost/token timeline, and a per-model cost split. No data leaves the machine.

# cate.usage

A server-backed Cate extension that turns the machine's Claude Code usage logs
into a single-screen dashboard panel (nothing scrolls):

- A stat strip: cost and tokens for today, this ISO week, this calendar month,
  and the full retained window (labelled "Since <date>", never "all time").
- The timeline: a daily bar chart (cost or tokens, 30/60/90 day window) with
  hover details, flexing to the panel height.
- A per-model chip strip under the chart: cost and cost share per model, full
  token breakdown in the tooltip. (Recent-session and monthly aggregates stay
  available via the API endpoints.)
- Loads show real progress: the panel polls `GET /api/status` and reports what
  the server is doing (scanning logs, checking live prices, reading N files),
  with a determinate bar paced by the previous read's duration.
- Auto-refreshes every 60 seconds while the panel is visible (no manual
  chrome; the empty state's "Check again" forces a re-read via
  `POST /api/refresh`).

## Where the data comes from

The server invokes [ccusage](https://github.com/ccusage/ccusage) as a library:
`ccusage/data-loader` (pinned to 18.0.11, the last pure-JS release line) is
bundled by esbuild straight into `dist/server.js`, so the shipped artifact
spawns nothing, installs nothing, and needs no node_modules or network to read
usage. ccusage parses the JSONL transcripts under `~/.claude/projects` (or
`CLAUDE_CONFIG_DIR`) and aggregates tokens and cost per day, session, model,
and month.

Costs are token counts priced against LiteLLM's model table. The server first
tries to fetch the live table so brand-new models price correctly; if that
fails (offline machine), it falls back to ccusage's bundled table and the panel
shows an "offline pricing" badge, since models newer than the pinned ccusage
may then report zero cost.

### Retention: there is no "all time"

Claude Code deletes its own transcripts once they pass `cleanupPeriodDays`
(30 by default, set in `~/.claude/settings.json`). ccusage can only price what
survives, so the widest bucket this panel can honestly show is "everything
still on disk" — it is labelled `Since <first day with usage>`, and the report
carries that day as `coverageStart`. On a default install that window is the
last 30 days no matter how long the agent has actually been in use.

Note: usage data lives on the machine where the extension server runs. For a
remote workspace that is the remote host, so the dashboard shows that machine's
agent usage, not the local laptop's. If no Claude Code data exists there, the
panel explains that instead of erroring.

Reports are cached in-memory for 60 seconds; `POST /api/refresh` drops the
cache.

## Endpoints

Everything except `/health` is bearer-token gated behind Cate's proxy.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | readiness probe (auth-exempt) |
| `GET /api/status` | in-flight load progress (never blocks on the load) |
| `GET /api/report?days=N&sessions=M` | full dashboard payload |
| `GET /api/daily?days=N` | zero-filled daily cost/token series |
| `GET /api/sessions?limit=N` | recent sessions |
| `GET /api/models` | per-model breakdown |
| `GET /api/monthly` | monthly totals |
| `POST /api/refresh` | drop the cache and return a fresh report |

## Development

```bash
npm install
npm run build      # dist/server.js + dist/public/*
npm test           # vitest: report shaping + cache
npm run typecheck
```

Run the server standalone:

```bash
PORT=8123 HOST=127.0.0.1 CATE_TOKEN=dev node dist/server.js
curl -s http://127.0.0.1:8123/health
curl -s -H 'Authorization: Bearer dev' 'http://127.0.0.1:8123/api/report?days=30'
```

## Scopes

`theme` (panel theming), `storage` (chart window and metric preferences).

## License and attribution

This extension bundles [ccusage](https://github.com/ccusage/ccusage), which is
MIT licensed, copyright ccusage contributors (originally by @ryoppippi). The
extension itself follows the cate-extensions repo license.
