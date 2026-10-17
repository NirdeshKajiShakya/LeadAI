import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Override when another process already owns :4000 (e.g. VITE_API_PROXY_TARGET=http://localhost:4101).
    proxy: { '/api': process.env.VITE_API_PROXY_TARGET || 'http://localhost:4000' }
  }
});
