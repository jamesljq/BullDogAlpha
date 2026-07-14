import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const bffTarget = process.env.VITE_BFF_TARGET || 'http://localhost:8080';
const bffWsTarget = bffTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/ws': {
        target: bffWsTarget,
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: bffTarget,
        changeOrigin: true,
      },
    },
  },
});
