import { describe, it, expect } from 'vitest';
import { displayAgentModelSelection, resolveAgentModelAlias } from '../agentModelContext';

// Split out of shared/agents/__tests__/modelContext.test.ts when modelContext.ts
// relocated to shared/: this wrapper (the provider-namespacing layer around
// shared/agents/modelContext's resolveModelAlias) stays main-side, so its test
// stays with it rather than pulling a main-only module into a shared test.
describe('agentModelContext', () => {
  describe('resolveAgentModelAlias', () => {
    it('resolves Claude aliases only in the Claude provider namespace', () => {
      expect(resolveAgentModelAlias('claude', 'opus')).toBe('claude-opus-5-5[1m]');
      expect(resolveAgentModelAlias('claude', ' SONNET ')).toBe('claude-sonnet-5');
      expect(resolveAgentModelAlias('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    });

    it('suppresses Codex model ids before a Claude spawn', () => {
      expect(resolveAgentModelAlias('claude', 'gpt-5.5')).toBeUndefined();
      expect(resolveAgentModelAlias('claude', 'o4-mini')).toBeUndefined();
      expect(resolveAgentModelAlias('claude', 'codex-experimental')).toBeUndefined();
    });

    it('passes Codex model ids through while omitting stale Claude models', () => {
      expect(resolveAgentModelAlias('codex', 'gpt-5.5')).toBe('gpt-5.5');
      expect(resolveAgentModelAlias('codex', 'opus')).toBeUndefined();
      expect(resolveAgentModelAlias('codex', 'claude-opus-4-8')).toBeUndefined();
    });

    it('omits automatic selections so each provider runtime owns its default', () => {
      expect(resolveAgentModelAlias('claude', 'auto')).toBeUndefined();
      expect(resolveAgentModelAlias('codex', 'auto')).toBeUndefined();
      expect(resolveAgentModelAlias('codex', 'default')).toBeUndefined();
      expect(resolveAgentModelAlias('codex', '   ')).toBeUndefined();
      expect(resolveAgentModelAlias('codex')).toBeUndefined();
    });

    it('keeps future/custom ids that do not belong to the other provider family', () => {
      expect(resolveAgentModelAlias('claude', 'some-future-claude-model')).toBe('some-future-claude-model');
      expect(resolveAgentModelAlias('codex', 'some-future-codex-model')).toBe('some-future-codex-model');
    });

    it('normalizes display labels without resolving Claude aliases to concrete ids', () => {
      expect(displayAgentModelSelection('claude', 'opus', 'default')).toBe('opus');
      expect(displayAgentModelSelection('claude', 'gpt-5.5', 'default')).toBe('default');
      expect(displayAgentModelSelection('codex', 'opus', 'codex-default')).toBe('codex-default');
    });
  });
});
