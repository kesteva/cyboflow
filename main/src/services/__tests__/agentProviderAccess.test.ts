/**
 * Pure-function coverage for the provider-access helpers in
 * shared/types/agentRuntime.ts — the single source both the renderer's pickers
 * and the main-side launch seams read through.
 *
 * The invariants worth locking:
 *   - ABSENT ⇒ the provider's own `defaultEnabled`. For claude/codex that is
 *     ENABLED, so an install that never touched the toggles behaves exactly as
 *     it did before the feature existed.
 *   - A provider introduced LATER may declare absent ⇒ DISABLED, so shipping it
 *     does not silently switch a new vendor on for every existing install. That
 *     policy is exercised against a test-local provider table rather than by
 *     adding a fake provider to the shipped registry.
 *   - The all-off map degrades to the per-provider defaults rather than bricking
 *     every seam.
 *   - The IPC validator accepts only `{claude?: boolean, codex?: boolean}` —
 *     an unknown provider key or a non-boolean member is rejected outright.
 */
import { describe, it, expect } from 'vitest';
import {
  AGENT_PROVIDER_DISABLED_CODE,
  enabledAgentProviders,
  enabledProvidersIn,
  firstEnabledRuntime,
  isAgentProviderAccess,
  isAgentProviderEnabled,
  isProviderEnabledIn,
  isRuntimeProviderEnabled,
  formatAgentProviderDisabled,
  parseAgentProviderDisabled,
  providerForRuntime,
  providerForRuntimeIn,
  resolveAgentProviderAccess,
  resolveProviderAccessIn,
  type AgentProviderTable,
} from '../../../../shared/types/agentRuntime';

describe('isAgentProviderEnabled', () => {
  it('floors an absent map and an absent member to enabled', () => {
    expect(isAgentProviderEnabled(undefined, 'claude')).toBe(true);
    expect(isAgentProviderEnabled({}, 'codex')).toBe(true);
    expect(isAgentProviderEnabled({ claude: false }, 'codex')).toBe(true);
  });

  it('honours an explicit false', () => {
    expect(isAgentProviderEnabled({ claude: false }, 'claude')).toBe(false);
  });
});

describe('providerForRuntime / isRuntimeProviderEnabled', () => {
  it('maps every runtime to its owning provider', () => {
    expect(providerForRuntime('claude-sdk')).toBe('claude');
    expect(providerForRuntime('claude-interactive')).toBe('claude');
    expect(providerForRuntime('codex-sdk')).toBe('codex');
    expect(providerForRuntime('codex-pty')).toBe('codex');
    expect(providerForRuntime('codex-exec')).toBe('codex');
    expect(providerForRuntime('omp-fleet')).toBe('omp');
  });

  it('gates a runtime on its provider', () => {
    const access = { claude: true, codex: false };
    expect(isRuntimeProviderEnabled(access, 'claude-interactive')).toBe(true);
    expect(isRuntimeProviderEnabled(access, 'codex-pty')).toBe(false);
  });
});

describe('enabledAgentProviders', () => {
  // OMP is absent from every list below because its registry entry opts OUT of
  // the legacy absent⇒enabled floor — see the omp describe block at the end.
  it('lists the default-enabled providers and drops the switched-off one', () => {
    expect(enabledAgentProviders(undefined)).toEqual(['claude', 'codex']);
    expect(enabledAgentProviders({ claude: false, codex: true })).toEqual(['codex']);
  });
});

describe('resolveAgentProviderAccess', () => {
  it('materializes EVERY provider at its own default from an absent or partial map', () => {
    expect(resolveAgentProviderAccess(undefined)).toEqual({
      claude: true,
      codex: true,
      omp: false,
      pi: false,
    });
    expect(resolveAgentProviderAccess({ codex: false })).toEqual({
      claude: true,
      codex: false,
      omp: false,
      pi: false,
    });
  });

  it('degrades an all-off map to the per-provider defaults', () => {
    expect(resolveAgentProviderAccess({ claude: false, codex: false })).toEqual({
      claude: true,
      codex: true,
      omp: false,
      pi: false,
    });
  });

  // An explicit `omp: true` is the user's own answer and survives the floor —
  // only an ABSENT key resolves through the registry default.
  it('honors an explicit opt-in for a default-disabled provider', () => {
    expect(resolveAgentProviderAccess({ omp: true })).toEqual({
      claude: true,
      codex: true,
      omp: true,
      pi: false,
    });
  });
});

describe('isAgentProviderAccess (IPC validator)', () => {
  it('accepts an empty, partial, or full boolean map', () => {
    expect(isAgentProviderAccess({})).toBe(true);
    expect(isAgentProviderAccess({ codex: false })).toBe(true);
    expect(isAgentProviderAccess({ claude: true, codex: false })).toBe(true);
  });

  it('rejects non-objects, arrays, unknown providers, and non-boolean members', () => {
    expect(isAgentProviderAccess(null)).toBe(false);
    expect(isAgentProviderAccess('claude')).toBe(false);
    expect(isAgentProviderAccess(['claude'])).toBe(false);
    expect(isAgentProviderAccess({ gemini: true })).toBe(false);
    expect(isAgentProviderAccess({ claude: 'yes' })).toBe(false);
  });
});

describe('firstEnabledRuntime', () => {
  it('returns the first candidate on an enabled provider', () => {
    expect(
      firstEnabledRuntime({ claude: false, codex: true }, ['claude-sdk', 'codex-sdk'] as const),
    ).toBe('codex-sdk');
  });

  it('returns null when no candidate is available', () => {
    expect(firstEnabledRuntime({ claude: false, codex: true }, ['claude-sdk'] as const)).toBeNull();
  });
});

