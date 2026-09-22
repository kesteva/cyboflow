/**
 * Unit tests for applyRunAgentTargetOverrides — the operator-written per-run
 * agent-target layer (workflow_runs.agent_target_overrides_json, migration 144)
 * written by the "Switch runtime & retry" action on a limit-paused programmatic
 * run. Also covers the pure shared parse/serialize pair it is fed from.
 */
import { describe, it, expect } from 'vitest';
import { applyRunAgentTargetOverrides, type EffectiveAgent } from '../effectiveAgents';
import {
  parseRunAgentTargetOverrides,
  serializeRunAgentTargetOverrides,
} from '../../../../../shared/types/workflows';

function builtin(agentKey: string, extra: Partial<EffectiveAgent> = {}): EffectiveAgent {
  return {
    agentKey,
    name: `cyboflow-${agentKey}`,
    role: 'role',
    description: 'desc',
    systemPrompt: 'BUILTIN PROMPT',
    tools: [],
    model: null,
    enabledMcps: [],
    source: 'builtin',
    rawContent: 'RAW MD BODY',
    ...extra,
  };
}

describe('applyRunAgentTargetOverrides', () => {
  it('replaces runtime + providerModel, mirrors codexModel, drops rawContent, flips source', () => {
    const [r] = applyRunAgentTargetOverrides([builtin('implement')], {
      implement: { runtime: 'codex-sdk', providerModel: 'gpt-5.6-sol' },
    });
    expect(r.runtime).toBe('codex-sdk');
    expect(r.providerModel).toBe('gpt-5.6-sol');
    expect(r.codexModel).toBe('gpt-5.6-sol');
    expect(r.rawContent).toBeUndefined();
    expect(r.source).toBe('builtin-override');
    expect(r.systemPrompt).toBe('BUILTIN PROMPT');
  });

  it('null CLEARS model / providerModel / effort from the lower layers', () => {
    const agent = builtin('implement', {
      source: 'builtin-override',
      rawContent: undefined,
      model: 'opus',
      providerModel: 'old-model',
      codexModel: 'old-model',
      effort: 'high',
    });
    const [r] = applyRunAgentTargetOverrides([agent], {
      implement: { runtime: 'claude-sdk', model: null, providerModel: null, effort: null },
    });
    expect(r.model).toBeNull();
    expect(r.providerModel).toBeUndefined();
    expect(r.codexModel).toBeUndefined();
    expect(r.effort).toBeUndefined();
    expect(r.runtime).toBe('claude-sdk');
  });

  it('absent fields keep the lower layers\' values', () => {
    const agent = builtin('review', { model: 'sonnet', effort: 'medium' });
    const [r] = applyRunAgentTargetOverrides([agent], { review: { model: 'haiku' } });
    expect(r.model).toBe('haiku');
    expect(r.effort).toBe('medium');
  });

  it('returns the SAME object when nothing changes (no spurious source flip)', () => {
    const agent = builtin('implement', { model: 'opus' });
    const [r] = applyRunAgentTargetOverrides([agent], { implement: { model: 'opus' } });
    expect(r).toBe(agent);
    expect(r.rawContent).toBe('RAW MD BODY');
  });

  it('ignores invalid field values and unknown agent keys; no wildcard', () => {
    const a = builtin('a');
    const b = builtin('b');
    const out = applyRunAgentTargetOverrides([a, b], {
      a: { runtime: 'bogus' as never, model: 'gpt' as never },
      '*': { runtime: 'codex-sdk' },
      ghost: { runtime: 'codex-sdk' },
    });
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
    expect(out).toHaveLength(2);
  });
});

describe('parseRunAgentTargetOverrides / serializeRunAgentTargetOverrides', () => {
  it('round-trips a valid map, including explicit nulls', () => {
    const map = {
      implement: { runtime: 'codex-sdk' as const, model: null, providerModel: 'gpt-x', effort: 'high' as const },
    };
    const json = serializeRunAgentTargetOverrides(map);
    expect(json).not.toBeNull();
    expect(parseRunAgentTargetOverrides(json)).toEqual(map);
  });

  it('drops malformed entries and fields; null when nothing survives', () => {
    expect(parseRunAgentTargetOverrides(null)).toBeNull();
    expect(parseRunAgentTargetOverrides('')).toBeNull();
    expect(parseRunAgentTargetOverrides('{not json')).toBeNull();
    expect(parseRunAgentTargetOverrides('[]')).toBeNull();
    expect(parseRunAgentTargetOverrides('{"a": 3, "b": {"runtime": "nope"}}')).toBeNull();
    expect(
      parseRunAgentTargetOverrides(
        '{"a": {"runtime": "omp-sdk", "model": "gpt", "providerModel": "", "effort": "ultra"}}',
      ),
    ).toEqual({ a: { runtime: 'omp-sdk' } });
  });

  it('serialize returns null for an empty map (clears the column)', () => {
    expect(serializeRunAgentTargetOverrides({})).toBeNull();
    expect(serializeRunAgentTargetOverrides({ a: {} })).toBeNull();
  });
});
