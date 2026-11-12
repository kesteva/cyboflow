/**
 * remoteRuntimeBridge — the module-level seam through which agent managers (claudeCodeManager, codexSdkManager)
 * reach the RemoteRuntime without a constructor change: hostsComposition sets it at start() and clears it at stop()
 * (same facade pattern as orchestrator/hostsBridge.ts; index.ts is untouched).
 *
 * Caller contract (every manager spawn):
 *   1. `const rt = getRemoteRuntime()`; resolve the host with `rt.resolveHostId({hostId, sessionId, runId})`, or —
 *      when rt is null — with `resolveHostIdFromDb(db, …)` from remoteRuntime.ts (the db is all it needs).
 *   2. null host ⇒ the existing LOCAL path, byte-identical.
 *   3. remote host ⇒ `requireRemoteRuntime().prepare(hostId, {runId, spawnKey})`. A remote host with no runtime
 *      FAILS the spawn (RemoteRuntimeNotComposedError); it never falls back to This Mac.
 */
import type { HostIdLookup, PrepareOptions, RemoteRuntimeSession } from './remoteRuntime';

/** What managers use; RemoteRuntime satisfies it structurally. */
export interface RemoteRuntimeLike {
  /** null = This Mac. See resolveHostIdFromDb for the precedence. */
  resolveHostId(input: HostIdLookup): string | null;
  /** Gates + orch link + 0600 token file. Rejects with a readable error; never falls back to local. */
  prepare(hostId: string, opts: PrepareOptions): Promise<RemoteRuntimeSession>;
  /** Best-effort; never rejects. */
  removeRunToken(hostId: string, runId: string): Promise<void>;
}

/** A spawn resolved to a remote environment but remote runs are not wired in this process. */
export class RemoteRuntimeNotComposedError extends Error {
  constructor() {
    super('Remote environments are not available right now, so this run cannot start on its environment.');
    this.name = 'RemoteRuntimeNotComposedError';
  }
}

let runtime: RemoteRuntimeLike | null = null;

/** Composition root only (hostsComposition start/stop). null clears it. */
export function setRemoteRuntime(next: RemoteRuntimeLike | null): void {
  runtime = next;
}

/** The wired runtime, or null when Environments are not composed (or stopped). */
export function getRemoteRuntime(): RemoteRuntimeLike | null {
  return runtime;
}

/** @throws RemoteRuntimeNotComposedError when none is wired. */
export function requireRemoteRuntime(): RemoteRuntimeLike {
  if (runtime === null) throw new RemoteRuntimeNotComposedError();
  return runtime;
}
