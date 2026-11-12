import { describe, it, expect } from 'vitest';
import { gateStepAgentPin, providerModelAfterRuntimeDrop, remoteRuntimeForPin, resolveStepSpawnTarget } from '../orchestrator/stepSpawnTarget';
import type { AgentProvider, WorkflowAgentRuntime } from '../../../shared/types/agentRuntime';

describe('remoteRuntimeForPin', () => {
  it('keeps SDK runtimes', () => {
    expect(remoteRuntimeForPin('claude-sdk')).toBe('claude-sdk');
    expect(remoteRuntimeForPin('codex-sdk')).toBe('codex-sdk');
  });
  it("moves a local-only runtime to its own provider's SDK runtime", () => {
    expect(remoteRuntimeForPin('claude-interactive')).toBe('claude-sdk');
  });
  it('has no runtime for a provider that cannot run on a remote environment', () => {
    expect(remoteRuntimeForPin('pi-sdk')).toBeUndefined();
    expect(remoteRuntimeForPin('omp-sdk')).toBeUndefined();
  });
});

/** The gates `resolveStepAgent` applies, then the spawn seam's reduction: what the step actually spawns on. */
function spawnTargetFor(
  pin: { runtime?: WorkflowAgentRuntime; model?: string; providerModel?: string },
  run: { provider: AgentProvider; model: string | null; remote: boolean; disabled?: AgentProvider[]; unavailable?: WorkflowAgentRuntime[] },
) {
  const gated = gateStepAgentPin(pin, {
    isProviderEnabled: (p) => !(run.disabled ?? []).includes(p),
    runIsRemote: run.remote,
    runProvider: run.provider,
    remoteRuntimeUnavailable: (r) => (run.unavailable ?? []).includes(r),
  });
  const target = resolveStepSpawnTarget(
    { runtime: gated.runtime, model: pin.model, providerModel: gated.providerModel },
    run.provider,
    run.model,
  );
  return { changed: gated.changed, ...target };
}

describe('gateStepAgentPin → resolveStepSpawnTarget', () => {
  it.each(['omp-sdk', 'pi-sdk'] as const)(
    'a dropped %s pin never hands its model id to a remote Codex run',
    (runtime) => {
      expect(spawnTargetFor({ runtime, providerModel: 'other-provider/model-x' }, { provider: 'codex', model: 'gpt-run', remote: true }))
        .toEqual({ changed: 'remote', provider: 'codex', model: 'gpt-run', source: 'run' });
    },
  );

  it('a dropped pin keeps its provider model only when the step falls back onto the same provider', () => {
    expect(providerModelAfterRuntimeDrop('codex-sdk', 'codex', 'gpt-pinned')).toBe('gpt-pinned');
    expect(providerModelAfterRuntimeDrop('omp-sdk', 'codex', 'other-provider/model-x')).toBeUndefined();
    expect(providerModelAfterRuntimeDrop('codex-sdk', 'codex', null)).toBeUndefined();
  });

  it('a dropped pin on a remote Claude run keeps the Claude model pin and ignores the provider model', () => {
    expect(spawnTargetFor({ runtime: 'omp-sdk', model: 'claude-opus-5-5', providerModel: 'other-provider/model-x' }, { provider: 'claude', model: 'sonnet', remote: true }))
      .toEqual({ changed: 'remote', provider: 'claude', model: 'claude-opus-5-5', source: 'pin' });
  });

  it('a Claude CLI pin on a remote run moves to the Claude SDK and keeps its Claude model', () => {
    expect(spawnTargetFor({ runtime: 'claude-interactive', model: 'opus', providerModel: 'leftover' }, { provider: 'codex', model: 'gpt-run', remote: true }))
      .toEqual({ changed: 'remote', provider: 'claude', model: 'opus', source: 'pin' });
    expect(spawnTargetFor({ runtime: 'claude-interactive' }, { provider: 'claude', model: 'sonnet', remote: true }))
      .toEqual({ changed: 'remote', provider: 'claude', model: 'sonnet', source: 'run' });
    expect(gateStepAgentPin({ runtime: 'claude-interactive' }, { isProviderEnabled: () => true, runIsRemote: true, runProvider: 'codex' }).runtime)
      .toBe('claude-sdk');
  });

  it('a Claude CLI pin falls back to the run runtime when the environment is known not to have Claude', () => {
    expect(spawnTargetFor({ runtime: 'claude-interactive', model: 'opus' }, { provider: 'codex', model: 'gpt-run', remote: true, unavailable: ['claude-sdk'] }))
      .toEqual({ changed: 'remote', provider: 'codex', model: 'gpt-run', source: 'run' });
    // An explicit SDK pin is honored as written: only a MOVED pin consults availability.
    expect(spawnTargetFor({ runtime: 'claude-sdk', model: 'opus' }, { provider: 'codex', model: 'gpt-run', remote: true, unavailable: ['claude-sdk'] }))
      .toEqual({ changed: null, provider: 'claude', model: 'opus', source: 'pin' });
  });

  it('a Claude CLI pin whose provider is switched off is dropped, not moved', () => {
    expect(spawnTargetFor({ runtime: 'claude-interactive', model: 'opus' }, { provider: 'codex', model: 'gpt-run', remote: true, disabled: ['claude'] }))
      .toEqual({ changed: 'provider-disabled', provider: 'codex', model: 'gpt-run', source: 'run' });
  });

  it('an SDK pin on a remote run and any pin on a local run are honored unchanged', () => {
    expect(spawnTargetFor({ runtime: 'codex-sdk', providerModel: 'gpt-pinned' }, { provider: 'claude', model: 'sonnet', remote: true }))
      .toEqual({ changed: null, provider: 'codex', model: 'gpt-pinned', source: 'pin' });
    expect(spawnTargetFor({ runtime: 'omp-sdk', providerModel: 'other-provider/model-x' }, { provider: 'codex', model: 'gpt-run', remote: false }))
      .toEqual({ changed: null, provider: 'omp', model: 'other-provider/model-x', source: 'pin' });
  });

  it('a provider-less pin (model only) is untouched by the gates', () => {
    expect(spawnTargetFor({ providerModel: 'gpt-pinned' }, { provider: 'codex', model: 'gpt-run', remote: true }))
      .toEqual({ changed: null, provider: 'codex', model: 'gpt-pinned', source: 'pin' });
  });

  it('a pin on a disabled provider drops its model id with it', () => {
    expect(spawnTargetFor({ runtime: 'omp-sdk', providerModel: 'other-provider/model-x' }, { provider: 'codex', model: 'gpt-run', remote: false, disabled: ['omp'] }))
      .toEqual({ changed: 'provider-disabled', provider: 'codex', model: 'gpt-run', source: 'run' });
  });
});
