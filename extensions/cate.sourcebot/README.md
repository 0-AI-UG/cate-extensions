Code search and understanding over a self-hosted Sourcebot instance, wired into Cate's editor.

# Sourcebot for Cate

Search your code with [Sourcebot](https://github.com/sourcebot-dev/sourcebot)
(a self-hosted, Zoekt-based code-search tool) from inside Cate. Search results
open directly in a Cate editor at the matching line.

This extension does **not** bundle Sourcebot — Sourcebot is
[Fair Source (FSL)](https://www.sourcebot.dev/blog/fair-source) and may not be
redistributed inside another product. You run your own Sourcebot instance and
point this panel at it.

## Setup

1. Run Sourcebot (single Docker container):
   ```
   docker run -d --name sourcebot -p 3000:3000 \
     -v $(pwd)/.sourcebot:/data \
     ghcr.io/sourcebot-dev/sourcebot:latest
   ```
   See the [Sourcebot docs](https://docs.sourcebot.dev) for the `config.json`
   that declares which repos to index.
2. Open the **Sourcebot** panel in Cate, click ⚙, and enter your instance URL
   (e.g. `http://localhost:3000`) plus an API key if your instance requires one.
3. Search. Use Sourcebot's syntax: `repo:`, `lang:`, `file:`, `sym:`, regex
   (`.*` toggle), case (`Aa` toggle). Click a hit to open the file in Cate.

**Browse** opens Sourcebot's full web UI in an embedded iframe (best-effort).

## How it works

A small server-backed extension reverse-proxies to your Sourcebot. It runs its
own native search UI against Sourcebot's `POST /api/search`, normalizes the
results, and calls `cate.editor.openFile(path, { line })` on click. The API key
is injected server-side and never exposed to the panel. The panel themes itself
from `cate.theme.get()`.

See [STATUS.md](./STATUS.md) for the license analysis, what's verified vs.
stubbed, the MCP-to-agent integration notes, and the run model.

## Develop

```bash
npm install && npm run build && npm test
```
