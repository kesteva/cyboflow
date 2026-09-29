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
  StartQuickSessionProposalPayload,
  TriageFindingItem,
  TriageFindingsProposalPayload,
} from '../../../../shared/types/agentThread';
import { isCyboflowWorkflowName, type CyboflowWorkflowName } from '../../../../shared/types/workflows';
import type { Priority } from '../../../../shared/types/tasks';
import { useState } from 'react';
import { useLandingStore } from '../../stores/landingStore';
import {
  parseWorkflowDefinitionSummary,
  type CreateBacklogResultJson,
  type CreateWorkflowResultJson,
  type LaunchSeedField,
  type ReprioritizeResultJson,
  type TriageFindingsResultJson,
} from './proposalResultTypes';
import { useProposalEntityLabels, type ResolvedProposalEntity, type ResolvedStage } from './useProposalEntityLabels';

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
  'triage-findings': 'triage findings',
  'start-quick-session': 'start quick session',
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

/**
 * Resolve a workflow's display name: the built-in {@link WORKFLOW_LABEL} map
 * when `name` is one of the six built-ins, else the raw name verbatim — a
 * custom workflow (e.g. "speedboat") has no entry in that map but is still a
 * perfectly good label on its own.
 */
export function workflowNameLabel(name: string): string {
  return Object.prototype.hasOwnProperty.call(WORKFLOW_LABEL, name)
    ? WORKFLOW_LABEL[name as CyboflowWorkflowName]
    : name;
}

/** Human label for a launch seed field the flow's shape did not take (TASK-294). */
export const LAUNCH_SEED_FIELD_LABEL: Record<LaunchSeedField, string> = {
  taskIds: 'tasks',
  ideaIds: 'ideas',
  findingIds: 'findings',
};

/**
 * The muted "custom · global|project" tag beside a CUSTOM workflow's name, so
 * a sprint-shaped custom flow named `dash` never passes for the built-in
 * Sprint (TASK-294). A built-in name renders no tag; a custom name whose scope
 * the propose handler did not stamp (an older row) still says "custom".
 */
export function CustomWorkflowTag({ payload }: { payload: LaunchRunProposalPayload }): React.ReactElement | null {
  if (isCyboflowWorkflowName(payload.workflowName)) return null;
  return (
    <span
      className="ml-1.5 align-middle text-[9px] font-normal uppercase tracking-[0.12em] text-text-tertiary"
      data-testid="launch-run-custom-tag"
      data-scope={payload.workflowScope ?? ''}
      title={payload.workflowId}
    >
      custom{payload.workflowScope != null ? ` · ${payload.workflowScope}` : ''}
    </span>
  );
}

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
// Resolved-entity label primitive — shared by launch-run's seed rows and
// reprioritize-backlog's rows. The opaque id is kept ONLY in `title=`/
// `data-id` (tooltip + test hook); an id this hook could not resolve degrades
// to a muted "unresolved" marker rather than a blank cell (TASK-221).
// ---------------------------------------------------------------------------

function EntityRefLabel({
  id,
  entity,
  className = '',
}: {
  id: string;
  entity: ResolvedProposalEntity | undefined;
  className?: string;
}): React.ReactElement {
  if (entity === undefined) {
    return (
      <span
        className={`truncate italic text-text-tertiary ${className}`}
        data-testid="proposal-entity-unresolved"
        data-id={id}
        title={id}
      >
        {id} (unresolved)
      </span>
    );
  }
  if (entity.type === 'finding') {
    return (
      <span className={`truncate text-text-primary ${className}`} data-testid="proposal-entity-label" data-id={id} title={entity.title}>
        {entity.title}
      </span>
    );
  }
  return (
    <span className={`truncate ${className}`} data-testid="proposal-entity-label" data-id={id} title={entity.title}>
      <span className="font-bold text-text-primary">{entity.ref}</span>{' '}
      <span className="text-text-tertiary">{entity.title}</span>
    </span>
  );
}

