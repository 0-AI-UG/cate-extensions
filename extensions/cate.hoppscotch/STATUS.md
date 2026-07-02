# cate.hoppscotch — status

## License

Hoppscotch is MIT, but its web app is not distributed as a package — the
supported self-host channel is the docker AIO image, and building the monorepo
in this repo's CI is out of scope. So this is a **connect-to-existing**
extension (deepwiki/sourcebot model): the user runs the instance, the wrapper
proxies and augments it. The bundled request proxy re-implements the
Proxyscotch **protocol** (from reading hoppscotch/proxyscotch, MIT) in ~100
lines of dependency-free Node; no upstream code is vendored.

## Run model

- Wrapper binds Cate's `PORT` on `127.0.0.1`, answers `/health` immediately.
- Upstream resolution: stored (`cate.storage` key `hoppscotch:upstream`) →
  `HOPPSCOTCH_UPSTREAM` env → auto-detect (probe `localhost:3000`, then
  `docker ps` / `lsof` scan for a "hoppscotch" listener). Only manual/env
  values are sticky.
- Shell page at `/`, control routes under `/__hopp/*`, everything else
  reverse-proxied to the upstream (HTTP + WebSocket upgrades), with
  framing/CSP guards stripped.
- The panel reports its public base (`/ext/<routeToken>/`) with each status
  poll; proxied HTML/CSS/JS is rewritten against it (root-absolute
  `src/href/action`, `srcset`, `url(/…)`, and JS `"/assets/…"` literals), and
  a `history.replaceState(null,'','/')` shim is injected into HTML so
  vue-router boots on its home route despite the prefixed document URL.
- `/__hopp/proxy` speaks the Proxyscotch protocol: GET returns the
  `{ sessionFingerprint, isProtected }` greeting the app uses to validate a
  proxy URL; POST executes the described request (params merged into the
  query, basic auth, 5 redirects with POST→GET demotion on 301/302/303, 30s
  timeout, 64 MB response cap) and answers HTTP 200 with `success:true/false`
  bodies exactly as the client expects. Binary data is unpadded base64
  (Go `base64.RawStdEncoding` parity).

## Verified vs. assumed

- Verified: upstream/config normalization, the Proxyscotch request/response
  codec, and the URL rewriters are unit-tested; server + panel build and
  typecheck.
- Assumed (needs a live run against the docker AIO): that the rewrite set +
  history shim is sufficient for the current Hoppscotch build to boot in the
  iframe, and that in-app SPA navigation behaves under the shimmed URL.

## Known limits

- Backend login/sync from the embedded app is cross-origin to the instance's
  backend and subject to ITS CORS whitelist — expect guest mode unless the
  user whitelists the panel origin. REST via the Proxy interceptor is the
  fully-supported path.
- The service worker (PWA) does not function under the rewritten prefix; the
  app runs without it.
- Multipart bodies on the request proxy are not implemented (JSON bodies
  only); Hoppscotch sends multipart only for form-data requests, which fail
  with a clear proxy error rather than silently.
- The proxy URL embeds the session-specific panel origin; it changes across
  Cate restarts and must be re-copied.
