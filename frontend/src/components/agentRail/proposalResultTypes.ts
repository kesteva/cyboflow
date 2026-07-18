/**
 * proposalResultTypes — local, DEFENSIVE mirrors of the proposal executor's
 * `result_json` shapes (main/src/orchestrator/agentThread/proposalExecutor.ts
 * — `LaunchRunResultJson` / `ReprioritizeResultJson` / `EditWorkflowResultJson`).
 *
 * `AgentProposal.result` is typed `unknown` (shared/types/agentThread.ts) —
 * deliberately, since the executor's typed result interfaces live main-only
 * and this frontend surface must not import from main/. These guards parse
 * `unknown` defensively (never throw, never trust the shape) and MIRROR the
 * executor's fields exactly so the card renders the same data the backend
 * persisted. If the executor's result shape changes, update these by hand —
 * there is no shared source of truth to keep them in lockstep automatically.
 */
import type { WorkflowDefinition } from '../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// launch-run
// ---------------------------------------------------------------------------

export interface LaunchRunCompensationStep {
  step: 'cancel-run' | 'dismiss-session';
  ok: boolean;
  error?: string;
}

export interface LaunchRunResultJson {
  kind: 'launch-run';
  status: 'executed' | 'failed';
  sessionId?: string;
  worktreePath?: string;
  runId?: string;
  branchName?: string;
  error?: string;
  compensations?: LaunchRunCompensationStep[];
  reconciled?: boolean;
  verified?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isCompensationStep(v: unknown): v is LaunchRunCompensationStep {
  if (!isRecord(v)) return false;
  return (v.step === 'cancel-run' || v.step === 'dismiss-session') && typeof v.ok === 'boolean';
}

/** Parse a proposal's `result` as a launch-run result, or null if it doesn't match. */
export function parseLaunchRunResult(result: unknown): LaunchRunResultJson | null {
  if (!isRecord(result) || result.kind !== 'launch-run') return null;
  if (result.status !== 'executed' && result.status !== 'failed') return null;
  const compensations = Array.isArray(result.compensations)
    ? result.compensations.filter(isCompensationStep)
    : undefined;
  return {
    kind: 'launch-run',
    status: result.status,
    sessionId: typeof result.sessionId === 'string' ? result.sessionId : undefined,
    worktreePath: typeof result.worktreePath === 'string' ? result.worktreePath : undefined,
    runId: typeof result.runId === 'string' ? result.runId : undefined,
    branchName: typeof result.branchName === 'string' ? result.branchName : undefined,
    error: typeof result.error === 'string' ? result.error : undefined,
    compensations: compensations && compensations.length > 0 ? compensations : undefined,
    reconciled: typeof result.reconciled === 'boolean' ? result.reconciled : undefined,
    verified: typeof result.verified === 'string' ? result.verified : undefined,
  };
}

// ---------------------------------------------------------------------------
// reprioritize-backlog
// ---------------------------------------------------------------------------

export interface ReprioritizeItemResultJson {
  taskId: string;
  ok: boolean;
  error?: string;
}

export interface ReprioritizeResultJson {
  kind: 'reprioritize-backlog';
  status: 'executed' | 'failed';
  items: ReprioritizeItemResultJson[];
  reconciled?: boolean;
}

function isReprioritizeItemResult(v: unknown): v is ReprioritizeItemResultJson {
  if (!isRecord(v)) return false;
  return typeof v.taskId === 'string' && typeof v.ok === 'boolean';
}

/** Parse a proposal's `result` as a reprioritize-backlog result, or null if it doesn't match. */
export function parseReprioritizeResult(result: unknown): ReprioritizeResultJson | null {
  if (!isRecord(result) || result.kind !== 'reprioritize-backlog') return null;
  if (result.status !== 'executed' && result.status !== 'failed') return null;
  if (!Array.isArray(result.items)) return null;
  return {
    kind: 'reprioritize-backlog',
    status: result.status,
    items: result.items.filter(isReprioritizeItemResult),
    reconciled: typeof result.reconciled === 'boolean' ? result.reconciled : undefined,
  };
}

// ---------------------------------------------------------------------------
// edit-workflow
// ---------------------------------------------------------------------------

const EDIT_WORKFLOW_REASONS = [
  'spec-hash-mismatch',
  'validation-failed',
  'workflow-not-found',
  'missing-precondition',
  'crashed-mid-execution',
] as const;
type EditWorkflowReason = (typeof EDIT_WORKFLOW_REASONS)[number];

function isEditWorkflowReason(v: unknown): v is EditWorkflowReason {
  return typeof v === 'string' && (EDIT_WORKFLOW_REASONS as readonly string[]).includes(v);
}

export interface EditWorkflowResultJson {
  kind: 'edit-workflow';
  status: 'executed' | 'failed' | 'superseded';
  workflowId: string;
  appliedHash?: string;
  expectedHash?: string;
  actualHash?: string;
  reason?: EditWorkflowReason;
  issues?: string[];
  reconciled?: boolean;
}

/** Parse a proposal's `result` as an edit-workflow result, or null if it doesn't match. */
export function parseEditWorkflowResult(result: unknown): EditWorkflowResultJson | null {
  if (!isRecord(result) || result.kind !== 'edit-workflow') return null;
  if (result.status !== 'executed' && result.status !== 'failed' && result.status !== 'superseded') return null;
  if (typeof result.workflowId !== 'string') return null;
  const issues = Array.isArray(result.issues)
    ? result.issues.filter((i): i is string => typeof i === 'string')
    : undefined;
  return {
    kind: 'edit-workflow',
    status: result.status,
    workflowId: result.workflowId,
    appliedHash: typeof result.appliedHash === 'string' ? result.appliedHash : undefined,
    expectedHash: typeof result.expectedHash === 'string' ? result.expectedHash : undefined,
    actualHash: typeof result.actualHash === 'string' ? result.actualHash : undefined,
    reason: isEditWorkflowReason(result.reason) ? result.reason : undefined,
    issues: issues && issues.length > 0 ? issues : undefined,
    reconciled: typeof result.reconciled === 'boolean' ? result.reconciled : undefined,
  };
}

// ---------------------------------------------------------------------------
// edit-workflow — compact definition summary (phase/step counts), parsed from
// the PROPOSED definitionJson (not the result_json) so it renders in the open
// (pre-confirm) card state too. Defensive: malformed JSON/shape -> null, never
// a throw — the card falls back to omitting the summary line.
// ---------------------------------------------------------------------------

export interface WorkflowDefinitionSummary {
  phaseCount: number;
  stepCount: number;
}

function isPhaseArrayLike(v: unknown): v is Array<{ steps?: unknown }> {
  return Array.isArray(v) && v.every((p) => isRecord(p));
}

/** Parse `payload.definitionJson` into phase/step counts — never the whole diff. */
export function parseWorkflowDefinitionSummary(definitionJson: string): WorkflowDefinitionSummary | null {
  let raw: unknown;
  try {
    raw = JSON.parse(definitionJson);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const phases = (raw as Partial<WorkflowDefinition>).phases;
  if (!isPhaseArrayLike(phases)) return null;
  let stepCount = 0;
  for (const phase of phases) {
    if (Array.isArray(phase.steps)) stepCount += phase.steps.length;
  }
  return { phaseCount: phases.length, stepCount };
}
