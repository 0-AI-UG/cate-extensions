import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The panel is served BY our extension server (manifest.server) at the route
// root /ext/<routeToken>/, with dist/public as the document root. So a RELATIVE
// base ('./') makes every asset URL (./app.js, ./chunks/...) resolve under the
// route prefix, where the server maps them straight onto dist/public/<asset>.
// No postbuild HTML rewrite is needed because the served HTML and its assets sit
// in the same dist/public dir that is the server's static root.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
