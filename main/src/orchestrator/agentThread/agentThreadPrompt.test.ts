import { describe, expect, it } from 'vitest';
import { AGENT_SYSTEM_PROMPT, getAgentSystemPrompt } from './agentThreadPrompt';

/**
 * Guards against accidental truncation/rename of the global-agent system
 * prompt (S1.4) — not a content/voice test (that's a human read), just that
 * the loader returns real content carrying the two load-bearing anchors: the
 * sole write-shaped tool name (so a tool rename would flag this) and the
 * never-claim-execution rule (the promptable contract's non-negotiable core).
 */
describe('agentThreadPrompt', () => {
  it('getAgentSystemPrompt returns the same non-empty content as the exported const', () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toBe(AGENT_SYSTEM_PROMPT);
    expect(prompt.trim().length).toBeGreaterThan(0);
  });

  it('names the sole write-shaped tool', () => {
    expect(getAgentSystemPrompt()).toContain('cyboflow_propose_action');
  });

  it('states the never-claim-execution rule', () => {
    expect(getAgentSystemPrompt()).toMatch(/never claim an action happened/i);
  });

  it('references every other global-agent tool by exact name', () => {
    const prompt = getAgentSystemPrompt();
    for (const tool of [
      'cyboflow_overview',
      'cyboflow_backlog',
      'cyboflow_entity',
      'cyboflow_queue',
      'cyboflow_workflows',
      'cyboflow_workflow',
      'cyboflow_db_query',
      'cyboflow_reference',
      'cyboflow_fs_read',
      'cyboflow_fs_list',
      'cyboflow_fs_grep',
    ]) {
      expect(prompt).toContain(tool);
    }
  });

  it('is dense but not padded — within the ~60-160 line target', () => {
    // Ceiling widened from 130 → 160 when the "What cyboflow is" product
    // overview + the cyboflow_reference tool bullet were added; the prompt now
    // carries a compact feature summary on top of the tool/contract guidance.
    const lines = getAgentSystemPrompt().split('\n').length;
    expect(lines).toBeGreaterThanOrEqual(60);
    expect(lines).toBeLessThanOrEqual(160);
  });
});
