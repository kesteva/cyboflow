import { homedir } from 'os';
import { join } from 'path';
import * as fs from 'fs';
import { app } from 'electron';

let customCyboflowDir: string | undefined;

/**
 * Cached packaged-variant read. buildInfo.json is baked at build time and never
 * changes at runtime, so the (up to two-candidate) filesystem probe runs at most
 * once per process even though getCyboflowDirectory() is called very often.
 */
let cachedPackagedVariant: 'stable' | 'dev' | undefined;

/**
 * Sets a custom Cyboflow directory path. This should be called early in the
 * application lifecycle, before any services are initialized.
 */
export function setCyboflowDirectory(dir: string): void {
  customCyboflowDir = dir;
}

/**
 * Read the baked build variant ('dev' | 'stable') from the packaged
 * buildInfo.json. Mirrors telemetry/index.ts:readBuildInfo — with asar enabled
 * (the electron-builder default) buildInfo.json lives INSIDE app.asar, so the
 * asar member path is probed first, then the loose `app/` fallback (asar off).
 *
 * Any missing / corrupt / unstamped artifact — including a unit-test environment
 * where `process.resourcesPath` is undefined — resolves to 'stable', the safe
 * default: a build that cannot prove it is the Dev distributable falls back to
 * the production `~/.cyboflow` directory it historically shared. Only meaningful
 * for packaged builds; the sole caller gates on `app.isPackaged` first.
 */
function resolvePackagedVariant(): 'stable' | 'dev' {
  if (cachedPackagedVariant) return cachedPackagedVariant;

  const resourcesPath = process.resourcesPath;
  if (!resourcesPath) {
    cachedPackagedVariant = 'stable';
    return cachedPackagedVariant;
  }

  const candidates = [
    join(resourcesPath, 'app.asar', 'main', 'dist', 'buildInfo.json'),
    join(resourcesPath, 'app', 'main', 'dist', 'buildInfo.json'),
  ];
  let variant: 'stable' | 'dev' = 'stable';
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { variant?: unknown };
        variant = parsed.variant === 'dev' ? 'dev' : 'stable';
        break;
      }
    } catch {
      // Corrupt/unreadable candidate — fall through to the next, then 'stable'.
    }
  }
  cachedPackagedVariant = variant;
  return variant;
}

/**
 * Gets the Cyboflow directory path.
 *
 * Resolution order:
 *  1. Programmatic override (`setCyboflowDirectory`).
 *  2. `CYBOFLOW_DIR` environment variable.
 *  3. Packaged builds — one data dir PER KIND so a user can run the stable
 *     release and the "Cyboflow Dev" distributable DMG side by side without them
 *     sharing a sessions.db / orch.sock (the two-instance orch-socket clobber):
 *       - stable variant → `~/.cyboflow`
 *       - dev    variant → `~/.cyboflow_dev_dmg`
 *  4. Electron development server (`pnpm dev`, app NOT packaged) — gets its own
 *     isolated database at `~/.cyboflow_dev` so local development never mutates
 *     (or forward-migrates) either packaged app's DB.
 *
 * Together these give three parallel-safe kinds (Stable / pnpm-dev / Dev DMG),
 * each locked to a single running instance by the data-dir single-instance lock.
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

  // 3. Packaged builds — per-kind isolation by baked variant.
  if (app.isPackaged) {
    return resolvePackagedVariant() === 'dev'
      ? join(homedir(), '.cyboflow_dev_dmg')
      : join(homedir(), '.cyboflow');
  }

  // 4. Electron development server — isolated DB so dev work never touches a
  //    packaged app's data.
  console.log('[Cyboflow] Running development server, using ~/.cyboflow_dev for isolation');
  return join(homedir(), '.cyboflow_dev');
}

/**
 * Gets a subdirectory path within the Cyboflow directory
 */
export function getCyboflowSubdirectory(...subPaths: string[]): string {
  return join(getCyboflowDirectory(), ...subPaths);
}
