import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backend = env.DEV_API_TARGET ?? 'http://127.0.0.1:3000';
  const proxy = { target: backend, changeOrigin: true };

  return {
    plugins: [react()],
    server: {
      // Reachable from a phone on the same wifi, which is the only way to test
      // the mobile path before deploying.
      host: true,
      // In development the API is same-origin through this proxy, so CORS
      // never enters the picture locally.
      proxy: { '/api': proxy, '/health': proxy },
    },
    build: { outDir: 'dist', sourcemap: true },
  };
});
