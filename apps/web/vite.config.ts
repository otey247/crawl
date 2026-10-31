import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.VITE_API_PROXY ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
