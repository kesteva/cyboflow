/**
 * mergeBackBridge — the module-level seam through which the session git ops (ipc/gitOps.ts) and boot recovery
 * (bootRecovery.ts) reach the MergeBackService without a constructor change: hostsComposition sets it at start() and
 * clears it at stop() (same pattern as remoteCheckoutBridge.ts).
 *
 * A remote session with no service FAILS (MergeBackNotComposedError); it never falls back to the remote path as if
 * it were local.
 */
import type { MergeBackServiceLike } from './mergeBackService';

export class MergeBackNotComposedError extends Error {
  constructor() {
    super('Remote environments are not available right now, so this session\'s work cannot be brought back to This Mac yet.');
    this.name = 'MergeBackNotComposedError';
  }
}

let service: MergeBackServiceLike | null = null;

/** Composition root only (hostsComposition start/stop). null clears it. */
export function setMergeBackService(next: MergeBackServiceLike | null): void {
  service = next;
}

/** The wired service, or null when Environments are not composed (or stopped). */
export function getMergeBackService(): MergeBackServiceLike | null {
  return service;
}

/** @throws MergeBackNotComposedError when none is wired. */
export function requireMergeBackService(): MergeBackServiceLike {
  if (service === null) throw new MergeBackNotComposedError();
  return service;
}
