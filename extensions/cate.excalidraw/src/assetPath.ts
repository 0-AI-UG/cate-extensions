// Point Excalidraw at the woff2 fonts vendored alongside this bundle, BEFORE the
// @excalidraw/excalidraw module is evaluated. main.tsx imports this module first;
// ESM evaluates side-effect imports in source order, so this runs before
// Excalidraw captures its font host (whose default is the esm.sh CDN that Cate's
// extension CSP blocks).
//
// The value must be ABSOLUTE: Excalidraw's normalizeBaseUrl() resolves a
// relative path against window.location.origin, which would drop the
// /ext/<token>/ route prefix. We anchor on window.location.href (the served
// panel document, …/ext/<token>/) and append dist/, where postbuild.mjs put the
// fonts: …/ext/<token>/dist/fonts/<family>/…
;(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
  new URL('dist/', window.location.href).href
