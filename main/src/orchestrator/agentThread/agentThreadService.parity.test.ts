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
import type { CodexSdkManager } from '../../services/panels/codex/codexSdkManager';
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

// The SAME pair of witnesses for the Codex app-server manager, which now hosts
// the assistant whenever the resolved runtime is 'codex-sdk'. Its spawn options
// are typed on ClaudeSpawnerOptions rather than ClaudeSpawnOptions, so this is
// the guard that the two option shapes stay compatible where the service's
// AgentSpawnOptions Pick touches them — a drift there (an isolation/mcpScope/
// eventsSink/hidePromptFromTranscript field typed differently on the two sides)
// fails `tsc` here rather than at a live Codex assistant turn.
type CodexSdkManagerSatisfiesManagerLike =
  CodexSdkManager extends AgentSpawnManagerLike ? true : never;

const _codexParity: CodexSdkManagerSatisfiesManagerLike = true;

type _CodexAssignableWitness = (mgr: CodexSdkManager) => AgentSpawnManagerLike;
const _codexAssignable: _CodexAssignableWitness = (mgr) => mgr;

describe('AgentThreadService manager parity', () => {
  it('ClaudeCodeManager satisfies AgentSpawnManagerLike (compile-time)', () => {
    expect(_parity).toBe(true);
    expect(typeof _assignable).toBe('function');
  });

  it('CodexSdkManager satisfies AgentSpawnManagerLike (compile-time)', () => {
    expect(_codexParity).toBe(true);
    expect(typeof _codexAssignable).toBe('function');
  });
});
