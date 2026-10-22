import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    // `npm run dev:web` talks to a `mitzi ui --no-open` server.
    proxy: { '/api': 'http://localhost:4545' },
  },
});
