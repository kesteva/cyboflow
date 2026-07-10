/**
 * Unit tests for applyWorkflowAgentConfigs (workflow-scoped agent configs).
 *
 * A model-only config over a project override replaces the model but keeps the
 * prompt; a `custom` copy replaces description/systemPrompt/tools/enabledMcps, drops
 * rawContent + flips source to builtin-override, and filters unknown tools; an
 * unknown agentKey is ignored (configs never ADD agents); an empty config map — or
 * an empty per-agent config — is the identity.
 */
import { describe, it, expect } from 'vitest';
import { applyWorkflowAgentConfigs, type EffectiveAgent } from '../effectiveAgents';
import type { CliTool } from '../../../../../shared/types/cliTools';
import type { WorkflowAgentConfig } from '../../../../../shared/types/workflows';

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
    description: 'PROJECT DESC',
    systemPrompt,
    tools: ['Read'],
    model,
    enabledMcps: ['ctx'],
    source: 'builtin-override',
  };
}

describe('applyWorkflowAgentConfigs', () => {
  it('model-only config overrides a project-override pin (keeps the prompt untouched)', () => {
    const projectOverridden = overridden('planner', 'PROJECT PROMPT', 'opus');
    const [result] = applyWorkflowAgentConfigs([projectOverridden], { planner: { model: 'haiku' } });
    expect(result.model).toBe('haiku'); // workflow config beats the project pin
    expect(result.systemPrompt).toBe('PROJECT PROMPT'); // untouched
    expect(result.source).toBe('builtin-override'); // already an override; stays
  });

  it('model-only config over an unoverridden builtin drops rawContent + flips source', () => {
    const [result] = applyWorkflowAgentConfigs([builtin('planner')], { planner: { model: 'sonnet' } });
    expect(result.model).toBe('sonnet');
    expect(result.source).toBe('builtin-override');
    expect(result.rawContent).toBeUndefined();
    expect(result.systemPrompt).toBe('BUILTIN PROMPT'); // no custom → body untouched
  });

  it('custom copy replaces body fields and drops rawContent', () => {
    const [result] = applyWorkflowAgentConfigs([builtin('planner')], {
      planner: {
        custom: {
          description: 'CUSTOM DESC',
          systemPrompt: 'CUSTOM PROMPT',
          tools: ['Read', 'Edit'],
          enabledMcps: ['ctx7'],
        },
      },
    });
    expect(result.description).toBe('CUSTOM DESC');
    expect(result.systemPrompt).toBe('CUSTOM PROMPT');
    expect(result.tools).toEqual(['Read', 'Edit']);
    expect(result.enabledMcps).toEqual(['ctx7']);
    expect(result.source).toBe('builtin-override');
    expect(result.rawContent).toBeUndefined();
    expect(result.model).toBeNull(); // no model in config → inherit unchanged
  });

  it('custom copy + model together apply both (model + body)', () => {
    const [result] = applyWorkflowAgentConfigs([builtin('planner')], {
      planner: {
        model: 'fable',
        custom: { description: 'D', systemPrompt: 'P', tools: ['Bash'], enabledMcps: [] },
      },
    });
    expect(result.model).toBe('fable');
    expect(result.systemPrompt).toBe('P');
    expect(result.tools).toEqual(['Bash']);
  });

  it('filters unknown tools out of a custom copy (silently drops non-CliTool values)', () => {
    const [result] = applyWorkflowAgentConfigs([builtin('planner')], {
      planner: {
        custom: {
          description: 'D',
          systemPrompt: 'P',
          tools: ['Read', 'not-a-tool', 'Edit'] as unknown as CliTool[],
          enabledMcps: [],
        },
      },
    });
    expect(result.tools).toEqual(['Read', 'Edit']);
  });

  it('ignores a config for an unknown agentKey (never adds agents)', () => {
    const input = [builtin('planner')];
    const result = applyWorkflowAgentConfigs(input, { 'ghost-agent': { model: 'sonnet' } });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(input[0]); // planner untouched (rawContent kept, source builtin)
  });

  it('an empty configs map is the identity (every agent unchanged)', () => {
    const input = [builtin('planner'), builtin('sprint')];
    const result = applyWorkflowAgentConfigs(input, {});
    expect(result[0]).toEqual(input[0]);
    expect(result[1]).toEqual(input[1]);
  });

  it('an empty per-agent config ({}) leaves that agent unchanged (never flips source)', () => {
    const [result] = applyWorkflowAgentConfigs([builtin('planner')], { planner: {} });
    expect(result.source).toBe('builtin'); // no change → no source flip
    expect(result.rawContent).toBe('RAW MD BODY');
  });

  // ── Malformed-shape robustness (out-of-band-edited spec) ────────────────────
  // parseWorkflowDefinition passes agentConfigs through unvalidated, so a hand-edited
  // spec can carry the wrong runtime shapes. None may throw (a throw would land in
  // installAgentOverlay's outer catch and abort the WHOLE overlay).

  it('treats a non-object custom (string) as absent — no throw, agent untouched', () => {
    const input = [builtin('planner')];
    const result = applyWorkflowAgentConfigs(
      input,
      { planner: { custom: 'not an object' } } as unknown as Record<string, WorkflowAgentConfig>,
    );
    expect(result[0].systemPrompt).toBe('BUILTIN PROMPT'); // body untouched
    expect(result[0].source).toBe('builtin'); // no valid custom/model → no source flip
    expect(result[0].rawContent).toBe('RAW MD BODY'); // rawContent kept
  });

  it('coerces a non-array tools field to [] — no throw', () => {
    const [result] = applyWorkflowAgentConfigs([builtin('planner')], {
      planner: {
        custom: {
          description: 'D',
          systemPrompt: 'P',
          tools: 'Read,Edit' as unknown as CliTool[],
          enabledMcps: [],
        },
      },
    });
    expect(result.tools).toEqual([]);
    expect(result.systemPrompt).toBe('P'); // the valid string field still applies
  });

  it('filters non-string entries out of enabledMcps — no throw', () => {
    const [result] = applyWorkflowAgentConfigs([builtin('planner')], {
      planner: {
        custom: {
          description: 'D',
          systemPrompt: 'P',
          tools: ['Read'],
          enabledMcps: ['git', 42, null, 'ctx7'] as unknown as string[],
        },
      },
    });
    expect(result.enabledMcps).toEqual(['git', 'ctx7']);
  });

  it('keeps the existing description/systemPrompt when the custom fields are non-strings', () => {
    const [result] = applyWorkflowAgentConfigs([builtin('planner')], {
      planner: {
        custom: {
          description: 42 as unknown as string,
          systemPrompt: null as unknown as string,
          tools: ['Edit'],
          enabledMcps: [],
        },
      },
    });
    // Non-string description/systemPrompt are ignored — the base values survive.
    expect(result.description).toBe('desc');
    expect(result.systemPrompt).toBe('BUILTIN PROMPT');
    // A valid array field still applies + source flips (a real custom object was present).
    expect(result.tools).toEqual(['Edit']);
    expect(result.source).toBe('builtin-override');
  });
});
