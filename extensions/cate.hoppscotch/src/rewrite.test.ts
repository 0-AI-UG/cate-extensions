import { describe, it, expect } from 'vitest'
import { rewriteHtml, rewriteCss, rewriteJs, rewriteFor, isRewritableContentType } from './rewrite'

const BASE = '/ext/tok123/'

describe('rewriteHtml', () => {
  it('prefixes root-absolute src/href/action attributes', () => {
    const html = '<script src="/assets/index-abc.js"></script><link href="/index.css" rel="stylesheet">'
    expect(rewriteHtml(html, BASE)).toBe(
      `<script src="${BASE}assets/index-abc.js"></script><link href="${BASE}index.css" rel="stylesheet">`,
    )
  })

  it('leaves relative, absolute-URL and protocol-relative references alone', () => {
    const html =
      '<img src="logo.png"><a href="https://ex.com/x">x</a><script src="//cdn.ex.com/l.js"></script>'
    expect(rewriteHtml(html, BASE)).toBe(html)
  })

  it('rewrites srcset entries and inline url(/…)', () => {
    expect(rewriteHtml('<img srcset="/a.png 1x, /b.png 2x">', BASE)).toBe(
      `<img srcset="${BASE}a.png 1x, ${BASE}b.png 2x">`,
    )
    expect(rewriteHtml('<div style="background:url(/bg.svg)"></div>', BASE)).toBe(
      `<div style="background:url(${BASE}bg.svg)"></div>`,
    )
  })
})

describe('rewriteCss', () => {
  it('prefixes url(/…) in all quote styles', () => {
    expect(rewriteCss('a{background:url(/x.png)}', BASE)).toBe(`a{background:url(${BASE}x.png)}`)
    expect(rewriteCss("a{background:url('/x.png')}", BASE)).toBe(`a{background:url('${BASE}x.png')}`)
    expect(rewriteCss('a{background:url("/x.png")}', BASE)).toBe(`a{background:url("${BASE}x.png")}`)
  })

  it('leaves data: and relative urls alone', () => {
    const css = 'a{background:url(data:image/png;base64,xx)}b{background:url(img/y.png)}'
    expect(rewriteCss(css, BASE)).toBe(css)
  })
})

describe('rewriteJs', () => {
  it('prefixes /assets/ string literals in every quote style', () => {
    expect(rewriteJs('import("/assets/chunk.js")', BASE)).toBe(`import("${BASE}assets/chunk.js")`)
    expect(rewriteJs("x='/assets/a.css'", BASE)).toBe(`x='${BASE}assets/a.css'`)
    expect(rewriteJs('u=`/assets/${n}.js`', BASE)).toBe(`u=\`${BASE}assets/\${n}.js\``)
  })

  it('does not touch non-asset absolute strings', () => {
    const js = 'fetch("/api/v1/user"); const p = "/settings"'
    expect(rewriteJs(js, BASE)).toBe(js)
  })
})

describe('content-type routing', () => {
  it('flags html/css/js as rewritable', () => {
    expect(isRewritableContentType('text/html; charset=utf-8')).toBe(true)
    expect(isRewritableContentType('text/css')).toBe(true)
    expect(isRewritableContentType('application/javascript')).toBe(true)
    expect(isRewritableContentType('text/javascript; charset=utf-8')).toBe(true)
    expect(isRewritableContentType('image/png')).toBe(false)
    expect(isRewritableContentType(undefined)).toBe(false)
  })

  it('routes to the matching rewriter', () => {
    expect(rewriteFor('text/html')('<a href="/x">', BASE)).toBe(`<a href="${BASE}x">`)
    expect(rewriteFor('text/css')('url(/x)', BASE)).toBe(`url(${BASE}x)`)
    expect(rewriteFor('application/javascript')('"/assets/x"', BASE)).toBe(`"${BASE}assets/x"`)
    expect(rewriteFor('application/json')('{"a":"/x"}', BASE)).toBe('{"a":"/x"}')
  })
})