/**
 * A table with a THIRD provider that opts in at absent⇒disabled — the shape the
 * next provider will ship as. Kept local to the test so the app's own registry
 * stays honest about which providers actually exist.
 */
type TestProvider = 'claude' | 'codex' | 'newcomer';

const TEST_PROVIDER_TABLE: AgentProviderTable<TestProvider> = {
  providers: ['claude', 'codex', 'newcomer'],
  definitions: {
    claude: { runtimePrefix: 'claude-', defaultEnabled: true },
    codex: { runtimePrefix: 'codex-', defaultEnabled: true },
    newcomer: { runtimePrefix: 'newcomer-', defaultEnabled: false },
  },
  fallbackProvider: 'claude',
};

describe('per-provider defaultEnabled policy', () => {
  it('keeps the legacy absent⇒enabled floor for the providers that shipped with it', () => {
    expect(isProviderEnabledIn(TEST_PROVIDER_TABLE, undefined, 'claude')).toBe(true);
    expect(isProviderEnabledIn(TEST_PROVIDER_TABLE, {}, 'codex')).toBe(true);
    expect(isProviderEnabledIn(TEST_PROVIDER_TABLE, { claude: false }, 'codex')).toBe(true);
  });

  it('leaves a newly introduced provider OFF until the user turns it on', () => {
    expect(isProviderEnabledIn(TEST_PROVIDER_TABLE, undefined, 'newcomer')).toBe(false);
    expect(isProviderEnabledIn(TEST_PROVIDER_TABLE, {}, 'newcomer')).toBe(false);
    // A legacy partial map — written before the provider existed — is exactly
    // the "absent key" case, and must not switch it on.
    expect(isProviderEnabledIn(TEST_PROVIDER_TABLE, { claude: true, codex: false }, 'newcomer')).toBe(
      false,
    );
    expect(isProviderEnabledIn(TEST_PROVIDER_TABLE, { newcomer: true }, 'newcomer')).toBe(true);
  });

  it('omits the default-off provider from the enabled list and the resolved map', () => {
    expect(enabledProvidersIn(TEST_PROVIDER_TABLE, undefined)).toEqual(['claude', 'codex']);
    expect(resolveProviderAccessIn(TEST_PROVIDER_TABLE, undefined)).toEqual({
      claude: true,
      codex: true,
      newcomer: false,
    });
  });

  it('routes a runtime by its registered prefix, including the new provider', () => {
    expect(providerForRuntimeIn(TEST_PROVIDER_TABLE, 'newcomer-sdk')).toBe('newcomer');
    expect(providerForRuntimeIn(TEST_PROVIDER_TABLE, 'codex-pty')).toBe('codex');
    expect(providerForRuntimeIn(TEST_PROVIDER_TABLE, 'nothing-sdk')).toBeNull();
  });
});

describe('the never-all-disabled floor', () => {
  it('does NOT fire while the one enabled provider is the newly introduced one', () => {
    expect(
      resolveProviderAccessIn(TEST_PROVIDER_TABLE, {
        claude: false,
        codex: false,
        newcomer: true,
      }),
    ).toEqual({ claude: false, codex: false, newcomer: true });
  });

  it('degrades a genuinely all-off map to the per-provider defaults', () => {
    expect(
      resolveProviderAccessIn(TEST_PROVIDER_TABLE, { claude: false, codex: false }),
    ).toEqual({ claude: true, codex: true, newcomer: false });
  });

  it('forces the fallback provider on when even the defaults would leave nothing enabled', () => {
    const allOptIn: AgentProviderTable<'first' | 'second'> = {
      providers: ['first', 'second'],
      definitions: {
        first: { runtimePrefix: 'first-', defaultEnabled: false },
        second: { runtimePrefix: 'second-', defaultEnabled: false },
      },
      fallbackProvider: 'first',
    };
    expect(resolveProviderAccessIn(allOptIn, { first: false, second: false })).toEqual({
      first: true,
      second: false,
    });
  });
});

describe('provider-disabled wire format', () => {
  it('round-trips provider + message through the machine prefix', () => {
    const wire = formatAgentProviderDisabled('codex', 'Codex is turned off.');
    expect(wire.startsWith(AGENT_PROVIDER_DISABLED_CODE)).toBe(true);
    expect(parseAgentProviderDisabled(wire)).toEqual({
      provider: 'codex',
      message: 'Codex is turned off.',
    });
  });

  it('still parses when an IPC layer prefixes its own text', () => {
    const wrapped = `Error invoking remote method: ${formatAgentProviderDisabled('claude', 'Claude is off.')}`;
    expect(parseAgentProviderDisabled(wrapped)).toEqual({
      provider: 'claude',
      message: 'Claude is off.',
    });
  });

  it('returns null for an ordinary failure or a non-string', () => {
    expect(parseAgentProviderDisabled('Failed to continue panel conversation')).toBeNull();
    expect(parseAgentProviderDisabled(undefined)).toBeNull();
    expect(parseAgentProviderDisabled(null)).toBeNull();
    // Right code, malformed payload — must not be mistaken for a real refusal.
    expect(parseAgentProviderDisabled(`${AGENT_PROVIDER_DISABLED_CODE}[gemini]: nope`)).toBeNull();
  });
});
