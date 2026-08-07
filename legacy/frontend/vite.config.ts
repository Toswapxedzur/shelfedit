import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Backend engine address during local development.
const BACKEND = process.env.SHELFEDIT_BACKEND ?? 'http://127.0.0.1:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative base so the built app works when served from the backend at "/".
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/health': { target: BACKEND, changeOrigin: true },
    },
  },
  build: {
    // Emit into the backend so FastAPI can serve the desktop UI directly.
    outDir: '../backend/app/webui',
    emptyOutDir: true,
  },
})
