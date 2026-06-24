import { homedir } from 'os';
import { join } from 'path';
import { app } from 'electron';

let customCyboflowDir: string | undefined;

/**
 * Sets a custom Cyboflow directory path. This should be called early in the
 * application lifecycle, before any services are initialized.
 */
export function setCyboflowDirectory(dir: string): void {
  customCyboflowDir = dir;
}

/**
 * Gets the Cyboflow directory path.
 *
 * Resolution order:
 *  1. Programmatic override (`setCyboflowDirectory`).
 *  2. `CYBOFLOW_DIR` environment variable.
 *  3. Packaged builds — BOTH the stable and the dev DMG variants read the local
 *     production database at `~/.cyboflow`. The dev variant is purely a separate
 *     distribution/update channel; it intentionally shares the installed data so
 *     the two apps stay in lockstep on one machine.
 *  4. Electron development server (`pnpm dev`, app NOT packaged) — gets its own
 *     isolated database at `~/.cyboflow_dev` so local development never mutates
 *     (or forward-migrates) the production DB used by the installed apps.
 */
export function getCyboflowDirectory(): string {
  // 1. Programmatic override.
  if (customCyboflowDir) {
    return customCyboflowDir;
  }

  // 2. Environment variable.
  const envDir = process.env.CYBOFLOW_DIR;
  if (envDir) {
    return envDir;
  }

  // 3. Packaged builds (stable + dev DMGs) share the production database.
  if (app.isPackaged) {
    return join(homedir(), '.cyboflow');
  }

  // 4. Electron development server — isolated DB so dev work never touches prod.
  console.log('[Cyboflow] Running development server, using ~/.cyboflow_dev for isolation');
  return join(homedir(), '.cyboflow_dev');
}

/**
 * Gets a subdirectory path within the Cyboflow directory
 */
export function getCyboflowSubdirectory(...subPaths: string[]): string {
  return join(getCyboflowDirectory(), ...subPaths);
}
