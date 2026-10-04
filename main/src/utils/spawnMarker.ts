import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getCyboflowSubdirectory } from './cyboflowDirectory';

/**
 * Spawn marker chokepoint. Every child process cyboflow spawns is stamped with
 * the spawning app instance's id (CYBOFLOW_INSTANCE) and the worktree it is
 * scoped to (CYBOFLOW_WORKTREE), so a later scan can tell whose process it is
 * and whether that instance is still alive.
 *
 * The instance id is minted in-process and never read from
 * process.env.CYBOFLOW_INSTANCE: an inherited value belongs to a HOSTING
 * instance (index.ts strips it at boot for the same reason).
 *
 * The first getInstanceId() call also drops a liveness record at
 * `<cyboflow data dir>/instances/<instanceId>.json`, removed best-effort on
 * exit. A record whose pid is gone is an ignorable leftover from a crash.
 * Every filesystem step is fail-soft — a marker is never worth an exception.
 */
export const SPAWN_MARKER_INSTANCE_ENV = 'CYBOFLOW_INSTANCE';
export const SPAWN_MARKER_WORKTREE_ENV = 'CYBOFLOW_WORKTREE';

export interface InstanceRecord {
  instanceId: string;
  pid: number;
  startedAt: string;
}

let cachedInstanceId: string | undefined;

function recordPath(instanceId: string): string {
  return path.join(getCyboflowSubdirectory('instances'), `${instanceId}.json`);
}

function writeInstanceRecord(instanceId: string): void {
  try {
    const file = recordPath(instanceId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record: InstanceRecord = {
      instanceId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(record), 'utf8');
  } catch {
    // Unwritable data dir — the env stamp still works, only discoverability is lost.
  }
}

function removeInstanceRecord(instanceId: string): void {
  try {
    fs.rmSync(recordPath(instanceId), { force: true });
  } catch {
    // Best-effort: a stale record is ignorable (its pid no longer exists).
  }
}

/** This process's stable instance id, minted (and its liveness record written) on first use. */
export function getInstanceId(): string {
  if (cachedInstanceId) return cachedInstanceId;
  const instanceId = randomUUID();
  cachedInstanceId = instanceId;
  writeInstanceRecord(instanceId);
  process.once('exit', () => removeInstanceRecord(instanceId));
  return instanceId;
}

/** Returns a NEW env with the spawn marker set (last-write-wins); never mutates `env`. */
export function stampSpawnMarker(
  env: Record<string, string | undefined>,
  worktreePath: string,
): Record<string, string> {
  const stamped: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) stamped[key] = value;
  }
  stamped[SPAWN_MARKER_INSTANCE_ENV] = getInstanceId();
  stamped[SPAWN_MARKER_WORKTREE_ENV] = worktreePath;
  return stamped;
}

/** Test-only: drop the cached id so the next getInstanceId() mints afresh. */
export function _resetInstanceIdForTesting(): void {
  cachedInstanceId = undefined;
}
