/**
 * agentIdentity — the canonical agent-key vocabulary + step-aware legacy resolver.
 *
 * The canonical agent key is the bundled agent's FILE BASENAME — the stem of each
 * `main/src/orchestrator/workflows/<wf>/agents/<key>.md` (equivalently the
 * frontmatter `name:` with the `cyboflow-` prefix stripped; a unit test asserts
 * the two agree for all 13 files). This single key is used by:
 *   (i)   `WorkflowStep.agent` in WORKFLOW_DEFINITIONS,
 *   (ii)  the Agents catalogue + gallery,
 *   (iii) the `agent_overrides.agent_key` column, and
 *   (iv)  the spawn-time filename `cyboflow-<key>.md`.
 *
 * `human` is a GATE, not an agent: it is a valid `step.agent` value (kept
 * selectable in the blueprint editor) but is excluded from the catalogue/store/
 * editor. `resolveStepAgentKey` returns `null` for it.
 *
 * This module is pure (no zod, no Node built-ins) so it imports cleanly in the
 * main process, the renderer, and any test environment.
 */

export const CANONICAL_AGENT_KEYS = [
  'context',
  'research',
  'epics',
  'tasks',
  'dependency-analyzer',
  'implement',
  'code-review',
  'write-tests',
  'task-verify',
  'sprint-verify',
  'visual-verify',
  'sprint-review',
  'compounder',
] as const;

export type CanonicalAgentKey = (typeof CANONICAL_AGENT_KEYS)[number];

export const HUMAN_GATE_AGENT = 'human';

/**
 * Legacy `step.agent` labels (shipped in earlier WORKFLOW_DEFINITIONS) → canonical
 * key. Sources are exactly the verified legacy universe; phantom labels
 * (`visual-verifier`, `test-writer`) are intentionally absent — they never
 * appeared in any shipped definition (see the source-validity unit test).
 *
 * `task-refiner` is intentionally absent here — it is dual-binding (it was the
 * agent on BOTH the `epics` and `tasks` steps), so it is disambiguated by stepId
 * in `resolveStepAgentKey` below.
 */
const LEGACY_BY_LABEL: Readonly<Record<string, string>> = {
  'idea-extractor': 'context',
  researcher: 'research',
  executor: 'implement',
  verifier: 'sprint-verify',
  'code-reviewer': 'sprint-review',
};

/** stepId already equals the canonical key for the ambiguous planner refine steps. */
const STEP_DISAMBIGUATED = new Set(['epics', 'tasks']);

/**
 * Step-aware display + usage resolver: (stepId, label) → canonical key.
 * Returns `null` for the human gate.
 *
 * Old runs are never migrated; their frozen `steps_snapshot_json` resolves at
 * read time. The dual-binding `task-refiner` label disambiguates by stepId
 * (which already equals the canonical key for the `epics`/`tasks` steps).
 */
export function resolveStepAgentKey(stepId: string, label: string): string | null {
  if (label === HUMAN_GATE_AGENT) return null;
  if (label === 'task-refiner' && STEP_DISAMBIGUATED.has(stepId)) return stepId; // epics | tasks
  return LEGACY_BY_LABEL[label] ?? label; // identity for already-canonical labels
}

/**
 * Pure display normalization when only a label is available (no stepId context).
 * Lossy for `task-refiner` (cannot disambiguate epics vs tasks) — display-only.
 */
export function normalizeAgentLabel(label: string): string {
  return LEGACY_BY_LABEL[label] ?? label;
}

export function isCanonicalAgentKey(s: string): s is CanonicalAgentKey {
  return (CANONICAL_AGENT_KEYS as readonly string[]).includes(s);
}
