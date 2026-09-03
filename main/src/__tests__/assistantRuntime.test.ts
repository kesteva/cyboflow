import { describe, expect, it } from 'vitest';
import {
  assistantRuntimeProvider,
  isAssistantRuntime,
  resolveAssistantRuntime,
} from '../../../shared/types/agentThread';

const allEnabled = () => true;

describe('resolveAssistantRuntime', () => {
  it('floors to claude-sdk when nothing is configured', () => {
    expect(resolveAssistantRuntime({ isProviderEnabled: allEnabled })).toBe('claude-sdk');
  });

  it('follows a Codex launch default with no explicit assistant pick (the onboarding path)', () => {
    expect(
      resolveAssistantRuntime({ defaultAgentRuntime: 'codex-sdk', isProviderEnabled: allEnabled }),
    ).toBe('codex-sdk');
    expect(
      resolveAssistantRuntime({ defaultAgentRuntime: 'codex-pty', isProviderEnabled: allEnabled }),
    ).toBe('codex-sdk');
  });

  it('leaves the assistant on Claude for an OMP / pi launch default', () => {
    expect(
      resolveAssistantRuntime({ defaultAgentRuntime: 'omp-sdk', isProviderEnabled: allEnabled }),
    ).toBe('claude-sdk');
    expect(
      resolveAssistantRuntime({ defaultAgentRuntime: 'pi-sdk', isProviderEnabled: allEnabled }),
    ).toBe('claude-sdk');
  });

  it('an explicit assistantRuntime wins over the launch default', () => {
    expect(
      resolveAssistantRuntime({
        assistantRuntime: 'claude-sdk',
        defaultAgentRuntime: 'codex-sdk',
        isProviderEnabled: allEnabled,
      }),
    ).toBe('claude-sdk');
    expect(
      resolveAssistantRuntime({
        assistantRuntime: 'codex-sdk',
        defaultAgentRuntime: 'claude-sdk',
        isProviderEnabled: allEnabled,
      }),
    ).toBe('codex-sdk');
  });

  it('falls through when the picked provider is switched off in Integrations', () => {
    const codexOff = (p: string) => p !== 'codex';
    expect(
      resolveAssistantRuntime({ assistantRuntime: 'codex-sdk', isProviderEnabled: codexOff }),
    ).toBe('claude-sdk');
    expect(
      resolveAssistantRuntime({ defaultAgentRuntime: 'codex-sdk', isProviderEnabled: codexOff }),
    ).toBe('claude-sdk');
  });

  it('treats an invalid or garbage value as absent instead of throwing', () => {
    expect(
      resolveAssistantRuntime({
        assistantRuntime: 'omp-sdk',
        defaultAgentRuntime: 'not-a-runtime',
        isProviderEnabled: allEnabled,
      }),
    ).toBe('claude-sdk');
    expect(
      resolveAssistantRuntime({ assistantRuntime: 42, isProviderEnabled: allEnabled }),
    ).toBe('claude-sdk');
  });
});

describe('assistant runtime helpers', () => {
  it('isAssistantRuntime admits only the two hostable runtimes', () => {
    expect(isAssistantRuntime('claude-sdk')).toBe(true);
    expect(isAssistantRuntime('codex-sdk')).toBe(true);
    expect(isAssistantRuntime('codex-pty')).toBe(false);
    expect(isAssistantRuntime(undefined)).toBe(false);
  });

  it('maps each runtime to its provider', () => {
    expect(assistantRuntimeProvider('claude-sdk')).toBe('claude');
    expect(assistantRuntimeProvider('codex-sdk')).toBe('codex');
  });
});
