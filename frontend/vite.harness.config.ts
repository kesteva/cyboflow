/**
 * Harness-only Vite config (untracked, smoke tooling): builds harness/index.html
 * into a self-contained static page from the REAL editor components, stubbing the
 * one preload-dependent module (src/trpc/client) so the page renders without
 * Electron. Consumed once by the verification-queue smoke; never part of the app
 * build.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'harness'),
  base: './',
  plugins: [
    {
      // Replace the preload-backed tRPC client with the harness fixture stub.
      name: 'harness-stub-trpc-client',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source.endsWith('trpc/client') && importer !== undefined) {
          return resolve(__dirname, 'harness/trpcStub.ts');
        }
        return null;
      },
    },
    react(),
  ],
  build: {
    outDir: resolve(__dirname, 'dist-harness'),
    emptyOutDir: true,
  },
});
