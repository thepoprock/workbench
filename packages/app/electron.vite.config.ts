import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@workbench/shared'] })],
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@workbench/shared'] })],
    build: {
      // Sandboxed preloads must be CommonJS.
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
      // Scripts loaded by URL (the voice AudioWorklet) must be real files: the
      // page's CSP (script-src 'self') refuses data: URLs.
      assetsInlineLimit: (file: string) => (file.endsWith('.js') ? false : undefined),
    },
  },
});
