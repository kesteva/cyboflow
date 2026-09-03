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
    // Defense in depth for a host (the Codex app-server) whose multi-agent
    // tools cannot be switched off by config on the pinned build.
    expect(getAgentSystemPrompt()).toMatch(/never spawn sub-agents/i);
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
      'cyboflow_history',
    ]) {
      expect(prompt).toContain(tool);
    }
  });

  it('is dense but not padded — within the ~60-260 line target', () => {
    // Ceiling widened from 130 → 160 when the "What cyboflow is" product
    // overview + the cyboflow_reference tool bullet were added, then 160 → 230
    // when the "Recommending the right flow" section (decision map + compound
    // pressure), the cyboflow_history tool bullet, and the launch-run seed
    // semantics were added; the prompt now carries proactive flow-recommendation
    // guidance on top of the tool/contract/recap guidance. Widened again 230 →
    // 260 for the create-backlog-items payload shape + its quality-bar bullet.
    const lines = getAgentSystemPrompt().split('\n').length;
    expect(lines).toBeGreaterThanOrEqual(60);
    expect(lines).toBeLessThanOrEqual(260);
  });

  it('mentions recommending the right flow', () => {
    expect(getAgentSystemPrompt()).toMatch(/recommending the right flow/i);
  });

  it('documents the create-backlog-items proposal kind (the assistant CAN add backlog items)', () => {
    // The whole point of the kind: the assistant used to have no create path at
    // all, so anchor on both the payload discriminant and the never-refuse rule.
    const prompt = getAgentSystemPrompt();
    expect(prompt).toMatch(/create-backlog-items/);
    // \s+ spans the prompt's own hard wrap between "a" and "task".
    expect(prompt).toMatch(/never say you cannot add a\s+task/i);
  });

  it('states the compound-pressure suggestion (findingIds seeding a Compound run)', () => {
    // Anchored on the NEW section's own text — `findingIds` and "Compound"
    // both pre-existed elsewhere in the prompt, so matching only those would
    // pass even with the compound-pressure paragraph deleted.
    const prompt = getAgentSystemPrompt();
    expect(prompt).toMatch(/Compound pressure/);
    expect(prompt).toMatch(/five or more open findings/i);
  });
});
