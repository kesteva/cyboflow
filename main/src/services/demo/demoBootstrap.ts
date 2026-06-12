/**
 * Demo-mode boot resolution — decides ONCE, synchronously, at first import,
 * which database the entire process uses.
 *
 * Why this exists: there are TWO DatabaseService constructions in the app —
 * the module-level singleton in services/database.ts (opened at import time,
 * used by PanelManager / panels IPC / session validation) and the instance
 * built in index.ts initializeServices(). Outside demo mode both point at the
 * same sessions.db so the split is invisible. In demo mode the path decision
 * (and the demo-environment reset) must therefore happen BEFORE the module
 * graph loads the singleton — resetting later would strand one handle on a
 * deleted file and split the world across two databases (FOREIGN KEY failures
 * on every session create, as seen in the first demo smoke).
 *
 * The demoMode flag is read straight from config.json (ConfigManager does not
 * exist yet at module-load time). Fail-soft: any error (unreadable config, git
 * missing, reset failure) records the message and boots on the real database.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCyboflowDirectory } from '../../utils/cyboflowDirectory';
import { resetDemoEnvironment } from './demoEnvironment';
import type { DemoEnvironment } from './demoEnvironment';

let resolved = false;
let demoEnv: DemoEnvironment | null = null;
let bootError: string | null = null;

function resolveOnce(): void {
  if (resolved) return;
  resolved = true;

  // Never trigger a demo reset from unit tests importing the module graph.
  if (process.env.VITEST) return;

  try {
    const configPath = path.join(getCyboflowDirectory(), 'config.json');
    if (!fs.existsSync(configPath)) return;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { demoMode?: unknown };
    if (config.demoMode !== true) return;
    demoEnv = resetDemoEnvironment();
  } catch (error) {
    demoEnv = null;
    bootError = error instanceof Error ? error.message : String(error);
  }
}

/** True when this boot is running against the demo environment. */
export function isDemoBootActive(): boolean {
  resolveOnce();
  return demoEnv !== null;
}

/**
 * The database path EVERY DatabaseService construction in this process must
 * use — the freshly-reset demo.db in demo mode, sessions.db otherwise.
 */
export function getBootDatabasePath(): string {
  resolveOnce();
  return demoEnv?.databasePath ?? path.join(getCyboflowDirectory(), 'sessions.db');
}

/** The demo environment for this boot, or null outside demo mode. */
export function getDemoBootEnvironment(): DemoEnvironment | null {
  resolveOnce();
  return demoEnv;
}

/** Error message when demo mode was configured but the environment build failed. */
export function getDemoBootError(): string | null {
  resolveOnce();
  return bootError;
}
