/**
 * agentUsage — compute, per canonical agent key, where it is BOUND (a
 * `step.agent` in some workflow definition) and where it is DISPATCHED (its
 * `cyboflow-<key>` token appears in a built-in workflow's orchestrator prose
 * without a step binding — e.g. code-review/write-tests are fanned out by the
 * sprint orchestrator).
 *
 * `usedBy`/`workflowCount` walk the supplied workflow definitions and resolve
 * each step via `resolveStepAgentKey` (human gates resolve to `null` and are
 * skipped). `dispatchedBy` reads the three built-in prose `.md` files (same
 * `__dirname`-relative path resolution as `builtInWorkflows.ts`). Every canonical
 * key gets an entry, even when empty.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';
import { CYBOFLOW_WORKFLOW_NAMES } from '../../../../shared/types/workflows';
import {
  CANONICAL_AGENT_KEYS,
  resolveStepAgentKey,
} from '../../../../shared/types/agentIdentity';
import type { AgentUsage } from '../../../../shared/types/agents';

/** One workflow to analyze: its name + the resolved (possibly edited) definition. */
export interface WorkflowForUsage {
  name: string;
  definition: WorkflowDefinition;
}

/**
 * Build the per-key `AgentUsage` map. Every canonical key is seeded with an empty
 * entry; bound + dispatched usage is then accumulated on top.
 */
export function computeAgentUsage(workflows: WorkflowForUsage[]): Map<string, AgentUsage> {
  const usage = new Map<string, AgentUsage>();
  for (const key of CANONICAL_AGENT_KEYS) {
    usage.set(key, { workflowCount: 0, usedBy: [], dispatchedBy: [] });
  }

  const ensure = (key: string): AgentUsage => {
    let entry = usage.get(key);
    if (entry === undefined) {
      entry = { workflowCount: 0, usedBy: [], dispatchedBy: [] };
      usage.set(key, entry);
    }
    return entry;
  };

  // ── Bound usage: walk every step of every workflow definition. ──
  for (const { name, definition } of workflows) {
    for (const phase of definition.phases) {
      for (const step of phase.steps) {
        const key = resolveStepAgentKey(step.id, step.agent);
        if (key === null) continue; // human gate
        const entry = ensure(key);
        let stepGroup = entry.usedBy.find((u) => u.workflowName === name);
        if (stepGroup === undefined) {
          stepGroup = { workflowName: name, stepNames: [], phaseColor: phase.color };
          entry.usedBy.push(stepGroup);
        }
        stepGroup.stepNames.push(step.name);
      }
    }
    // workflowCount = distinct workflows referencing this key.
    for (const entry of usage.values()) {
      entry.workflowCount = entry.usedBy.length;
    }
  }

  // ── Dispatched usage: scan the built-in prose for `cyboflow-<key>` tokens. ──
  for (const wf of CYBOFLOW_WORKFLOW_NAMES) {
    let prose: string;
    try {
      prose = readFileSync(join(__dirname, '..', 'workflows', `${wf}.md`), 'utf-8');
    } catch {
      continue; // fail-soft: a missing prose file simply contributes no dispatch links
    }
    for (const key of CANONICAL_AGENT_KEYS) {
      if (prose.includes(`cyboflow-${key}`)) {
        const entry = ensure(key);
        if (!entry.dispatchedBy.includes(wf)) entry.dispatchedBy.push(wf);
      }
    }
  }

  return usage;
}
