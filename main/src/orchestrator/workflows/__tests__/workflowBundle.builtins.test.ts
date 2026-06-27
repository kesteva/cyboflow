/**
 * Contract test for the SHIPPED built-in workflow bundles (IDEA-013 rung-(ii),
 * subagent rework).
 *
 * Resolves each built-in flow's co-located bundle directly from the source tree
 * (the same `<name>/agents` layout `copy:assets` ships to dist) and locks the exact
 * set of `cyboflow-<phase>` subagents. Heavy phases are delegated to subagents
 * (own context window); human-gate phases run INLINE in the orchestrator, so they
 * ship no bundle file. This guards against a phase subagent being added/removed/
 * renamed out of sync with the orchestrator prose and the WORKFLOW_DEFINITIONS step
 * ids, and locks the single-writer invariant (no `cyboflow_*` tool in a subagent).
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveWorkflowBundle } from '../workflowBundle';

const workflowsDir = path.join(__dirname, '..');

describe('built-in workflow bundles', () => {
  it('planner ships its 6 heavy-phase subagents in order (gates stay inline)', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'planner.md'));
    // Human gates (approve-idea / approve-design / approve-plan) run inline in the
    // orchestrator — they are NOT delegated, so the bundle ships no commands, only
    // subagents.
    expect(bundle.commands).toEqual([]);
    expect(bundle.agents.map((a) => a.name)).toEqual([
      'architecture',
      'context',
      'epics',
      'research',
      'tasks',
      'ui-prototype',
    ]);
    assertAgentShape(bundle.agents);
  });

  it('sprint ships its 8 heavy-phase subagents in order (gate stays inline)', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'sprint.md'));
    // The human-review gate runs inline in the orchestrator — not delegated — so the
    // bundle ships no commands, only subagents.
    expect(bundle.commands).toEqual([]);
    expect(bundle.agents.map((a) => a.name)).toEqual([
      'code-review',
      'dependency-analyzer',
      'implement',
      'sprint-review',
      'sprint-verify',
      'task-verify',
      'visual-verify',
      'write-tests',
    ]);
    assertAgentShape(bundle.agents);
  });

  it('ship ships its 14 heavy-phase subagents in order (gates stay inline)', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'ship.md'));
    // Human gates (approve-idea / approve-design / approve-plan / human-review) run
    // inline in the orchestrator — they are NOT delegated, so the bundle ships no
    // commands, only subagents. Ship = planner's plan/refine set ⊕ sprint's
    // execute/verify set, self-contained as verbatim copies.
    expect(bundle.commands).toEqual([]);
    expect(bundle.agents.map((a) => a.name)).toEqual([
      'architecture',
      'code-review',
      'context',
      'dependency-analyzer',
      'epics',
      'implement',
      'research',
      'sprint-review',
      'sprint-verify',
      'task-verify',
      'tasks',
      'ui-prototype',
      'visual-verify',
      'write-tests',
    ]);
    assertAgentShape(bundle.agents);
  });
});

/**
 * The ONE sanctioned subagent-callable cyboflow MCP tool (visual-verification P6).
 * It is request-only / fire-and-continue (enqueues a verification request and
 * returns immediately; never mutates workflow state), so it does NOT break the
 * single-writer invariant — "subagents request, never mutate". Every OTHER
 * `cyboflow_*` reference in a subagent is still forbidden below.
 */
const SANCTIONED_SUBAGENT_TOOL = 'mcp__cyboflow__cyboflow_request_verification';

/**
 * Every phase subagent carries name + description + tools frontmatter, returns a
 * `## Result` block, and NEVER touches a STATE-MUTATING `cyboflow_*` MCP tool —
 * the orchestrator is the single writer of workflow state (subagents only do
 * isolated side-work and return a compact result). The lone exception is the
 * request-only SANCTIONED_SUBAGENT_TOOL, which we strip before the guard so the
 * underscore match stays precise: agent prose freely says "cyboflow Planner" /
 * "cyboflow state" / `cyboflow-context`, none of which contain the tool-name
 * underscore.
 */
function assertAgentShape(agents: { name: string; content: string }[]): void {
  for (const agent of agents) {
    expect(agent.content, `${agent.name} frontmatter`).toMatch(
      /^---[\s\S]*name:[\s\S]*description:[\s\S]*tools:/,
    );
    expect(agent.content, `${agent.name} returns a Result block`).toContain('## Result');
    // Strip the one sanctioned request-only grant, then assert NO other cyboflow_*
    // tool is referenced (the single-writer invariant for mutating tools).
    const withoutSanctioned = agent.content.split(SANCTIONED_SUBAGENT_TOOL).join('');
    expect(withoutSanctioned, `${agent.name} must not call any state-mutating cyboflow_* tool`).not.toMatch(
      /cyboflow_/,
    );
  }
}
