import { describe, it, expect } from 'vitest';
import { gateStepAgentPin, shouldDropPinForRemoteRun } from '../programmaticRunnerComposition';
import { providerModelAfterRuntimeDrop, resolveStepSpawnTarget } from '../orchestrator/stepSpawnTarget';
import type { AgentProvider, WorkflowAgentRuntime } from '../../../shared/types/agentRuntime';

describe('shouldDropPinForRemoteRun', () => {
  it('drops local-only runtimes on a remote run', () => {
    for (const r of ['pi-sdk', 'omp', 'claude-pty', 'codex-pty']) {
      expect(shouldDropPinForRemoteRun(r, true)).toBe(true);
    }
  });
  it('keeps SDK runtimes on a remote run', () => {
    expect(shouldDropPinForRemoteRun('claude-sdk', true)).toBe(false);
    expect(shouldDropPinForRemoteRun('codex-sdk', true)).toBe(false);
  });
  it('never drops on a local run, and ignores an absent pin', () => {
    expect(shouldDropPinForRemoteRun('pi-sdk', false)).toBe(false);
    expect(shouldDropPinForRemoteRun(undefined, true)).toBe(false);
  });
});

/** The gates `resolveStepAgent` applies, then the spawn seam's reduction: what the step actually spawns on. */
function spawnTargetFor(
  pin: { runtime?: WorkflowAgentRuntime; model?: string; providerModel?: string },
  run: { provider: AgentProvider; model: string | null; remote: boolean; disabled?: AgentProvider[] },
) {
  const gated = gateStepAgentPin(pin, {
    isProviderEnabled: (p) => !(run.disabled ?? []).includes(p),
    runIsRemote: run.remote,
    runProvider: run.provider,
  });
  const target = resolveStepSpawnTarget(
    { runtime: gated.runtime, model: pin.model, providerModel: gated.providerModel },
    run.provider,
    run.model,
  );
  return { dropped: gated.dropped, ...target };
}

describe('gateStepAgentPin → resolveStepSpawnTarget', () => {
  it.each(['omp-sdk', 'pi-sdk'] as const)(
    'a dropped %s pin never hands its model id to a remote Codex run',
    (runtime) => {
      expect(spawnTargetFor({ runtime, providerModel: 'other-provider/model-x' }, { provider: 'codex', model: 'gpt-run', remote: true }))
        .toEqual({ dropped: 'remote', provider: 'codex', model: 'gpt-run', source: 'run' });
    },
  );

  it('a dropped pin keeps its provider model only when the step falls back onto the same provider', () => {
    expect(providerModelAfterRuntimeDrop('codex-sdk', 'codex', 'gpt-pinned')).toBe('gpt-pinned');
    expect(providerModelAfterRuntimeDrop('omp-sdk', 'codex', 'other-provider/model-x')).toBeUndefined();
    expect(providerModelAfterRuntimeDrop('codex-sdk', 'codex', null)).toBeUndefined();
  });

  it('a dropped pin on a remote Claude run keeps the Claude model pin and ignores the provider model', () => {
    expect(spawnTargetFor({ runtime: 'omp-sdk', model: 'claude-opus-5-5', providerModel: 'other-provider/model-x' }, { provider: 'claude', model: 'sonnet', remote: true }))
      .toEqual({ dropped: 'remote', provider: 'claude', model: 'claude-opus-5-5', source: 'pin' });
  });

  it('a dropped Claude CLI pin on a remote Codex run takes the run model, not a leftover provider model', () => {
    expect(spawnTargetFor({ runtime: 'claude-interactive', model: 'opus', providerModel: 'leftover' }, { provider: 'codex', model: 'gpt-run', remote: true }))
      .toEqual({ dropped: 'remote', provider: 'codex', model: 'gpt-run', source: 'run' });
  });

  it('an SDK pin on a remote run and any pin on a local run are honored unchanged', () => {
    expect(spawnTargetFor({ runtime: 'codex-sdk', providerModel: 'gpt-pinned' }, { provider: 'claude', model: 'sonnet', remote: true }))
      .toEqual({ dropped: null, provider: 'codex', model: 'gpt-pinned', source: 'pin' });
    expect(spawnTargetFor({ runtime: 'omp-sdk', providerModel: 'other-provider/model-x' }, { provider: 'codex', model: 'gpt-run', remote: false }))
      .toEqual({ dropped: null, provider: 'omp', model: 'other-provider/model-x', source: 'pin' });
  });

  it('a provider-less pin (model only) is untouched by the gates', () => {
    expect(spawnTargetFor({ providerModel: 'gpt-pinned' }, { provider: 'codex', model: 'gpt-run', remote: true }))
      .toEqual({ dropped: null, provider: 'codex', model: 'gpt-pinned', source: 'pin' });
  });

  it('a pin on a disabled provider drops its model id with it', () => {
    expect(spawnTargetFor({ runtime: 'omp-sdk', providerModel: 'other-provider/model-x' }, { provider: 'codex', model: 'gpt-run', remote: false, disabled: ['omp'] }))
      .toEqual({ dropped: 'provider-disabled', provider: 'codex', model: 'gpt-run', source: 'run' });
  });
});
