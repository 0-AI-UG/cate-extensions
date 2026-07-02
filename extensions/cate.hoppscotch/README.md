The Hoppscotch API client on the Cate canvas, connected to an instance you run, with a built-in request proxy.

# Hoppscotch for Cate

[Hoppscotch](https://hoppscotch.io) (MIT) is a Postman-style API client. This
extension embeds a **self-hosted Hoppscotch you run yourself** into a Cate
panel — the web app has no distributable package (its supported self-host
channel is the docker image), so nothing is bundled or re-implemented.

## Setup

1. Run Hoppscotch (single AIO container):
   ```
   docker run --rm -p 3000:3000 hoppscotch/hoppscotch
   ```
   An instance on `localhost:3000` (or any container/process named
   "hoppscotch") is auto-detected; otherwise the panel prompts for the URL.
   `HOPPSCOTCH_UPSTREAM` presets it.
2. Open the **Hoppscotch** panel. The app loads reverse-proxied through the
   extension server.
3. Inside Hoppscotch, set **Settings → Interceptor → Proxy** and paste the
   proxy URL shown in the bar above the app (one click to copy). Requests then
   execute through the extension server on loopback — no browser CORS limits,
   no `Access-Control-Allow-Origin` needed on your APIs.

## How it works

- The wrapper reverse-proxies the Hoppscotch UI same-origin into the panel's
  sandboxed webview, rewriting the SPA's root-absolute asset URLs against the
  panel's proxied prefix (Cate serves panels under an opaque `/ext/<token>/`
  path) and stripping upstream framing guards.
- It also implements the [Proxyscotch](https://github.com/hoppscotch/proxyscotch)
  wire protocol on `…/__hopp/proxy` — the same protocol Hoppscotch's hosted
  proxy speaks — so the app's Proxy interceptor can send requests through it:
  JSON in, `{ success, isBinary, status, statusText, headers, data }` out
  (base64 for binary), redirects followed server-side.
- The upstream URL you enter is persisted per-workspace via `cate.storage`;
  an auto-detected instance is ephemeral and re-checked on each connect.

## Notes

- Login/sync against the instance's own backend follows that instance's CORS
  whitelist; the embedded app is a different origin, so accounts/collections
  sync may be unavailable in the panel (guest mode + local collections work).
  Add the panel origin to your instance's whitelist to enable it.
- The request proxy accepts http(s) targets only, follows up to 5 redirects,
  and enforces a 30s timeout — matching Proxyscotch's behavior.
- The proxy URL embeds the panel's session-specific origin; if it stops
  working after a Cate restart, copy the fresh one from the bar.

## Develop

```bash
npm install && npm run build && npm test
```
