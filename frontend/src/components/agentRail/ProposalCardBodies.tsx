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
  LaunchRunProposalPayload,
  ReprioritizeBacklogItem,
  ReprioritizeBacklogProposalPayload,
  EditWorkflowProposalPayload,
  OpenSessionProposalPayload,
} from '../../../../shared/types/agentThread';
import type { CyboflowWorkflowName } from '../../../../shared/types/workflows';
import type { Priority } from '../../../../shared/types/tasks';
import { useLandingStore } from '../../stores/landingStore';
import { parseWorkflowDefinitionSummary, type ReprioritizeResultJson } from './proposalResultTypes';

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
};

const WORKFLOW_LABEL: Record<CyboflowWorkflowName, string> = {
  planner: 'Planner',
  sprint: 'Sprint',
  compound: 'Compound',
  ship: 'Ship',
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
 * is deliberately NOT a before/after delta — it reads P0 as "promoted" (green
 * up), P1 as neutral, P2 as "lowered" (muted down), mirroring the packet's
 * green-up / muted-down/neutral color split without fabricating data the
 * payload doesn't have.
 */
export function priorityGlyph(priority: Priority): { glyph: string; className: string } {
  switch (priority) {
    case 'P0':
      return { glyph: '↑', className: 'text-status-success' }; // ↑
    case 'P2':
      return { glyph: '↓', className: 'text-text-tertiary' }; // ↓
    case 'P1':
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
