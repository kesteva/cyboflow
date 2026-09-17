/**
 * ProposalCardBodies — per-kind informational content for a proposal card
 * (S1.3). {@link ProposalCard} owns the shared chrome (dark head bar / needs-
 * confirm badge / Confirm+Dismiss footer / resolved-row collapse); these
 * components render only the kind-specific body, per the design packet's card
 * anatomy (docs/proposals/GLOBAL-AGENT-PLAN.md §3 S1.3 and the
 * "Action Cards.dc.html" handoff bundle).
 *
 * `ReprioritizeBacklogRows` is shared between the OPEN (pre-confirm) and
 * RESOLVED (post-confirm) render paths — it optionally takes the executor's
 * per-item result so a resolved reprioritize card keeps the ranked rows
 * visible with a ✓/✕ overlay instead of collapsing to one opaque line, per the
 * brief's explicit ask for per-row partial-failure visibility.
 */
import type {
  AgentProposalKind,
  CreateBacklogItem,
  CreateBacklogItemsProposalPayload,
  CreateWorkflowAgent,
  CreateWorkflowProposalPayload,
  LaunchRunProposalPayload,
  ReprioritizeBacklogItem,
  ReprioritizeBacklogProposalPayload,
  EditWorkflowProposalPayload,
  OpenSessionProposalPayload,
} from '../../../../shared/types/agentThread';
import type { CyboflowWorkflowName } from '../../../../shared/types/workflows';
import type { Priority } from '../../../../shared/types/tasks';
import { useLandingStore } from '../../stores/landingStore';
import {
  parseWorkflowDefinitionSummary,
  type CreateBacklogResultJson,
  type CreateWorkflowResultJson,
  type ReprioritizeResultJson,
} from './proposalResultTypes';

// ---------------------------------------------------------------------------
// Label maps — keyed on the shared-type discriminant so a new kind/workflow
// breaks these at compile time (docs/CODE-PATTERNS.md "Label maps for
// shared-type discriminants").
// ---------------------------------------------------------------------------

export const PROPOSAL_KIND_LABEL: Record<AgentProposalKind, string> = {
  'launch-run': 'launch run',
  'reprioritize-backlog': 'reprioritize backlog',
  'edit-workflow': 'edit workflow',
  'open-session': 'open session',
  'create-backlog-items': 'add to backlog',
  'create-workflow': 'create workflow',
};

const ENTITY_TYPE_LABEL: Record<CreateBacklogItem['taskType'], string> = {
  idea: 'Idea',
  epic: 'Epic',
  task: 'Task',
};

const WORKFLOW_LABEL: Record<CyboflowWorkflowName, string> = {
  launch: 'Launch',
  planner: 'Planner',
  sprint: 'Sprint',
  compound: 'Compound',
  ship: 'Ship',
  'verify-setup': 'Verify Setup',
};

// ---------------------------------------------------------------------------
// Small shared row primitive
// ---------------------------------------------------------------------------

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex justify-between gap-3">
      <span className="shrink-0 text-text-tertiary">{label}</span>
      <span className="truncate text-right text-text-primary" title={value}>
        {value}
      </span>
    </div>
  );
}

function useProjectName(projectId: number): string {
  return useLandingStore(
    (s) => s.projects.find((p) => p.id === projectId)?.name ?? `Project #${projectId}`,
  );
}

// ---------------------------------------------------------------------------
// launch-run
// ---------------------------------------------------------------------------

