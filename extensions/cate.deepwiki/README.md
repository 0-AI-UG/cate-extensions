# DeepWiki (cate.deepwiki)

A server-backed Cate extension that brings [DeepWiki-Open][dw] — the open-source
AI codebase-wiki + diagram generator — onto the Cate canvas, and wires its code
references back into Cate's editor.

DeepWiki-Open itself is **not bundled** (see [STATUS.md](./STATUS.md) for why).
It is a Python/FastAPI backend + Next.js frontend that needs your own LLM and
embeddings keys. You run a DeepWiki instance; this extension is a thin,
dependency-free Node reverse-proxy + control panel that embeds it and adds
Cate-native glue.

[dw]: https://github.com/AsyncFuncAI/deepwiki-open

## What it does

- **Embeds DeepWiki** — its full web UI renders inside a Cate panel (reverse-
  proxied through this extension's loopback server, so it's same-origin and the
  proxy strips `X-Frame-Options` / upstream CSP so it frames cleanly).
- **Code references → editor** — clicks on source citations in the wiki
  (`src/foo.ts#L42`, `path:line`, `?line=`) are intercepted and routed to
  `cate.editor.openFile(path, { line })` instead of navigating. A
  `postMessage({ type: 'cate-open-file', path, line })` channel is also honored.
- **Theme-matched chrome** — the control bar adopts Cate's theme via
  `cate.theme.get()`.
- **Provider reuse** — reads Cate's configured AI provider from
  `<workspace>/.cate/pi-agent/auth.json` (+ `models.json`) and shows a
  ready-to-paste DeepWiki `.env` (`OPENAI_API_KEY` / `GOOGLE_API_KEY` /
  `OPENROUTER_API_KEY` / `OPENAI_BASE_URL`). Keys are echoed only to the local,
  token-gated panel for you to copy — nothing is written.

## Run a DeepWiki instance

```bash
git clone https://github.com/AsyncFuncAI/deepwiki-open
cd deepwiki-open
cp .env.example .env        # add OPENAI_API_KEY (and/or GOOGLE_API_KEY, …)
docker compose up           # frontend :3000, API :8001
```

Then in the panel's **setup** view, enter `http://localhost:3000` and hit
**connect**. The URL is saved via `cate.storage` (shared with any other DeepWiki
panel, survives restart). You can also preset it with the `DEEPWIKI_UPSTREAM`
env var.

## Build / test

```bash
npm install     # dev toolchain only (typescript + vitest)
npm run build   # src/ -> dist/ (server + panel)
npm test        # vitest: src/auth.ts + src/config.ts helpers
npm run typecheck
```

Dependency-free at runtime (Node `http` only); the shipped `.tgz` carries only
`manifest.json` + compiled `dist/`.

## Layout

```
cate.deepwiki/
  manifest.json          # server: node dist/server.js
  src/
    server.ts            # reverse-proxy + control routes -> dist/server.js
    auth.ts              # Cate provider -> DeepWiki env (pure, tested)
    config.ts            # upstream URL + code-ref parsing (pure, tested)
    auth.test.ts
    config.test.ts
    public/
      index.html         # control panel + embedded-wiki iframe
      app.ts             # theme, status, code-ref glue -> dist/public/app.js
      style.css
      cate-host.d.ts
  dist/                  # build output (shipped)
```
