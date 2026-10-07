import { app } from 'electron';
import { resolvePackagedVariant } from './cyboflowDirectory';

/**
 * Pure dev-build rule: an unpackaged run (`pnpm dev`) or the packaged
 * "Cyboflow Dev" variant. Every other packaged build is a release build.
 */
export function isDevBuildFor(isPackaged: boolean, packagedVariant: 'stable' | 'dev'): boolean {
  return !isPackaged || packagedVariant === 'dev';
}

let devBuildOverride: boolean | undefined;

/**
 * Whether this process is a dev build. FAILS CLOSED: when Electron's `app` is
 * unavailable (a plain-Node context) it answers false, and the packaged variant
 * read already floors a missing or corrupt buildInfo.json to 'stable'. Gates
 * for dev-only features (remote sync) must use this, never the renderer's
 * `version:get-info` variant, which is undefined on asar builds.
 */
export function isDevBuild(): boolean {
  if (devBuildOverride !== undefined) return devBuildOverride;
  let isPackaged: unknown;
  try {
    isPackaged = app?.isPackaged;
  } catch {
    return false;
  }
  if (typeof isPackaged !== 'boolean') return false;
  return isDevBuildFor(isPackaged, isPackaged ? resolvePackagedVariant() : 'stable');
}

/** Test-only: force `isDevBuild()`; `undefined` restores the real resolution. */
export function _setDevBuildForTesting(value: boolean | undefined): void {
  devBuildOverride = value;
}
