import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // ROM images are imported with ?url and served as files.
  assetsInclude: ['**/*.bin', '**/*.prg', '**/*.crt'],
  // The modem's relay runs in the Worker: `npx wrangler dev` serves it on 8787.
  server: { proxy: { '/relay': { target: 'ws://localhost:8787', ws: true } } },
  build: {
    target: 'es2020',
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
});