/** Board-stage badge: a color dot + the stage's label (falls back to the raw stage id, muted, if unresolved). */
function StageBadge({ stageId, stage }: { stageId: string; stage: ResolvedStage | undefined }): React.ReactElement {
  return (
    <span className="flex shrink-0 items-center gap-1 text-text-tertiary" data-testid="reprioritize-stage" title={stageId}>
      &rarr;
      {stage ? (
        <>
          <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: stage.colorOklch }} />
          {stage.label}
        </>
      ) : (
        <span className="italic" data-testid="proposal-stage-unresolved">
          {stageId} (unresolved)
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// launch-run
// ---------------------------------------------------------------------------

export function LaunchRunBody({ payload }: { payload: LaunchRunProposalPayload }): React.ReactElement {
  const projectName = useProjectName(payload.projectId);
  const seedGroups: { label: string; ids: string[] }[] = [
    { label: 'tasks', ids: payload.taskIds ?? [] },
    { label: 'ideas', ids: payload.ideaIds ?? [] },
    { label: 'findings', ids: payload.findingIds ?? [] },
  ].filter((r) => r.ids.length > 0);
  const allSeedIds = [...(payload.taskIds ?? []), ...(payload.ideaIds ?? []), ...(payload.findingIds ?? [])];
  // Scoped to the proposal's own project — a seed id from another project
  // must degrade to the muted unresolved marker, not resolve (TASK-221).
  const { entities } = useProposalEntityLabels(allSeedIds, payload.projectId);

  return (
    <div className="flex flex-col gap-2 text-[11px]" data-testid="proposal-body-launch-run">
      <div className="text-[13px] font-bold text-text-primary">
        Launch {workflowNameLabel(payload.workflowName)}
        <CustomWorkflowTag payload={payload} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Row label="project" value={projectName} />
        <Row label="substrate" value={payload.substrate ?? 'sdk (default)'} />
        {seedGroups.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5" data-testid="launch-run-seed-group" data-seed-kind={group.label}>
            <span className="text-text-tertiary">{group.label}</span>
            <div className="flex flex-col gap-0.5 pl-2">
              {group.ids.map((id) => (
                <EntityRefLabel key={id} id={id} entity={entities.get(id)} />
              ))}
            </div>
          </div>
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

/** One rendered reprioritize row, at a given tree depth (0 = top level, 1 = nested under its epic). */
interface ReprioritizeRowPlan {
  item: ReprioritizeBacklogItem;
  depth: number;
}

/**
 * Order `items` into a flat render plan that nests a task under its parent
 * epic when BOTH are present in the same payload — so a batch touching an
 * epic and its children reads as a tree (EPIC-033 -> 3 tasks) instead of a
 * flat list of unrelated-looking rows. An item whose parent epic is NOT also
 * in this payload stays exactly where it was (nothing to group against).
 */
function planReprioritizeRows(
  items: ReprioritizeBacklogItem[],
  entities: Map<string, ResolvedProposalEntity>,
): ReprioritizeRowPlan[] {
  const idSet = new Set(items.map((i) => i.taskId));
  const childrenByEpic = new Map<string, ReprioritizeBacklogItem[]>();
  for (const item of items) {
    const parentEpicId = entities.get(item.taskId)?.parentEpicId;
    if (parentEpicId != null && idSet.has(parentEpicId)) {
      const bucket = childrenByEpic.get(parentEpicId) ?? [];
      bucket.push(item);
      childrenByEpic.set(parentEpicId, bucket);
    }
  }
  const nested = new Set(
    [...childrenByEpic.values()].flatMap((children) => children.map((c) => c.taskId)),
  );
  const plan: ReprioritizeRowPlan[] = [];
  for (const item of items) {
    if (nested.has(item.taskId)) continue; // rendered under its epic below, not at top level
    plan.push({ item, depth: 0 });
    for (const child of childrenByEpic.get(item.taskId) ?? []) {
      plan.push({ item: child, depth: 1 });
    }
  }
  return plan;
}

export function ReprioritizeBacklogRows({
  projectId,
  items,
  result,
}: {
  /** The proposal's project — task AND stage lookups are scoped to it. */
  projectId: number;
  items: ReprioritizeBacklogItem[];
  result: ReprioritizeResultJson | null;
}): React.ReactElement {
  const { entities, stages } = useProposalEntityLabels(items.map((i) => i.taskId), projectId);
  const plan = planReprioritizeRows(items, entities);
  return (
    <div className="flex flex-col gap-1.5 text-[11px]" data-testid="proposal-body-reprioritize">
      {plan.map(({ item, depth }, index) => {
        const outcome = itemResult(result, item.taskId);
        const glyph = item.priority != null ? priorityGlyph(item.priority) : null;
        return (
          <div
            key={item.taskId}
            className="flex items-baseline gap-2"
            data-testid="reprioritize-row"
            data-task-id={item.taskId}
            data-depth={depth}
            style={depth > 0 ? { marginLeft: '1.25rem' } : undefined}
          >
            <span className="w-4 shrink-0 text-right font-bold text-interactive">{index + 1}</span>
            <EntityRefLabel id={item.taskId} entity={entities.get(item.taskId)} className="flex-1" />
            {item.priority != null && glyph && (
              <span className={`shrink-0 ${glyph.className}`} data-testid="reprioritize-priority">
                {item.priority} {glyph.glyph}
              </span>
            )}
            {item.stageId != null && <StageBadge stageId={item.stageId} stage={stages.get(item.stageId)} />}
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
      <ReprioritizeBacklogRows projectId={payload.projectId} items={payload.items} result={null} />
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
// start-quick-session
// ---------------------------------------------------------------------------

/** How many brief lines the collapsed card shows before the disclosure. */
export const BRIEF_PREVIEW_LINES = 6;

/**
 * The brief, first {@link BRIEF_PREVIEW_LINES} lines visible, the rest behind
 * a disclosure. Preformatted (the brief is what the session agent will read
 * verbatim — ids, paths and line breaks matter), never re-flowed.
 */
export function BriefBlock({ brief }: { brief: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const lines = brief.split('\n');
  const truncated = lines.length > BRIEF_PREVIEW_LINES;
  const shown = open || !truncated ? brief : lines.slice(0, BRIEF_PREVIEW_LINES).join('\n');
  return (
    <div className="flex flex-col gap-1" data-testid="quick-session-brief" data-expanded={String(open)}>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border border-border-primary bg-surface-secondary p-2 font-mono text-[10.5px] leading-snug text-text-primary">
        {shown}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="self-start text-[10px] text-text-tertiary hover:text-text-primary"
          data-testid="quick-session-brief-toggle"
        >
          {open ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

export function StartQuickSessionBody({ payload }: { payload: StartQuickSessionProposalPayload }): React.ReactElement {
  const projectName = useProjectName(payload.projectId);
  return (
    <div className="flex flex-col gap-2 text-[11px]" data-testid="proposal-body-start-quick-session">
      <div className="text-[13px] font-bold text-text-primary">Start quick session</div>
      <div className="flex flex-col gap-1.5">
        <Row label="project" value={projectName} />
        <Row label="session" value={payload.name ?? 'auto-named'} />
        <Row label="substrate" value={payload.substrate ?? 'project default'} />
        <Row label="workspace" value={payload.inPlace === true ? 'project checkout (in place)' : 'own worktree'} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-text-tertiary">brief — the session's first prompt</span>
        <BriefBlock brief={payload.brief} />
      </div>
      {payload.note != null && payload.note !== '' && <p className="italic text-text-tertiary">{payload.note}</p>}
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

// ---------------------------------------------------------------------------
// triage-findings — grouped by op ("Dismiss 41 · Resolve 3 · Stage for
// Compound 12"), each group expandable to its titles, never one row per item
// (TASK-292): a 56-item sweep is one human decision per GROUP, so that is
// what the card foregrounds.
// ---------------------------------------------------------------------------

/**
 * The five decision groups a triage batch splits into. `set-selected` is
 * split on its target state because "tick as a Compound seed" and "untick"
 * are opposite decisions that happen to share an op.
 */
export type TriageGroupKey = 'dismiss' | 'resolve' | 'approve' | 'select' | 'deselect';

export const TRIAGE_GROUP_LABEL: Record<TriageGroupKey, string> = {
  dismiss: 'Dismiss',
  resolve: 'Resolve',
  approve: 'Stage for Compound',
  select: 'Select for Compound',
  deselect: 'Deselect',
};

const TRIAGE_GROUP_ORDER: readonly TriageGroupKey[] = ['dismiss', 'resolve', 'approve', 'select', 'deselect'];

export function triageGroupKey(item: TriageFindingItem): TriageGroupKey {
  if (item.op === 'set-selected') return item.selected === true ? 'select' : 'deselect';
  return item.op;
}

/** Split a batch into its non-empty groups, in a fixed display order. */
export function groupTriageItems(items: TriageFindingItem[]): Array<{ key: TriageGroupKey; items: TriageFindingItem[] }> {
  const buckets = new Map<TriageGroupKey, TriageFindingItem[]>();
  for (const item of items) {
    const key = triageGroupKey(item);
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  return TRIAGE_GROUP_ORDER.filter((key) => buckets.has(key)).map((key) => ({ key, items: buckets.get(key) ?? [] }));
}

function triageItemResult(
  result: TriageFindingsResultJson | null,
  reviewItemId: string,
): { ok: boolean; skipped?: string; error?: string } | null {
  if (result === null) return null;
  const found = result.items.find((i) => i.reviewItemId === reviewItemId);
  return found ? { ok: found.ok, skipped: found.skipped, error: found.error } : null;
}

/**
 * One expandable group: "Dismiss · 41" with a per-group ✓/skip/✕ tally once
 * resolved, and the finding titles (stamped server-side at propose time)
 * behind a disclosure. Collapsed by default — the counts ARE the summary.
 */
function TriageGroup({
  groupKey,
  items,
  result,
}: {
  groupKey: TriageGroupKey;
  items: TriageFindingItem[];
  result: TriageFindingsResultJson | null;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const outcomes = items.map((item) => triageItemResult(result, item.reviewItemId));
  const okCount = outcomes.filter((o) => o?.ok === true).length;
  const skippedCount = outcomes.filter((o) => o != null && !o.ok && o.skipped != null).length;
  const failedCount = outcomes.filter((o) => o != null && !o.ok && o.skipped == null).length;
  return (
    <div className="flex flex-col gap-1" data-testid="triage-group" data-group={groupKey}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-baseline gap-2 text-left hover:text-text-primary"
        data-testid="triage-group-toggle"
      >
        <span className="w-3 shrink-0 text-[9px] text-text-tertiary" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="font-bold text-text-primary">{TRIAGE_GROUP_LABEL[groupKey]}</span>
        <span className="text-text-tertiary" data-testid="triage-group-count">
          {items.length}
        </span>
        {result !== null && (
          <span className="ml-auto shrink-0 text-[10px]" data-testid="triage-group-outcome">
            {okCount > 0 && <span className="text-status-success">✓ {okCount}</span>}
            {skippedCount > 0 && <span className="ml-1.5 text-text-tertiary">skipped {skippedCount}</span>}
            {failedCount > 0 && <span className="ml-1.5 text-status-error">✕ {failedCount}</span>}
          </span>
        )}
      </button>
      {open && (
        <ul className="ml-5 flex flex-col gap-0.5" data-testid="triage-group-items">
          {items.map((item, index) => {
            const outcome = outcomes[index];
            return (
              <li key={item.reviewItemId} className="flex items-baseline gap-2" data-testid="triage-row" data-review-item-id={item.reviewItemId}>
                <span className="flex-1 truncate text-text-primary" title={item.reviewItemId}>
                  {item.title != null && item.title !== '' ? item.title : item.reviewItemId}
                </span>
                {item.resolution != null && item.resolution !== '' && (
                  <span className="shrink-0 truncate italic text-text-tertiary" title={item.resolution}>
                    {item.resolution}
                  </span>
                )}
                {outcome !== null && (
                  <span
                    className={`shrink-0 font-bold ${outcome.ok ? 'text-status-success' : outcome.skipped != null ? 'text-text-tertiary' : 'text-status-error'}`}
                    data-testid="triage-outcome"
                    data-ok={String(outcome.ok)}
                    title={outcome.error ?? outcome.skipped}
                  >
                    {outcome.ok ? '✓' : outcome.skipped != null ? 'skipped' : '✕'}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Shared by the OPEN and RESOLVED paths, mirroring {@link CreateBacklogRows}. */
export function TriageFindingsGroups({
  items,
  result,
}: {
  items: TriageFindingItem[];
  result: TriageFindingsResultJson | null;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5 text-[11px]" data-testid="proposal-body-triage-findings">
      {groupTriageItems(items).map((group) => (
        <TriageGroup key={group.key} groupKey={group.key} items={group.items} result={result} />
      ))}
    </div>
  );
}

/** The one-line "Dismiss 41 · Resolve 3 · Stage for Compound 12" headline. */
export function triageHeadline(items: TriageFindingItem[]): string {
  return groupTriageItems(items)
    .map((group) => `${TRIAGE_GROUP_LABEL[group.key]} ${group.items.length}`)
    .join(' · ');
}

export function TriageFindingsBody({ payload }: { payload: TriageFindingsProposalPayload }): React.ReactElement {
  const projectName = useProjectName(payload.projectId);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[13px] font-bold text-text-primary" data-testid="triage-headline">
        {payload.summary != null && payload.summary !== '' ? payload.summary : triageHeadline(payload.items)}
      </div>
      <div className="text-[10px] text-text-tertiary">
        {projectName}
        {payload.summary != null && payload.summary !== '' ? ` · ${triageHeadline(payload.items)}` : ''}
      </div>
      <TriageFindingsGroups items={payload.items} result={null} />
    </div>
  );
}
