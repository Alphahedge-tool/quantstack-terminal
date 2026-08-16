import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * The backend is a plain node:http server on 3101 (backend/server.ts). It sets
 * permissive CORS, so direct cross-origin calls would work — but proxying keeps
 * the browser on one origin, which means cookies and the `/ws/live/*` upgrades
 * behave the same in dev as they do behind a reverse proxy in production.
 */
const BACKEND = process.env.QT_BACKEND_URL || 'http://localhost:3101';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Charting and table pages pull the whole vendor graph on first paint
        // otherwise; splitting keeps the shell's initial chunk small.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          // The canvas charting engine is ~180kB and exactly one route needs
          // it. Left in the main chunk it is downloaded and parsed before the
          // order book paints for someone who never opens the straddle page.
          charts: ['lightweight-charts'],
        },
      },
    },
  },
});
