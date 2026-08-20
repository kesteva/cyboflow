/**
 * Resolve the OMP command principal for the local desktop session.
 *
 * v1: userId is hard-coded `'local'` (the auth-principal placeholder — see
 * `trpc/context.ts`). The `omp:supervise` capability is granted by EITHER:
 *
 * - **Aria mode** (Settings → Advanced Options), passed in as `ariaMode`. This
 *   is the ordinary path: an operator turning on remote-fleet supervision is
 *   exactly the person authorizing it, so the toggle IS the grant. A desktop
 *   feature should not need a shell incantation to switch on.
 * - **`CYBOFLOW_OMP_SUPERVISE`** truthy — an override for headless and CI hosts
 *   that have no Settings UI to click.
 *
 * Neither present ⇒ the principal carries no capabilities, every `ompCommand`
 * mutation is FORBIDDEN at the router, and no fleet session manager is built —
 * fail closed, never fail open. Reachability of the bridge is deliberately NOT
 * part of this: "the fleet can be reached" and "this operator authorized
 * driving it" are different questions.
 *
 * Standalone-typecheck invariant: no imports from electron, better-sqlite3, or
 * services/*. This module is pure — the caller reads config and passes the flag.
 */
import type { OmpPrincipal } from '../../../../shared/types/ompCommand';
import { OMP_SUPERVISE_CAPABILITY } from '../../../../shared/types/ompCommand';

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed !== '' && trimmed !== '0' && trimmed !== 'false' && trimmed !== 'off' && trimmed !== 'no';
}

export function resolveOmpPrincipal(ariaMode = false): OmpPrincipal {
  const supervise = ariaMode || isTruthy(process.env.CYBOFLOW_OMP_SUPERVISE);
  return {
    userId: 'local',
    capabilities: supervise ? new Set([OMP_SUPERVISE_CAPABILITY]) : new Set<string>(),
  };
}
