/**
 * Unit tests for the per-agent RUNTIME resolution added by migration 070.
 *
 * An override row's `runtime` / `codex_model` cells flow onto the EffectiveAgent
 * (mergeAgent override branch + customAgent) so `resolveStepAgent` — and thus the
 * programmatic spawn — pick up the global agent editor's runtime pin. An
 * unoverridden builtin (or a row predating the migration) inherits (runtime
 * absent). `buildEffectiveEntry` surfaces the pair on the wire `AgentEntry` as
 * `null` when absent. A workflow-scoped config still WINS over the base pin.
 */
import { describe, it, expect } from 'vitest';
import {
  mergeAgent,
  customAgent,
  buildEffectiveEntry,
  applyWorkflowAgentConfigs,
} from '../effectiveAgents';
import type { BuiltInAgent } from '../agentCatalogue';
import type { AgentOverrideRow } from '../../../database/models';
import type { AgentUsage } from '../../../../../shared/types/agents';

const EMPTY_USAGE: AgentUsage = { workflowCount: 0, usedBy: [], dispatchedBy: [] };

function builtin(agentKey: string): BuiltInAgent {
  return {
    agentKey,
    name: `cyboflow-${agentKey}`,
    role: 'planner',
    description: 'BUILTIN DESC',
    systemPrompt: 'BUILTIN PROMPT',
    tools: ['Read'],
    rawContent: 'RAW MD',
  };
}

function row(overrides: Partial<AgentOverrideRow> = {}): AgentOverrideRow {
  return {
    id: 'ago_test',
    project_id: 1,
    agent_key: 'planner',
    base_agent_key: 'planner',
    name: 'cyboflow-planner',
    role: 'planner',
    description: 'OVERRIDE DESC',
    system_prompt: 'OVERRIDE PROMPT',
    tools_json: JSON.stringify(['Read']),
    enabled_mcps_json: '[]',
    is_custom: 0,
    version: 1,
    model: null,
    runtime: null,
    codex_model: null,
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('effectiveAgents runtime resolution (migration 070)', () => {
  it('an unoverridden builtin inherits (runtime + codexModel absent)', () => {
    const eff = mergeAgent(builtin('planner'), null);
    expect(eff.runtime).toBeUndefined();
    expect(eff.codexModel).toBeUndefined();
  });

  it('mergeAgent surfaces a codex-sdk override row runtime + codex model', () => {
    const eff = mergeAgent(
      builtin('planner'),
      row({ runtime: 'codex-sdk', codex_model: 'gpt-5.2-codex' }),
    );
    expect(eff.runtime).toBe('codex-sdk');
    expect(eff.codexModel).toBe('gpt-5.2-codex');
  });

  it('mergeAgent ignores an unrecognized runtime value (falls back to inherit)', () => {
    const eff = mergeAgent(builtin('planner'), row({ runtime: 'codex-pty' }));
    expect(eff.runtime).toBeUndefined();
  });

  it('a Claude-runtime override carries no codexModel', () => {
    const eff = mergeAgent(builtin('planner'), row({ runtime: 'claude-interactive' }));
    expect(eff.runtime).toBe('claude-interactive');
    expect(eff.codexModel).toBeUndefined();
  });

  it('customAgent surfaces its row runtime + codex model', () => {
    const eff = customAgent(
      row({ agent_key: 'my-helper', is_custom: 1, base_agent_key: null, runtime: 'codex-sdk', codex_model: 'gpt-5.2-codex' }),
    );
    expect(eff.source).toBe('custom');
    expect(eff.runtime).toBe('codex-sdk');
    expect(eff.codexModel).toBe('gpt-5.2-codex');
  });

  it('buildEffectiveEntry surfaces runtime/codexModel as null when absent', () => {
    const entry = buildEffectiveEntry(mergeAgent(builtin('planner'), null), null, EMPTY_USAGE);
    expect(entry.runtime).toBeNull();
    expect(entry.codexModel).toBeNull();
  });

  it('buildEffectiveEntry surfaces the pinned runtime/codexModel', () => {
    const eff = mergeAgent(builtin('planner'), row({ runtime: 'codex-sdk', codex_model: 'gpt-5.2-codex' }));
    const entry = buildEffectiveEntry(eff, row({ runtime: 'codex-sdk', codex_model: 'gpt-5.2-codex' }), EMPTY_USAGE);
    expect(entry.runtime).toBe('codex-sdk');
    expect(entry.codexModel).toBe('gpt-5.2-codex');
  });

  it('a workflow-scoped runtime config WINS over the base agent runtime', () => {
    const base = mergeAgent(builtin('planner'), row({ runtime: 'claude-interactive' }));
    const [result] = applyWorkflowAgentConfigs([base], { planner: { runtime: 'codex-sdk' } });
    expect(result.runtime).toBe('codex-sdk'); // config beats the global-agent pin
  });

  it('the base agent runtime survives when no workflow config touches it', () => {
    const base = mergeAgent(builtin('planner'), row({ runtime: 'codex-sdk', codex_model: 'gpt-5.2-codex' }));
    const [result] = applyWorkflowAgentConfigs([base], {});
    expect(result.runtime).toBe('codex-sdk');
    expect(result.codexModel).toBe('gpt-5.2-codex');
  });
});
