/**
 * remoteCheckoutBridge — the module-level seam through which session creation (services/taskQueue.ts) and its
 * half-created compensation (services/createQuickSessionCore.ts) reach the RemoteCheckout service without a
 * constructor change: hostsComposition sets it at start() and clears it at stop() (same pattern as
 * remoteRuntimeBridge.ts).
 *
 * A remote session with no checkout service FAILS (RemoteCheckoutNotComposedError); it never falls back to a local
 * worktree.
 */
import type { RemoteCheckoutLike } from './remoteCheckout';

export class RemoteCheckoutNotComposedError extends Error {
  constructor() {
    super('Remote environments are not available right now, so this session cannot be created on its environment.');
    this.name = 'RemoteCheckoutNotComposedError';
  }
}

let checkout: RemoteCheckoutLike | null = null;

/** Composition root only (hostsComposition start/stop). null clears it. */
export function setRemoteCheckout(next: RemoteCheckoutLike | null): void {
  checkout = next;
}

/** The wired service, or null when Environments are not composed (or stopped). */
export function getRemoteCheckout(): RemoteCheckoutLike | null {
  return checkout;
}

/** @throws RemoteCheckoutNotComposedError when none is wired. */
export function requireRemoteCheckout(): RemoteCheckoutLike {
  if (checkout === null) throw new RemoteCheckoutNotComposedError();
  return checkout;
}
