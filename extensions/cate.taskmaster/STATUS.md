# STATUS — cate.taskmaster

## 1. License gate (done first)

**Task Master** (`eyaltoledano/claude-task-master`) is licensed **MIT WITH
Commons Clause** (confirmed from the upstream repo's LICENSE). The Commons Clause
adds one restriction on top of MIT: you may not **Sell** the software itself —
"Sell" meaning charging for a product/service whose value derives entirely or
substantially from Task Master's functionality.

**Why there is no problem here:**

- We do **not** bundle, redistribute, fork, or vendor any Task Master source
  code. This extension contains only original code.
- We read the **data files Task Master produces** (`.taskmaster/tasks/tasks.json`)
  — a JSON file in the user's own project. Reading a file format is not
  "Selling" the software, and the format is documented publicly.
- We optionally **invoke / reference the Task Master CLI** in the empty-state
  instructions (we tell the user to run `task-master init`); we never ship or
  wrap its binary.
- This extension is given away as part of Cate's open extension catalog; it is
  not a paid product deriving its value from Task Master.

So Commons Clause is not triggered. No attribution obligation beyond the usual
MIT courtesy, and we add none of Task Master's code, so there is nothing to
relicense. **No license problem.**

### OpenSpec (alternative data source) — evaluated, not chosen

OpenSpec is an alternative spec/task-tracking format (`*.md` specs + a tasks
list). It would be a viable second data source: also file-on-disk, also
readable by the same server pattern. It was **not** implemented as primary
because (a) the task brief names Task Master as primary, and (b) Task Master's
`tasks.json` is a single, well-typed JSON file that maps cleanly onto a kanban
board (explicit `status`, `dependencies`, `subtasks`), whereas OpenSpec's
markdown checklists need looser parsing. The parser in `src/shared/taskmaster.ts`
is isolated enough that an OpenSpec adapter could be added later as a second
`/api/board` source without touching the UI.

## 2. Data-source approach chosen, and why

**Approach: a minimal server-backed extension** (`manifest.server`), not
frontend-only.

The cateHost reverse API (verified by reading
`src/main/extensions/cateApiHandlers.ts`, `src/preload/cateHost.ts`, and
`src/shared/cate-host-api.d.ts`) has **no file-read for arbitrary project
files**:

- `cate.editor.openFile` is *forwarded* to the renderer and only opens a file in
  Cate's editor — it returns nothing readable.
- `cate.workspace.get` returns only `{ rootPath, branch, worktree }`.
- `cate.storage.*` is Cate-owned KV under `.cate/`, not the project tree.

A sandboxed frontend-only webview therefore cannot read
`.taskmaster/tasks/tasks.json`. The SDK's supported path for "read project files
under the workspace root" is a **server-backed extension**: Cate spawns one Node
process per extension per workspace with `WORKSPACE_ROOT`, `PORT`, `HOST`,
`CATE_TOKEN` injected (see `docs/extensions.md` Lifecycle, and the
`cate.kitchensink` reference server). Our server:

- reads `${WORKSPACE_ROOT}/.taskmaster/tasks/tasks.json` (falls back to the
  legacy `tasks/tasks.json`),
- parses it with the shared, isomorphic parser,
- serves the parsed board at `GET /api/board` and the built panel as static
  assets,
- binds `127.0.0.1` only and requires the proxy-injected `CATE_TOKEN` bearer on
  every route except `/health` (the security contract from `docs/extensions.md`).

This is the clean, SDK-supported path. A frontend-only build was rejected
because it physically cannot reach the file.

## 3. Implemented vs stubbed

**Implemented and verified working:**

- Isomorphic parser (`src/shared/taskmaster.ts`): both on-disk shapes (legacy
  flat + tagged multi-context), status normalization + aliases, kanban column
  grouping, file-reference extraction with `:line`. 17 vitest cases pass.
- Server (`src/server.ts`): token auth, `/health`, `/api/board`, static panel
  serving, path-traversal guard. **Verified end-to-end** by running the built
  server against a fixture workspace (correct board JSON with token; 401 without;
  empty-state `initialized:false` when no `.taskmaster`; 404 on traversal).
- React panel (`src/public/main.tsx`): kanban board, tag selector, detail
  drawer (description / dependencies / subtasks / details / test strategy /
  file links), empty state, error banner, mtime-gated polling.
- Cate glue: theme, `editor.openFile`, `agent.run` ("Send to agent"),
  `storage.panel` (selected tag), `ui.notify`. All are real calls against
  `window.cate`; they degrade gracefully (try/catch) when run outside Cate.
- Catalog build: `cate-extensions/build.sh` discovers the folder, builds it, and
  emits it into `dist/catalog/index.json` + a `.tgz` containing
  `manifest.json + dist/`. Verified.

**Stubbed / not done (and why):**

- **No writes back to Task Master.** The panel is read-only; it does not change
  task status or edit `tasks.json`. Status changes would mean either editing the
  JSON (risking clobbering concurrent CLI writes) or shelling out to
  `task-master set-status`, which needs the CLI present. Deferred deliberately;
  the board reflects whatever the CLI / agent writes.
- **Drag-and-drop between columns** is not implemented (would imply writes).
- **File-reference detection is heuristic** — Task Master has no formal "file"
  field, so refs are regex-extracted from a task's text (path-with-slash +
  known extension, optional `:line`). Good enough to be useful; it can miss
  unusual paths.
- **Live `cate.agent` calls** can't be exercised headlessly (they need the
  running app + user consent), so they are not covered by automated tests; the
  call sites are typed against the host API and guarded.

## 4. Build / run instructions

From this directory:

```bash
npm install
npm run build      # build:panel (vite -> dist/public) + build:server (tsc -> dist/server.js, dist/shared/)
npm test           # vitest run (17 tests)
npm run typecheck  # browser + server tsconfigs, no emit
```

Output: `dist/public/` (panel), `dist/server.js`, `dist/shared/taskmaster.js`.

> Note: `package.json` intentionally has **no** `"type": "module"`. The server
> is compiled to CommonJS (`require`/`exports`) and run via `node dist/server.js`;
> marking the package ESM breaks it at runtime. Vite is unaffected because its
> config is `vite.config.mjs` (explicitly ESM).

## 5. How to try it

1. `npm run build` here.
2. In Cate: **Settings → Extensions**, sideload this folder, enable it.
3. Open a project that has Task Master initialized, e.g.:
   ```bash
   task-master init
   task-master parse-prd .taskmaster/docs/prd.txt
   ```
   so `.taskmaster/tasks/tasks.json` exists.
4. Open the **Task Master** panel from the panel/command menu. The board loads;
   click a card for detail; click a file link to open it; "Send to agent" runs a
   turn (first use prompts for consent).

A project without `.taskmaster` shows the empty state with setup instructions.

## 6. Shared-file registration a human must apply

**None.** All changes are confined to
`cate-extensions/extensions/cate.taskmaster/`. The catalog build
(`cate-extensions/build.sh`) auto-discovers every folder under `extensions/`, so
no registry/index edit in Cate's `src/` or elsewhere is required. Confirmed: the
extension appears in `cate-extensions/dist/catalog/index.json` after `build.sh`
with no manual edits.

For local use, the user sideloads the folder via Settings → Extensions (a
runtime action, not a code change). For catalog distribution, opening a PR
against the `cate-extensions` repo is the only step.
