import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Serves the same `__config.json` a real deploy writes into the asset prefix
// (D11): the bundle learns its environment at runtime, never at build time, so
// local dev has to hand it one too. Shared between `configureServer` (vite dev)
// and `configurePreviewServer` (vite preview) so both loops match a real deploy.
function localConfigJson(): Plugin {
  const serve = (req: import('http').IncomingMessage, res: import('http').ServerResponse, next: () => void): void => {
    if (req.url !== '/__config.json') {
      next()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify({ site: 'localhost', mode: 'local' }))
  }

  return {
    name: 'local-config-json',
    configureServer(server) {
      server.middlewares.use(serve)
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve)
    },
  }
}

export default defineConfig({
  plugins: [react(), localConfigJson()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Mirrors CloudFront's two behaviors in prod/previews. Vite matches
      // these keys by prefix in insertion order, which is why order is worth
      // calling out even though these two prefixes don't collide. `/events`
      // is a separate server from `/api` for the same reason it is a
      // separate Lambda there: response streaming is fixed at function-URL
      // creation, so one process cannot serve both a buffered and a
      // streaming origin.
      '/events': { target: 'http://localhost:3002', changeOrigin: true },
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
})
