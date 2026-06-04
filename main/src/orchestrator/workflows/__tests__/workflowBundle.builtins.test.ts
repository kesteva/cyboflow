/**
 * Contract test for the SHIPPED built-in workflow bundles (IDEA-013 rung-(ii)).
 *
 * Resolves each built-in flow's co-located command bundle directly from the source
 * tree (the same `<name>/commands` layout `copy:assets` ships to dist) and locks
 * the exact set of `/cyboflow-<phase>` commands. This guards against a phase
 * command being added/removed/renamed out of sync with the slim orchestrator prose
 * and the WORKFLOW_DEFINITIONS step ids.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveWorkflowBundle } from '../workflowBundle';

const workflowsDir = path.join(__dirname, '..');

describe('built-in workflow bundles', () => {
  it('planner ships its 6 phase commands in order', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'planner.md'));
    expect(bundle.commands.map((c) => c.name)).toEqual([
      'approve-idea',
      'approve-plan',
      'context',
      'epics',
      'research',
      'tasks',
    ]);
    assertCommandShape(bundle.commands);
  });

  it('sprint ships its 8 phase commands in order', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'sprint.md'));
    expect(bundle.commands.map((c) => c.name)).toEqual([
      'code-review',
      'human-review',
      'implement',
      'sprint-review',
      'sprint-verify',
      'task-verify',
      'visual-verify',
      'write-tests',
    ]);
    assertCommandShape(bundle.commands);
  });
});

/** Every phase command carries a description frontmatter line and reports its step. */
function assertCommandShape(commands: { name: string; content: string }[]): void {
  for (const cmd of commands) {
    expect(cmd.content).toMatch(/^---[\s\S]*description:/);
    expect(cmd.content).toContain('cyboflow_report_step');
  }
}
