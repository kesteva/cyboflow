/**
 * Compile-level parity assertion (S0.6): the concrete {@link ClaudeCodeManager}
 * must structurally satisfy the narrow {@link AgentSpawnManagerLike} slice the
 * AgentThreadService depends on. This is the type-drift guard for the
 * hand-narrowed manager interface — if a future change to ClaudeCodeManager's
 * `spawnCliProcess` / `on` / `off` signatures diverges from what the service
 * passes, THIS FILE fails `tsc`, not a runtime spawn.
 *
 * The assertion is purely type-level: it uses `import type` only, so nothing from
 * the electron-backed manager is loaded at runtime (a unit test cannot construct
 * ClaudeCodeManager — it needs the full Electron service graph). The lone runtime
 * `expect` exists only so vitest sees a test; the real check is that this module
 * type-checks at all.
 */
import { describe, it, expect } from 'vitest';
import type { ClaudeCodeManager } from '../../services/panels/claude/claudeCodeManager';
import type { AgentSpawnManagerLike } from './agentThreadService';

// If ClaudeCodeManager stops satisfying the narrow manager slice, this alias
// resolves to `never` and the const assignment below fails to compile.
type ClaudeCodeManagerSatisfiesManagerLike =
  ClaudeCodeManager extends AgentSpawnManagerLike ? true : never;

const _parity: ClaudeCodeManagerSatisfiesManagerLike = true;

// A second, assignment-shaped witness: a value typed as ClaudeCodeManager must be
// assignable to the narrow interface (exercises method-parameter compatibility).
type _AssignableWitness = (mgr: ClaudeCodeManager) => AgentSpawnManagerLike;
const _assignable: _AssignableWitness = (mgr) => mgr;

describe('AgentThreadService manager parity', () => {
  it('ClaudeCodeManager satisfies AgentSpawnManagerLike (compile-time)', () => {
    expect(_parity).toBe(true);
    expect(typeof _assignable).toBe('function');
  });
});
