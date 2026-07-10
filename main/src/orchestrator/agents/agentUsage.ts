/**
 * agentUsage — compute, per canonical agent key, where it is BOUND (a
 * `step.agent` OR a fan-out `step.fanOut.inner[].agent` in some workflow
 * definition) and where it is DISPATCHED (referenced via a fan-out inner
 * chain — e.g. code-review/write-tests are fanned out by the sprint/ship
 * orchestrator's `execute-tasks` step).
 *
 * `usedBy`/`workflowCount` walk the supplied workflow definitions and resolve
 * every step via `resolveStepAgentKey` (human gates resolve to `null` and are
 * skipped) — for a fan-out step this now ALSO walks `fanOut.inner`, so an
 * agent referenced ONLY via a fan-out chain no longer shows zero usage.
 * `dispatchedBy` derives from the SAME resolved definitions' `fanOut.inner`
 * entries (workflow name, deduped) — this replaced a literal string-scan over
 * the built-in `.md` prose, which broke once the per-task fan-out chain prose
 * was deleted in favor of the runtime-generated instruction block (see
 * `main/src/orchestrator/prompts/fan-out-instructions.ts`). The prose scan
 * caught no OTHER agent references worth preserving: every non-fan-out token
 * it matched belonged to an agent already bound via a literal `step.agent`
 * elsewhere in the same definition, so dropping it loses no signal. Every
 * canonical key gets an entry, even when empty.
 */
import type { WorkflowDefinition } from '../../../../shared/types/workflows';
import {
  CANONICAL_AGENT_KEYS,
  resolveStepAgentKey,
} from '../../../../shared/types/agentIdentity';
import type { AgentUsage, AgentUsageStep } from '../../../../shared/types/agents';

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

  /** Find-or-create this workflow's `usedBy` step group for `key`, then append `stepName`. */
  const recordUsedBy = (key: string, workflowName: string, stepName: string, phaseColor: string): void => {
    const entry = ensure(key);
    let stepGroup: AgentUsageStep | undefined = entry.usedBy.find((u) => u.workflowName === workflowName);
    if (stepGroup === undefined) {
      stepGroup = { workflowName, stepNames: [], phaseColor };
      entry.usedBy.push(stepGroup);
    }
    stepGroup.stepNames.push(stepName);
  };

  // ── Walk every step of every workflow definition. ──
  for (const { name, definition } of workflows) {
    for (const phase of definition.phases) {
      for (const step of phase.steps) {
        const key = resolveStepAgentKey(step.id, step.agent);
        if (key !== null) recordUsedBy(key, name, step.name, phase.color);

        // Fan-out inner chain: each inner step ALSO binds an agent, driving one
        // lane per resolved item on either plane (both-planes contract,
        // shared/types/workflows.ts FanOutSpec). Counts toward `usedBy` the same
        // as an outer step, and separately seeds `dispatchedBy` — the coarse
        // workflow-name signal for an agent that is fanned out rather than bound
        // to a single top-level step.
        if (step.fanOut !== undefined) {
          for (const inner of step.fanOut.inner) {
            const innerKey = resolveStepAgentKey(inner.id, inner.agent);
            if (innerKey === null) continue; // human gate (not expected in an inner chain, fail-soft anyway)
            recordUsedBy(innerKey, name, inner.name ?? inner.id, phase.color);
            const entry = ensure(innerKey);
            if (!entry.dispatchedBy.includes(name)) entry.dispatchedBy.push(name);
          }
        }
      }
    }
  }

  // workflowCount = distinct workflows referencing this key.
  for (const entry of usage.values()) {
    entry.workflowCount = entry.usedBy.length;
  }

  return usage;
}
