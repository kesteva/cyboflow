/**
 * Unit tests for the agent-editor reducer's runtime/model behavior (migration 070).
 *
 * SEED carries the runtime + codexModel from the entry; SET_RUNTIME away from the
 * Codex runtime clears codexModel (mirrors the server-side normalizeRuntime) so a
 * Claude runtime never keeps a stale Codex model; switching back and picking a
 * Codex model round-trips.
 */
import { describe, it, expect } from 'vitest';
import { agentEditorReducer, initAgentEditorState } from '../useAgentEditorState';
import type { AgentEntry } from '../../../../../../shared/types/agents';

function entry(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    agentKey: 'implement',
    name: 'cyboflow-implement',
    role: 'sprint',
    description: 'Implements a task.',
    systemPrompt: 'You are the implementer.',
    tools: ['Read', 'Edit'],
    model: null,
    runtime: null,
    codexModel: null,
    enabledMcps: [],
    source: 'builtin',
    isCustom: false,
    isOverridden: false,
    usage: { workflowCount: 0, usedBy: [], dispatchedBy: [] },
    stats: {
      model: 'inherits run model',
      estPromptTokens: 5,
      costUsd: null,
      lastEditedAt: null,
      toolsEnabled: 2,
      toolsTotal: 8,
    },
    ...overrides,
  };
}

describe('agentEditorReducer — runtime/codexModel', () => {
  it('SEED carries the entry runtime + codexModel into the draft', () => {
    const state = initAgentEditorState(entry({ runtime: 'codex-sdk', codexModel: 'gpt-5.2-codex' }));
    expect(state.draft.runtime).toBe('codex-sdk');
    expect(state.draft.codexModel).toBe('gpt-5.2-codex');
  });

  it('SET_RUNTIME to a Claude runtime clears codexModel', () => {
    let state = initAgentEditorState(entry({ runtime: 'codex-sdk', codexModel: 'gpt-5.2-codex' }));
    state = agentEditorReducer(state, { type: 'SET_RUNTIME', runtime: 'claude-interactive' });
    expect(state.draft.runtime).toBe('claude-interactive');
    expect(state.draft.codexModel).toBeNull();
  });

  it('SET_RUNTIME to inherit (null) clears codexModel', () => {
    let state = initAgentEditorState(entry({ runtime: 'codex-sdk', codexModel: 'gpt-5.2-codex' }));
    state = agentEditorReducer(state, { type: 'SET_RUNTIME', runtime: null });
    expect(state.draft.runtime).toBeNull();
    expect(state.draft.codexModel).toBeNull();
  });

  it('SET_RUNTIME to codex-sdk keeps a previously chosen codexModel', () => {
    let state = initAgentEditorState(entry({ runtime: 'codex-sdk', codexModel: 'gpt-5.2-codex' }));
    state = agentEditorReducer(state, { type: 'SET_RUNTIME', runtime: 'codex-sdk' });
    expect(state.draft.codexModel).toBe('gpt-5.2-codex');
  });

  it('SET_CODEX_MODEL updates the codex model', () => {
    let state = initAgentEditorState(entry({ runtime: 'codex-sdk' }));
    state = agentEditorReducer(state, { type: 'SET_CODEX_MODEL', codexModel: 'gpt-5.2-codex' });
    expect(state.draft.codexModel).toBe('gpt-5.2-codex');
  });

  // A Claude model pin is only meaningful under a pinned Claude runtime — under
  // an inherited runtime the effective provider depends on the run, and the pin
  // is dropped outright on a programmatic run. The editor no longer offers that
  // state, so the reducer must not leave one behind either.
  it('SET_RUNTIME to inherit (null) clears a pinned Claude model', () => {
    let state = initAgentEditorState(entry({ runtime: 'claude-sdk', model: 'sonnet' }));
    state = agentEditorReducer(state, { type: 'SET_RUNTIME', runtime: null });
    expect(state.draft.runtime).toBeNull();
    expect(state.draft.model).toBeNull();
  });

  it('SET_RUNTIME to codex-sdk clears a pinned Claude model', () => {
    let state = initAgentEditorState(entry({ runtime: 'claude-sdk', model: 'sonnet' }));
    state = agentEditorReducer(state, { type: 'SET_RUNTIME', runtime: 'codex-sdk' });
    expect(state.draft.model).toBeNull();
  });

  it('SET_RUNTIME between Claude runtimes keeps the pinned Claude model', () => {
    let state = initAgentEditorState(entry({ runtime: 'claude-sdk', model: 'sonnet' }));
    state = agentEditorReducer(state, { type: 'SET_RUNTIME', runtime: 'claude-interactive' });
    expect(state.draft.model).toBe('sonnet');
  });
});
