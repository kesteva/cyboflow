import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    server: {
        port: 4521,
        strictPort: true
    },
    base: './',
    build: {
        // Ensure assets are copied and paths are relative
        assetsDir: 'assets',
        // Copy public files to dist
        copyPublicDir: true
    },
    // NOTE: test config lives in vitest.config.ts (which vitest prefers over this
    // file). Keeping a `test` block here breaks `tsc -b` in build:frontend because
    // vite@6's UserConfig has no `test` key and the vitest@2 augmentation targets a
    // duplicate vite@5 install — see vitest.config.ts for the canonical settings.
});
