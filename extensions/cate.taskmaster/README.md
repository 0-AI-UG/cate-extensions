# Task Master Board (cate.taskmaster)

A Cate panel that renders a kanban board from a project's
[Task Master](https://github.com/eyaltoledano/claude-task-master) tasks.

Unlike most Cate extensions, there is no upstream web UI to wrap — this panel is
built from scratch and reads the task data Task Master writes to disk
(`.taskmaster/tasks/tasks.json`).

## What it does

- **Kanban board** — Pending / In Progress / Done columns grouped from each
  task's `status`.
- **Tag contexts** — supports Task Master's tagged format
  (`{ "master": { "tasks": [...] }, "feature-x": { ... } }`) with a context
  selector, and the legacy flat format (`{ "tasks": [...] }`).
- **Task detail drawer** — description, dependencies, subtasks, details, and
  test strategy.
- **Cate-native glue**
  - `cate.theme.get()` — match Cate's light/dark theme.
  - `cate.editor.openFile(path, { line })` — click a file reference parsed from a
    task's text to open it in the editor.
  - `cate.agent.run({ prompt })` — "Send to agent" hands a task to Cate's
    bundled agent.
  - `cate.storage.panel` — remembers the selected tag per panel.
  - `cate.ui.notify` — surfaces agent results / errors.
- **Live refresh** — polls the task file (cheap, mtime-gated) so edits from the
  Task Master CLI or agent appear without reopening the panel.
- **Empty state** — a project with no `.taskmaster` shows setup instructions.

## Why it's server-backed

The cateHost reverse API has no file-read for arbitrary project files
(`editor.openFile` only opens a file in Cate's editor; `workspace.get` yields
only `rootPath`). To read `.taskmaster/tasks/tasks.json`, the extension ships a
tiny dependency-free Node server that Cate spawns with `WORKSPACE_ROOT` injected.
It serves both the built panel and a `GET /api/board` endpoint that reads and
parses the task file. See `STATUS.md` for the full rationale.

## Build

```bash
npm install
npm run build      # vite (panel) -> dist/public, tsc (server) -> dist/server.js + dist/shared
npm test           # vitest: parser/grouping/file-ref coverage
npm run typecheck
```

## Try it

1. `npm run build` here.
2. In Cate: Settings → Extensions → sideload this folder, then enable it.
3. Open a project that has run `task-master init` (so
   `.taskmaster/tasks/tasks.json` exists), and open the Task Master panel.
