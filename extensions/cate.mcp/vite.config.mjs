import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The panel is served BY our extension server (manifest.server) at the route
// root /ext/<routeToken>/, with dist/public as the document root. A RELATIVE
// base ('./') makes every asset URL resolve under that route prefix, where the
// server maps them straight onto dist/public/<asset>.
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
