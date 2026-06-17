/**
 * workflowEditorOptions.test.ts — AC-P0-4: the editor's AGENT_OPTIONS suggestion
 * list is derived from the canonical agent-key registry plus the human gate, so
 * the blueprint editor's agent <select> stays in sync with the agent identity
 * source of truth (shared/types/agentIdentity.ts).
 */
import { describe, it, expect } from 'vitest';

import { AGENT_OPTIONS } from '../workflowEditorOptions';
import { CANONICAL_AGENT_KEYS, HUMAN_GATE_AGENT } from '../../../../../shared/types/agentIdentity';

describe('AC-P0-4: AGENT_OPTIONS mirrors the canonical agent vocabulary', () => {
  it('deep-equals [...CANONICAL_AGENT_KEYS, HUMAN_GATE_AGENT]', () => {
    expect([...AGENT_OPTIONS]).toEqual([...CANONICAL_AGENT_KEYS, HUMAN_GATE_AGENT]);
  });
});
