import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      // 开发态把 API 与 SSE 转发给运行时，避免 CORS 与相对路径问题。
      '/api': {
        target: process.env.OPENCOXSWAIN_API ?? 'http://127.0.0.1:47900',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