export function LaunchRunBody({ payload }: { payload: LaunchRunProposalPayload }): React.ReactElement {
  const projectName = useProjectName(payload.projectId);
  const seedRows: { label: string; ids: string[] }[] = [
    { label: 'tasks', ids: payload.taskIds ?? [] },
    { label: 'ideas', ids: payload.ideaIds ?? [] },
    { label: 'findings', ids: payload.findingIds ?? [] },
  ].filter((r) => r.ids.length > 0);

  return (
    <div className="flex flex-col gap-2 text-[11px]" data-testid="proposal-body-launch-run">
      <div className="text-[13px] font-bold text-text-primary">
        Launch {WORKFLOW_LABEL[payload.workflowName]}
      </div>
      <div className="flex flex-col gap-1">
        <Row label="project" value={projectName} />
        <Row label="substrate" value={payload.substrate ?? 'sdk (default)'} />
        {seedRows.map((r) => (
          <Row key={r.label} label={r.label} value={r.ids.join(', ')} />
        ))}
      </div>
      {payload.note != null && payload.note !== '' && (
        <p className="italic text-text-tertiary">{payload.note}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// reprioritize-backlog
// ---------------------------------------------------------------------------

/**
 * Absolute-urgency glyph for a target priority. The payload carries no PRIOR
 * priority to diff against (`ReprioritizeBacklogItem` is target-only), so this
 * is deliberately NOT a before/after delta — it reads a target against three
 * bands on the 7-level P0-P6 scale (migration 117 widen): P0-P1 "promoted"
 * (green up), P2-P3 neutral, P4-P6 "lowered" (muted down), mirroring the
 * packet's green-up / muted-down/neutral color split without fabricating data
 * the payload doesn't have.
 */
export function priorityGlyph(priority: Priority): { glyph: string; className: string } {
  switch (priority) {
    case 'P0':
    case 'P1':
      return { glyph: '↑', className: 'text-status-success' }; // ↑
    case 'P4':
    case 'P5':
    case 'P6':
      return { glyph: '↓', className: 'text-text-tertiary' }; // ↓
    case 'P2':
    case 'P3':
    default:
      return { glyph: '—', className: 'text-text-tertiary' }; // —
  }
}

function itemResult(
  result: ReprioritizeResultJson | null,
  taskId: string,
): { ok: boolean; error?: string } | null {
  if (result === null) return null;
  const found = result.items.find((i) => i.taskId === taskId);
  return found ? { ok: found.ok, error: found.error } : null;
}

export function ReprioritizeBacklogRows({
  items,
  result,
}: {
  items: ReprioritizeBacklogItem[];
  result: ReprioritizeResultJson | null;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5 text-[11px]" data-testid="proposal-body-reprioritize">
      {items.map((item, index) => {
        const outcome = itemResult(result, item.taskId);
        const glyph = item.priority != null ? priorityGlyph(item.priority) : null;
        return (
          <div key={item.taskId} className="flex items-baseline gap-2" data-testid="reprioritize-row" data-task-id={item.taskId}>
            <span className="w-4 shrink-0 text-right font-bold text-interactive">{index + 1}</span>
            <span className="flex-1 truncate text-text-primary" title={item.taskId}>
              {item.taskId}
            </span>
            {item.priority != null && glyph && (
              <span className={`shrink-0 ${glyph.className}`} data-testid="reprioritize-priority">
                {item.priority} {glyph.glyph}
              </span>
            )}
            {item.stageId != null && (
              <span className="shrink-0 text-text-tertiary" data-testid="reprioritize-stage">
                &rarr; {item.stageId}
              </span>
            )}
            {outcome !== null && (
              <span
                className={`shrink-0 font-bold ${outcome.ok ? 'text-status-success' : 'text-status-error'}`}
                data-testid="reprioritize-outcome"
                data-ok={String(outcome.ok)}
                title={outcome.error}
              >
                {outcome.ok ? '✓' : '✕'}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ReprioritizeBacklogBody({
  payload,
}: {
  payload: ReprioritizeBacklogProposalPayload;
}): React.ReactElement {
  const projectName = useProjectName(payload.projectId);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[13px] font-bold text-text-primary">Reprioritize backlog</div>
      <div className="text-[10px] text-text-tertiary">{projectName}</div>
      <ReprioritizeBacklogRows items={payload.items} result={null} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// edit-workflow
// ---------------------------------------------------------------------------

export function EditWorkflowBody({ payload }: { payload: EditWorkflowProposalPayload }): React.ReactElement {
  const summary = parseWorkflowDefinitionSummary(payload.definitionJson);
  return (
    <div className="flex flex-col gap-2 text-[11px]" data-testid="proposal-body-edit-workflow">
      <div className="text-[13px] font-bold text-text-primary">
        {payload.summary != null && payload.summary !== '' ? payload.summary : 'Update workflow definition'}
      </div>
      <Row label="workflow" value={payload.workflowId} />
      {summary && (
        <Row
          label="definition"
          value={`${summary.phaseCount} phase${summary.phaseCount === 1 ? '' : 's'} · ${summary.stepCount} step${summary.stepCount === 1 ? '' : 's'}`}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// open-session
// ---------------------------------------------------------------------------

export function OpenSessionBody({ payload }: { payload: OpenSessionProposalPayload }): React.ReactElement {
  const nav = payload.navigation;
  return (
    <div className="flex flex-col gap-2 text-[11px]" data-testid="proposal-body-open-session">
      <div className="text-[13px] font-bold text-text-primary">
        Open {nav.target === 'run' ? 'flow run' : 'quick session'}
      </div>
      <Row label={nav.target === 'run' ? 'run' : 'session'} value={nav.target === 'run' ? nav.runId : nav.sessionId} />
      <p className="text-text-tertiary">Read-only navigation — no state changes on confirm.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// create-backlog-items
// ---------------------------------------------------------------------------

function createdItemResult(
  result: CreateBacklogResultJson | null,
  index: number,
): { ok: boolean; ref?: string; error?: string } | null {
  if (result === null) return null;
  const found = result.items.find((i) => i.index === index);
  return found ? { ok: found.ok, ref: found.ref, error: found.error } : null;
}

/**
 * Shared by the OPEN (pre-confirm) and RESOLVED (post-confirm) paths, mirroring
 * {@link ReprioritizeBacklogRows}: a resolved create keeps every proposed row
 * visible with a ✓/✕ (and the minted ref on success) rather than collapsing to
 * one opaque line — a partially-applied batch is exactly the case the human
 * needs itemized.
 */
export function CreateBacklogRows({
  items,
  result,
}: {
  items: CreateBacklogItem[];
  result: CreateBacklogResultJson | null;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5 text-[11px]" data-testid="proposal-body-create-backlog">
      {items.map((item, index) => {
        const outcome = createdItemResult(result, index);
        return (
          <div
            key={`${index}-${item.title}`}
            className="flex items-baseline gap-2"
            data-testid="create-backlog-row"
            data-task-type={item.taskType}
          >
            <span className="w-8 shrink-0 text-[9px] uppercase tracking-[0.1em] text-text-tertiary">
              {ENTITY_TYPE_LABEL[item.taskType]}
            </span>
            <span className="flex-1 truncate text-text-primary" title={item.title}>
              {item.title}
            </span>
            {item.priority != null && (
              <span className="shrink-0 text-text-tertiary" data-testid="create-backlog-priority">
                {item.priority}
              </span>
            )}
            {outcome?.ref != null && (
              <span className="shrink-0 font-bold text-text-secondary" data-testid="create-backlog-ref">
                {outcome.ref}
              </span>
            )}
            {outcome !== null && (
              <span
                className={`shrink-0 font-bold ${outcome.ok ? 'text-status-success' : 'text-status-error'}`}
                data-testid="create-backlog-outcome"
                data-ok={String(outcome.ok)}
                title={outcome.error}
              >
                {outcome.ok ? '✓' : '✕'}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function CreateBacklogItemsBody({
  payload,
}: {
  payload: CreateBacklogItemsProposalPayload;
}): React.ReactElement {
  const projectName = useProjectName(payload.projectId);
  const total = payload.items.length;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[13px] font-bold text-text-primary">
        Add {total} item{total === 1 ? '' : 's'} to the backlog
      </div>
      <div className="text-[10px] text-text-tertiary">{projectName}</div>
      <CreateBacklogRows items={payload.items} result={null} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// create-workflow
// ---------------------------------------------------------------------------

function createdAgentResult(
  result: CreateWorkflowResultJson | null,
  index: number,
): { ok: boolean; agentKey?: string; error?: string } | null {
  if (result === null) return null;
  const found = result.agents.find((a) => a.index === index);
  return found ? { ok: found.ok, agentKey: found.agentKey, error: found.error } : null;
}

/**
 * Shared by the OPEN and RESOLVED paths, mirroring {@link CreateBacklogRows}:
 * one row per agent the proposal mints, with its derived key and tools, and —
 * once resolved — a ✓/✕ per row so a confirm that died on agent 2 of 3 reads
 * as exactly that.
 */
export function CreateWorkflowAgentRows({
  agents,
  result,
}: {
  agents: CreateWorkflowAgent[];
  result: CreateWorkflowResultJson | null;
}): React.ReactElement | null {
  if (agents.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 text-[11px]" data-testid="proposal-body-create-workflow-agents">
      {agents.map((agent, index) => {
        const outcome = createdAgentResult(result, index);
        return (
          <div key={`${index}-${agent.name}`} className="flex items-baseline gap-2" data-testid="create-workflow-agent-row">
            <span className="w-8 shrink-0 text-[9px] uppercase tracking-[0.1em] text-text-tertiary">Agent</span>
            <span className="flex-1 truncate text-text-primary" title={agent.description}>
              {agent.name}
            </span>
            <span className="shrink-0 text-text-tertiary" data-testid="create-workflow-agent-tools">
              {agent.tools.join(' · ')}
            </span>
            {outcome?.agentKey != null && (
              <span className="shrink-0 font-mono text-text-secondary" data-testid="create-workflow-agent-key">
                {outcome.agentKey}
              </span>
            )}
            {outcome !== null && (
              <span
                className={`shrink-0 font-bold ${outcome.ok ? 'text-status-success' : 'text-status-error'}`}
                data-testid="create-workflow-agent-outcome"
                data-ok={String(outcome.ok)}
                title={outcome.error}
              >
                {outcome.ok ? '✓' : '✕'}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function CreateWorkflowBody({ payload }: { payload: CreateWorkflowProposalPayload }): React.ReactElement {
  const projectName = useProjectName(payload.projectId);
  const summary = parseWorkflowDefinitionSummary(payload.definitionJson);
  const agents = payload.agents ?? [];
  return (
    <div className="flex flex-col gap-2 text-[11px]" data-testid="proposal-body-create-workflow">
      <div className="text-[13px] font-bold text-text-primary">
        {payload.summary != null && payload.summary !== '' ? payload.summary : `Create workflow "${payload.name}"`}
      </div>
      <div className="text-[10px] text-text-tertiary">
        {payload.scope === 'global' ? 'Global — every project' : projectName}
      </div>
      <Row label="name" value={payload.name} />
      {summary && (
        <Row
          label="definition"
          value={`${summary.phaseCount} phase${summary.phaseCount === 1 ? '' : 's'} · ${summary.stepCount} step${summary.stepCount === 1 ? '' : 's'}`}
        />
      )}
      {payload.permissionMode != null && <Row label="permissions" value={payload.permissionMode} />}
      {agents.length > 0 && (
        <Row label="new agents" value={`${agents.length} agent${agents.length === 1 ? '' : 's'}`} />
      )}
      <CreateWorkflowAgentRows agents={agents} result={null} />
    </div>
  );
}
