import { defineConfig } from 'vite'

// The panel is served by Cate's extension proxy at /ext/<token>/, but this
// build ships under the extension's dist/ subdir. A RELATIVE base makes every
// runtime URL (mermaid's lazy diagram chunks, the stylesheet) resolve via
// `import.meta.url` against each file's real location under dist/, independent
// of the opaque proxy token. The only refs that need fixing are the entry
// references in dist/index.html (./ -> dist/), handled by scripts/postbuild.mjs.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // One stylesheet so the post-build HTML rewrite has a single, predictable link.
    cssCodeSplit: false,
    // Mermaid's core is a couple of MB; diagram grammars lazy-load as local chunks.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
