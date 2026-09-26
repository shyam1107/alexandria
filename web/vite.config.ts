import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Same-origin API: no CORS config needed on the Nest side, and the
      // browser never sees the API origin in dev.
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});