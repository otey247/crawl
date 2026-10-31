import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const api = process.env.VITE_API_PROXY ?? 'http://localhost:4000';

/** Dev parity with nginx: link-preview crawlers get the API's Open Graph pages. */
const BOT = /facebookexternalhit|facebot|twitterbot|slackbot|discordbot|whatsapp|telegrambot|linkedinbot|applebot|skypeuripreview|redditbot|embedly|pinterest|googlebot|bingbot/i;
const PREVIEW_PATH = /^\/(i\/[A-Za-z0-9_-]+|crawls\/[0-9a-fA-F-]{36})$/;
function linkPreviews(): Plugin {
  const handler = async (req: any, res: any, next: () => void) => {
    const path = (req.url ?? '').split('?')[0];
    if (!PREVIEW_PATH.test(path) || !BOT.test(req.headers['user-agent'] ?? '')) return next();
    try {
      const r = await fetch(`${api}/v1/og${path}`);
      res.statusCode = r.status;
      res.setHeader('content-type', r.headers.get('content-type') ?? 'text/html');
      res.end(await r.text());
    } catch {
      next();
    }
  };
  return {
    name: 'crawl-link-previews',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

export default defineConfig({
  plugins: [linkPreviews(), react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: { maplibre: ['maplibre-gl'], vendor: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query', 'socket.io-client', 'luxon'] },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/v1': { target: api, changeOrigin: true },
      '/socket.io': { target: api, ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/v1': { target: api, changeOrigin: true },
      '/socket.io': { target: api, ws: true, changeOrigin: true },
    },
  },
});
