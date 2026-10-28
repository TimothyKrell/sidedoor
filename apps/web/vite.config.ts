import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Dev is single-origin (like T3 Code): Vite serves the app and proxies the server's paths, so the
// session cookie and relative URLs work the same in dev and prod. Never bake an API origin in.
const server = process.env.SIDEDOOR_DEV_SERVER ?? 'http://127.0.0.1:4848'
const proxied = ['/api', '/mcp', '/files', '/health']

export default defineConfig({
  resolve: { alias: { '~': resolve(import.meta.dirname, 'src') } },
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), tailwindcss(), react()],
  server: {
    port: Number(process.env.SIDEDOOR_WEB_PORT ?? 5848),
    strictPort: true,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: server, changeOrigin: false }])),
  },
  build: { outDir: 'dist', sourcemap: true },
})
