import { describe, expect, it } from 'vitest';
import { resolveAssistantRuntimeFromConfig } from '../assistantRuntime';
import type { AppConfig } from '../../types/config';

describe('resolveAssistantRuntimeFromConfig', () => {
  it('follows the default launch runtime when no explicit pick is stored', () => {
    const config: AppConfig = { defaultAgentRuntime: 'codex-sdk' };
    expect(resolveAssistantRuntimeFromConfig(config)).toBe('codex-sdk');
  });

  it('honors an explicit assistantRuntime pick over the launch default', () => {
    const config: AppConfig = {
      defaultAgentRuntime: 'codex-sdk',
      assistantRuntime: 'claude-sdk',
    };
    expect(resolveAssistantRuntimeFromConfig(config)).toBe('claude-sdk');
  });

  it('falls back to claude when the resolved provider is switched off', () => {
    const config: AppConfig = {
      defaultAgentRuntime: 'codex-sdk',
      agentProviderAccess: { claude: true, codex: false },
    };
    expect(resolveAssistantRuntimeFromConfig(config)).toBe('claude-sdk');
  });

  it('falls back to claude for a null/undefined config', () => {
    expect(resolveAssistantRuntimeFromConfig(null)).toBe('claude-sdk');
    expect(resolveAssistantRuntimeFromConfig(undefined)).toBe('claude-sdk');
  });
});
