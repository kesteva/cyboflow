/**
 * Unit tests for applyVariantAgentDeltas (A/B testing, migration 048).
 *
 * A prompt-only delta over an unoverridden builtin drops rawContent + flips source
 * to builtin-override; a model delta narrows via isAgentModelAlias (a bad alias
 * keeps the existing model); a variant delta wins over a project override for the
 * touched fields; an unknown agentKey is ignored (deltas never ADD agents).
 */
import { describe, it, expect } from 'vitest';
import { applyVariantAgentDeltas, type EffectiveAgent } from '../effectiveAgents';

function builtin(agentKey: string): EffectiveAgent {
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
  };
}

function overridden(agentKey: string, systemPrompt: string, model: EffectiveAgent['model']): EffectiveAgent {
  return {
    agentKey,
    name: `cyboflow-${agentKey}`,
    role: 'role',
    description: 'desc',
    systemPrompt,
    tools: [],
    model,
    enabledMcps: [],
    source: 'builtin-override',
  };
}

describe('applyVariantAgentDeltas', () => {
  it('prompt-only delta over an unoverridden builtin drops rawContent + flips source to builtin-override', () => {
    const [result] = applyVariantAgentDeltas([builtin('planner')], {
      planner: { systemPrompt: 'VARIANT PROMPT' },
    });
    expect(result.systemPrompt).toBe('VARIANT PROMPT');
    expect(result.source).toBe('builtin-override');
    expect(result.rawContent).toBeUndefined();
    expect(result.model).toBeNull(); // no model delta → inherit unchanged
  });

  it('narrows model via isAgentModelAlias; a bad alias keeps the existing model', () => {
    const good = applyVariantAgentDeltas([builtin('planner')], { planner: { model: 'sonnet' } })[0];
    expect(good.model).toBe('sonnet');
    expect(good.source).toBe('builtin-override');

    const bad = applyVariantAgentDeltas([builtin('planner')], { planner: { model: 'not-a-model' } })[0];
    expect(bad.model).toBeNull(); // bad alias → existing (null) preserved
  });

  it('variant delta WINS over a project override for the touched fields', () => {
    const projectOverridden = overridden('planner', 'PROJECT PROMPT', 'opus');
    const [result] = applyVariantAgentDeltas([projectOverridden], {
      planner: { systemPrompt: 'VARIANT PROMPT', model: 'haiku' },
    });
    expect(result.systemPrompt).toBe('VARIANT PROMPT');
    expect(result.model).toBe('haiku');
    expect(result.source).toBe('builtin-override'); // already an override; stays
  });

  it('leaves untouched fields of a partial delta intact (model-only delta keeps prompt)', () => {
    const projectOverridden = overridden('planner', 'PROJECT PROMPT', 'opus');
    const [result] = applyVariantAgentDeltas([projectOverridden], { planner: { model: 'haiku' } });
    expect(result.systemPrompt).toBe('PROJECT PROMPT'); // untouched
    expect(result.model).toBe('haiku');
  });

  it('ignores a delta for an unknown agentKey (never adds agents)', () => {
    const input = [builtin('planner')];
    const result = applyVariantAgentDeltas(input, { 'ghost-agent': { systemPrompt: 'x' } });
    expect(result).toHaveLength(1);
    expect(result[0].agentKey).toBe('planner');
    expect(result[0].source).toBe('builtin'); // untouched (no delta for planner)
    expect(result[0].rawContent).toBe('RAW MD BODY');
  });

  it('leaves an agent with no delta completely unchanged', () => {
    const input = [builtin('planner'), builtin('sprint')];
    const result = applyVariantAgentDeltas(input, { sprint: { systemPrompt: 'S' } });
    expect(result[0]).toEqual(input[0]); // planner untouched (rawContent kept)
    expect(result[1].source).toBe('builtin-override');
    expect(result[1].rawContent).toBeUndefined();
  });
});
