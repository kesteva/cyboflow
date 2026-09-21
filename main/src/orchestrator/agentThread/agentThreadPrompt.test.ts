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
    // Codex 0.153.3 "code mode": cyboflow_* tools are reachable ONLY through
    // functions.exec, so the prompt must sanction that path or the model refuses
    // every tool call (observed live).
    expect(getAgentSystemPrompt()).toMatch(/functions\.exec[^.]*allowed/);
    expect(getAgentSystemPrompt()).toMatch(/mcp__cyboflow__<name>/);
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
      'cyboflow_agents',
    ]) {
      expect(prompt).toContain(tool);
    }
  });

  it('is dense but not padded — within the ~60-370 line target', () => {
    // Ceiling widened from 130 → 160 when the "What cyboflow is" product
    // overview + the cyboflow_reference tool bullet were added, then 160 → 230
    // when the "Recommending the right flow" section (decision map + compound
    // pressure), the cyboflow_history tool bullet, and the launch-run seed
    // semantics were added; the prompt now carries proactive flow-recommendation
    // guidance on top of the tool/contract/recap guidance. Widened again 230 →
    // 260 for the create-backlog-items payload shape + its quality-bar bullet.
    // Widened again 260 → 300 for the "Custom widgets" section (S6,
    // docs/proposals/CUSTOM-VIEWS.md §7.4): the WidgetSpec contract summary,
    // the schema→preview→save workflow, two worked-example specs, and the
    // authoring rules (session_id provenance, SQL restrictions, limits).
    // Widened again 300 → 330 for the create-workflow proposal kind: its
    // payload shape, the cyboflow_agents tool bullet, and the quality-bar
    // bullet spelling out the definition shape + agent persona rules.
    // Widened again 330 → 370 for TASK-292/293/294: the cyboflow_queue
    // summary-first + paging guidance, the triage-findings proposal kind, and
    // the launch-run custom-workflow (workflowId / custom name) rules.
    const lines = getAgentSystemPrompt().split('\n').length;
    expect(lines).toBeGreaterThanOrEqual(60);
    expect(lines).toBeLessThanOrEqual(370);
  });

  it('mentions Custom widgets and the two disjoint write-shaped tools', () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toMatch(/## Custom widgets/);
    expect(prompt).toMatch(/two write-shaped tools/i);
  });

  it('documents the three custom-widget-authoring tools by exact name', () => {
    const prompt = getAgentSystemPrompt();
    for (const tool of ['cyboflow_db_schema', 'cyboflow_widget_preview', 'cyboflow_widget_save']) {
      expect(prompt).toContain(tool);
    }
  });

  it('documents the onData payload shape for tier-3 html widgets (sources.<name>.rows)', () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toMatch(/onData.*callback receives `\{sources, settings, context, theme\}`/s);
    expect(prompt).toContain('payload.sources.usage.rows');
  });

  it('tells the agent a session-less widget request still saves (publish:true into the library)', () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toMatch(/omit `session_id` and save with\s+`publish:true`/);
    expect(prompt).toMatch(/Add widget → Mine/);
  });

  it('mentions every WidgetRender.shape literal and every TransformStep.op literal', () => {
    // Hardcoded rather than derived from shared/customViews/validate.ts: its
    // schemas are z.union([...]) trees of z.object({shape: z.literal(...)})
    // members, not z.enum, so there is no single `.options` array of bare
    // literal strings to read off — see shared/types/customViews.ts
    // WidgetRender / TransformStep for the source of truth these mirror.
    const WIDGET_RENDER_SHAPES = ['stat', 'table', 'columns', 'bars', 'list']; // WidgetRender shape literals (excludes 'html', which carries no 'shape' field)
    const TRANSFORM_STEP_OPS = ['filter', 'sort', 'limit', 'bucketDate', 'group', 'derive']; // TransformStep op literals

    const prompt = getAgentSystemPrompt();
    for (const shape of WIDGET_RENDER_SHAPES) {
      expect(prompt, `render shape '${shape}' missing from prompt`).toContain(shape);
    }
    for (const op of TRANSFORM_STEP_OPS) {
      expect(prompt, `transform op '${op}' missing from prompt`).toContain(op);
    }
  });

  it('mentions recommending the right flow', () => {
    expect(getAgentSystemPrompt()).toMatch(/recommending the right flow/i);
  });

  it('tells the assistant a launch-run may name a custom flow by exact name or by workflowId (TASK-294)', () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toMatch(/`workflowId`/);
    expect(prompt).toMatch(/unknown_workflow:<name>/);
    expect(prompt).toMatch(/PREFER `workflowId` for\s+a custom flow/);
  });

  it('documents the triage-findings proposal kind and asks for per-group reasoning in the reply (TASK-292)', () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toMatch(/\*\*triage-findings\*\*/);
    expect(prompt).toMatch(/per-group\s+reasoning in your reply/);
    expect(prompt).toMatch(/set-selected:true` stages AND selects/);
  });

  it('tells the assistant to size an inbox with cyboflow_queue summary_only before paging it (TASK-293)', () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toMatch(/`summary_only:true` FIRST/);
    expect(prompt).toMatch(/`nextOffset`/);
  });

  it('documents the create-workflow proposal kind and the agents read that precedes it', () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toMatch(/create-workflow/);
    expect(prompt).toMatch(/\*\*create-workflow\*\*/);
    expect(prompt).toMatch(/kebab-case of its/);
    expect(prompt).toMatch(/Call it before ANY `create-workflow`\s+proposal/);
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
