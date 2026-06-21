import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The panel is served by Cate's extension proxy at /ext/<token>/, but this build
// is shipped under the extension's dist/ subdir. We use a RELATIVE base so every
// runtime URL (chunks, the font-subset worker, bundled UI fonts) resolves via
// `import.meta.url` against each file's real location under dist/ — independent
// of the opaque proxy token. The only refs that need fixing are the two entry
// references in dist/index.html (./ -> dist/), handled by scripts/postbuild.mjs.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // One stylesheet so the post-build HTML rewrite has a single, predictable link.
    cssCodeSplit: false,
    // Excalidraw fetches its woff2 fonts at runtime from EXCALIDRAW_ASSET_PATH; no
    // need to inline anything, and inlining would break that contract.
    assetsInlineLimit: 0,
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
