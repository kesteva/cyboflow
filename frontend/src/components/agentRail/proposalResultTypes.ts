/**
 * proposalResultTypes — local, DEFENSIVE mirrors of the proposal executor's
 * `result_json` shapes (main/src/orchestrator/agentThread/proposalExecutor.ts
 * — `LaunchRunResultJson` / `ReprioritizeResultJson` / `EditWorkflowResultJson` /
 * `CreateBacklogResultJson` / `CreateWorkflowResultJson` / `TriageFindingsResultJson`).
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
import { isTriageFindingOp, type TriageFindingOp } from '../../../../shared/types/agentThread';

// ---------------------------------------------------------------------------
// launch-run
// ---------------------------------------------------------------------------

export interface LaunchRunCompensationStep {
  step: 'cancel-run' | 'dismiss-session';
  ok: boolean;
  error?: string;
}

/** The three launch seed fields a proposal may carry (mirrors the executor's LaunchSeedField). */
export type LaunchSeedField = 'taskIds' | 'ideaIds' | 'findingIds';

export interface LaunchRunResultJson {
  kind: 'launch-run';
  status: 'executed' | 'failed';
  sessionId?: string;
  worktreePath?: string;
  runId?: string;
  branchName?: string;
  /** Seed fields the launched flow's shape did not take — dropped before launch (TASK-294). */
  ignoredSeeds?: LaunchSeedField[];
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

function isLaunchSeedField(v: unknown): v is LaunchSeedField {
  return v === 'taskIds' || v === 'ideaIds' || v === 'findingIds';
}

/** Parse a proposal's `result` as a launch-run result, or null if it doesn't match. */
export function parseLaunchRunResult(result: unknown): LaunchRunResultJson | null {
  if (!isRecord(result) || result.kind !== 'launch-run') return null;
  if (result.status !== 'executed' && result.status !== 'failed') return null;
  const compensations = Array.isArray(result.compensations)
    ? result.compensations.filter(isCompensationStep)
    : undefined;
  const ignoredSeeds = Array.isArray(result.ignoredSeeds) ? result.ignoredSeeds.filter(isLaunchSeedField) : undefined;
  return {
    kind: 'launch-run',
    status: result.status,
    sessionId: typeof result.sessionId === 'string' ? result.sessionId : undefined,
    worktreePath: typeof result.worktreePath === 'string' ? result.worktreePath : undefined,
    runId: typeof result.runId === 'string' ? result.runId : undefined,
    branchName: typeof result.branchName === 'string' ? result.branchName : undefined,
    ignoredSeeds: ignoredSeeds && ignoredSeeds.length > 0 ? ignoredSeeds : undefined,
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

// ---------------------------------------------------------------------------
// create-backlog-items
// ---------------------------------------------------------------------------

export interface CreateBacklogItemResultJson {
  index: number;
  title: string;
  taskType: 'idea' | 'epic' | 'task';
  ok: boolean;
  taskId?: string;
  ref?: string;
  error?: string;
}

export interface CreateBacklogResultJson {
  kind: 'create-backlog-items';
  status: 'executed' | 'failed';
  items: CreateBacklogItemResultJson[];
  reconciled?: boolean;
}

function isCreateBacklogItemResult(v: unknown): v is CreateBacklogItemResultJson {
  if (!isRecord(v)) return false;
  return (
    typeof v.index === 'number' &&
    typeof v.title === 'string' &&
    (v.taskType === 'idea' || v.taskType === 'epic' || v.taskType === 'task') &&
    typeof v.ok === 'boolean'
  );
}

/** Parse a proposal's `result` as a create-backlog-items result, or null if it doesn't match. */
export function parseCreateBacklogResult(result: unknown): CreateBacklogResultJson | null {
  if (!isRecord(result) || result.kind !== 'create-backlog-items') return null;
  if (result.status !== 'executed' && result.status !== 'failed') return null;
  if (!Array.isArray(result.items)) return null;
  return {
    kind: 'create-backlog-items',
    status: result.status,
    items: result.items.filter(isCreateBacklogItemResult),
    reconciled: typeof result.reconciled === 'boolean' ? result.reconciled : undefined,
  };
}

// ---------------------------------------------------------------------------
// create-workflow
// ---------------------------------------------------------------------------

export interface CreateWorkflowAgentResultJson {
  index: number;
  name: string;
  ok: boolean;
  agentKey?: string;
  error?: string;
}

export interface CreateWorkflowCompensationJson {
  agentKey: string;
  ok: boolean;
  error?: string;
}

export interface CreateWorkflowResultJson {
  kind: 'create-workflow';
  status: 'executed' | 'failed';
  name: string;
  workflowId?: string;
  agents: CreateWorkflowAgentResultJson[];
  error?: string;
  compensations?: CreateWorkflowCompensationJson[];
  reconciled?: boolean;
}

function isCreateWorkflowAgentResult(v: unknown): v is CreateWorkflowAgentResultJson {
  if (!isRecord(v)) return false;
  return typeof v.index === 'number' && typeof v.name === 'string' && typeof v.ok === 'boolean';
}

function isCreateWorkflowCompensation(v: unknown): v is CreateWorkflowCompensationJson {
  if (!isRecord(v)) return false;
  return typeof v.agentKey === 'string' && typeof v.ok === 'boolean';
}

/** Parse a proposal's `result` as a create-workflow result, or null if it doesn't match. */
export function parseCreateWorkflowResult(result: unknown): CreateWorkflowResultJson | null {
  if (!isRecord(result) || result.kind !== 'create-workflow') return null;
  if (result.status !== 'executed' && result.status !== 'failed') return null;
  if (typeof result.name !== 'string') return null;
  if (!Array.isArray(result.agents)) return null;
  const compensations = Array.isArray(result.compensations)
    ? result.compensations.filter(isCreateWorkflowCompensation)
    : undefined;
  return {
    kind: 'create-workflow',
    status: result.status,
    name: result.name,
    workflowId: typeof result.workflowId === 'string' ? result.workflowId : undefined,
    agents: result.agents.filter(isCreateWorkflowAgentResult),
    error: typeof result.error === 'string' ? result.error : undefined,
    compensations: compensations && compensations.length > 0 ? compensations : undefined,
    reconciled: typeof result.reconciled === 'boolean' ? result.reconciled : undefined,
  };
}

// ---------------------------------------------------------------------------
// triage-findings
// ---------------------------------------------------------------------------

export interface TriageFindingItemResultJson {
  reviewItemId: string;
  op: TriageFindingOp;
  ok: boolean;
  /** Present when the row was skipped as superseded (someone else triaged it first). */
  skipped?: string;
  error?: string;
}

export interface TriageFindingsResultJson {
  kind: 'triage-findings';
  status: 'executed' | 'failed';
  items: TriageFindingItemResultJson[];
  applied: number;
  skipped: number;
  reconciled?: boolean;
}

function isTriageFindingItemResult(v: unknown): v is TriageFindingItemResultJson {
  if (!isRecord(v)) return false;
  return typeof v.reviewItemId === 'string' && isTriageFindingOp(v.op) && typeof v.ok === 'boolean';
}

/** Parse a proposal's `result` as a triage-findings result, or null if it doesn't match. */
export function parseTriageFindingsResult(result: unknown): TriageFindingsResultJson | null {
  if (!isRecord(result) || result.kind !== 'triage-findings') return null;
  if (result.status !== 'executed' && result.status !== 'failed') return null;
  if (!Array.isArray(result.items)) return null;
  const items = result.items.filter(isTriageFindingItemResult);
  return {
    kind: 'triage-findings',
    status: result.status,
    items,
    // Derived from the rows when the counts are missing, so an older/partial
    // result still renders "applied N · skipped M" truthfully.
    applied: typeof result.applied === 'number' ? result.applied : items.filter((i) => i.ok).length,
    skipped: typeof result.skipped === 'number' ? result.skipped : items.filter((i) => i.skipped != null).length,
    reconciled: typeof result.reconciled === 'boolean' ? result.reconciled : undefined,
  };
}
