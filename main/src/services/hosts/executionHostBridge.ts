/**
 * executionHostBridge — the module-level seam through which services code that is composed BEFORE or apart from
 * hostsComposition (the programmatic runner's RunHostAccess) reaches HostRegistry.get without a constructor change.
 * hostsComposition sets it at start() and clears it at stop() (same pattern as remoteRuntimeBridge.ts).
 *
 * Unset ⇒ remote host access rejects (RemoteHostAccessUnavailableError); it never falls back to This Mac.
 */
import type { ExecutionHost } from '../../orchestrator/trpc/contracts/executionHost';

/** HostRegistry.get — @throws HostNotFoundError. */
export type ExecutionHostResolver = (hostId: string) => ExecutionHost;

let resolver: ExecutionHostResolver | null = null;

/** Composition root only (hostsComposition start/stop). null clears it. */
export function setExecutionHostResolver(next: ExecutionHostResolver | null): void {
  resolver = next;
}

/** The wired resolver, or null when Environments are not composed (or stopped). */
export function getExecutionHostResolver(): ExecutionHostResolver | null {
  return resolver;
}
