// =============================================================================
// Root-absolute URL rewriting for the proxied Hoppscotch UI.
//
// Cate serves the panel under an opaque `/ext/<routeToken>/` prefix and strips
// it before forwarding to the wrapper, so a request for `/x` only reaches us if
// the browser asked for `/ext/<token>/x`. Hoppscotch's web build (Vite,
// base '/') emits ROOT-absolute references — `<script src="/assets/…">`,
// `import "/assets/…"`, `url(/fonts/…)` — which would resolve to the proxy
// root and 404. The panel reports its public base (`location.pathname`), and
// these rewriters prefix root-absolute references in the upstream's text
// responses so they resolve back through the panel's prefix.
//
// Best-effort by design (the same stance as sourcebot/deepwiki's embedded
// UIs): attribute URLs in HTML, string-literal /assets/ paths in JS, and
// url(/…) in CSS cover Vite's output; anything a SPA computes at runtime from
// `location` already lands under the prefix naturally.
// =============================================================================

/** Content types the proxy buffers + rewrites (everything else streams raw). */
export function isRewritableContentType(contentType: string | undefined): boolean {
  if (!contentType) return false
  const ct = contentType.toLowerCase()
  return (
    ct.includes('text/html') ||
    ct.includes('text/css') ||
    ct.includes('javascript') // text/javascript, application/javascript, +module variants
  )
}

/** Pick the rewriter for a content type (identity for anything unexpected). */
export function rewriteFor(contentType: string | undefined): (text: string, base: string) => string {
  const ct = (contentType || '').toLowerCase()
  if (ct.includes('text/html')) return rewriteHtml
  if (ct.includes('text/css')) return rewriteCss
  if (ct.includes('javascript')) return rewriteJs
  return (text) => text
}

/** Prefix root-absolute URL attributes (src/href/action/poster/content and
 *  srcset entries) with `base`. Protocol-relative `//host` URLs are left alone. */
export function rewriteHtml(html: string, base: string): string {
  let out = html.replace(
    /(\s(?:src|href|action|poster|content|data-src))=("|')\/(?!\/)/gi,
    (_m, attr: string, quote: string) => `${attr}=${quote}${base}`,
  )
  // srcset holds comma-separated "url descriptor" pairs.
  out = out.replace(/(\ssrcset=)("|')([^"']*)\2/gi, (_m, attr: string, quote: string, val: string) => {
    const rewritten = val.replace(/(^|,\s*)\/(?!\/)/g, (_mm, lead: string) => `${lead}${base}`)
    return `${attr}${quote}${rewritten}${quote}`
  })
  // Inline style url(/…).
  out = rewriteCss(out, base)
  return out
}

/** Prefix url(/…) references in CSS (quoted or bare). */
export function rewriteCss(css: string, base: string): string {
  return css.replace(/url\(\s*(['"]?)\/(?!\/)/gi, (_m, quote: string) => `url(${quote}${base}`)
}

/** Prefix root-absolute asset paths inside JS string literals. Vite bakes its
 *  base into built chunks as "/assets/…" strings (dep maps, dynamic imports,
 *  worker URLs); rewriting just those is enough for the app shell + lazy routes
 *  without risking arbitrary "/word" strings that aren't URLs. */
export function rewriteJs(js: string, base: string): string {
  return js.replace(/(["'`])\/assets\//g, (_m, quote: string) => `${quote}${base}assets/`)
}
