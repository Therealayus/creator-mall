import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The app is served by the API in production (static files + SPA fallback), and
 * proxied to it in development, so the browser only ever talks to one origin.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
