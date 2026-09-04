import { describe, expect, it } from 'vitest';
import {
  isAgyModelFamily,
  normalizeAgentModelSelection,
} from '../agentModels';

describe('agentModels', () => {
  it('identifies agy model family including Gemini, Claude, and GPT-OSS models', () => {
    expect(isAgyModelFamily('gemini-3.8-flash-high')).toBe(true);
    expect(isAgyModelFamily('gemini-3.7-flash-medium')).toBe(true);
    expect(isAgyModelFamily('claude-sonnet-4-6')).toBe(true);
    expect(isAgyModelFamily('claude-opus-4-6-thinking')).toBe(true);
    expect(isAgyModelFamily('gpt-oss-120b-medium')).toBe(true);
    expect(isAgyModelFamily('unknown-model')).toBe(false);
  });

  it('normalizes agy model selection properly', () => {
    // Retains agy Gemini models
    expect(normalizeAgentModelSelection('agy', 'gemini-3.8-flash-high')).toBe('gemini-3.8-flash-high');

    // Retains agy-supported Claude models when selected for agy
    expect(normalizeAgentModelSelection('agy', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(normalizeAgentModelSelection('agy', 'claude-opus-4-6-thinking')).toBe('claude-opus-4-6-thinking');

    // Drops foreign models that belong to other providers and aren't supported on agy
    expect(normalizeAgentModelSelection('agy', 'claude-3-5-sonnet-20241022')).toBeUndefined();
    expect(normalizeAgentModelSelection('agy', 'gpt-4o')).toBeUndefined();

    // When provider is Claude, drops Gemini models
    expect(normalizeAgentModelSelection('claude', 'gemini-3.8-flash-high')).toBeUndefined();

    // Preserves Claude models for Claude
    expect(normalizeAgentModelSelection('claude', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(normalizeAgentModelSelection('claude', 'sonnet')).toBe('sonnet');
  });
});
