import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // Fonts always ship as files: the CSP's default-src 'self' would block a font inlined as a data: URL.
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined) },
  server: {
    port: 5183,
    fs: { allow: ['..'] },
    // Host stays localhost:5183, which the server's host guard accepts.
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.INPROGRESS_PORT ?? '4318'}` } },
  },
});
