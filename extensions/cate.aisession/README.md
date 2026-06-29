View an AI coding-agent session as a chat. Drop a session file onto the panel and it renders the conversation read-only.

# AI Session Viewer

A Cate extension that turns an agent's on-disk session log back into a readable
conversation. Drag a session file onto the panel — from your file manager or
Cate's own file explorer — and it parses the transcript and lays it out like a
chat: user and assistant turns, collapsible reasoning, and tool calls with their
results.

Nothing is sent anywhere and nothing runs — it's a static viewer.

## Supported formats

| Agent | Where the files live |
| --- | --- |
| **Claude Code** | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| **pi** (Cate's agent) | `<project>/.cate/pi-agent/sessions/<encoded-cwd>/*.jsonl` |
| Generic | A JSON array of `{ role, content }`, an object with a `messages` array, or JSONL of the same |

The format is detected from the file's structure, not its name, so any `.jsonl`
from a supported agent works regardless of where it came from.

## How drag-and-drop works

The panel accepts two drop sources via the `files.drop` capability:

- **OS file manager** — the dropped file is read in the panel itself.
- **Cate's file explorer** — Cate reads the file and forwards its contents to the
  panel (`cate.files.onDrop`), so the extension never needs filesystem access.

## Permissions

- `files.drop` — receive files dropped onto the panel.
- `theme` — match Cate's light/dark theme.

## Development

```bash
npm install
npm run build       # vite build + postbuild HTML fixup -> dist/
npm test            # parser unit tests (vitest)
npm run typecheck
```

`npm run build` is what the catalog's `build.sh` runs; only `manifest.json` and
`dist/` ship in the artifact.
