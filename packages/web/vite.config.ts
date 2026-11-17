import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { target: 'es2022' },
  server: {
    // 开发时前端在 5173、服务端在 3000：/api 走代理，登录 cookie 就落在同一 host 上，
    // 不必为跨端口再折腾 CORS 与 SameSite（WebSocket 仍直连 3000，见 App.tsx endpoint()）。
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
});
