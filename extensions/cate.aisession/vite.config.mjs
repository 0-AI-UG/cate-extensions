import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served by Cate's extension proxy at /ext/<token>/ but shipped under the
// extension's dist/ subdir. RELATIVE base so chunk/asset URLs resolve via
// import.meta.url against each file's real location, independent of the opaque
// proxy token; scripts/postbuild.mjs fixes the two entry refs in index.html
// (./ -> dist/). Mirrors cate.excalidraw.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
