/**
 * WorkingSection — the accent band: agents that are running and need nothing.
 *
 * Deliberately the calmest section on the page. Rows are ONE LINE, the only
 * motion is the pulsing dot (and a running agent's pip), and there is no action
 * beyond opening the session — anything that needed you would have surfaced in
 * "Needs your input" instead.
 *
 * Three sources merge here: active flow runs, quick sessions the triage classes
 * as running, and detected dynamic workflows. They overlap — a flow run and a
 * dynamic workflow both live INSIDE a session — so the page hands over one row
 * per running thing, keeping whichever source says the most about it: the flow
 * run over its session, and a dynamic workflow over the session hosting it.
 *
 * Progress lives in a shared right-hand gutter, so a mixed list scans as one
 * column. Two sources have something honest to show there:
 *   - a flow run gets the phase stepper compressed to a strip of bars (the old
 *     ActiveAgentCard's FlowProgress, minus the labels) plus its current step;
 *   - a dynamic workflow gets one pip per subagent (the old
 *     DynamicWorkflowAgentCard's tally, made visual) plus running/done counts.
 * Everything else — a quick session, a run whose definition has not resolved,
 * a workflow whose journal has no lines yet — falls back to the static
 * "Running" pill, which is what every row looked like before.
 *
 * Hooks discipline: RunRow opens ONE phase subscription per active flow run
 * (same contract as the retired ActiveAgentCard). It must stay a component
 * rendered once per row — never a helper called inside a loop body.
 */
import React from 'react';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { DynamicWorkflowRunState } from '../../../../shared/types/dynamicWorkflows';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import { useWorkflowPhaseState } from '../../hooks/useWorkflowPhaseState';
import { agentsForDisplay } from '../../utils/dynamicWorkflowGrouping';
import { derivePhaseFill, formatElapsed } from '../../utils/homeClassify';
import { EmptyStrip, SectionHeader } from './QueuePrimitives';

/**
 * How many agent pips render before the row collapses the rest to "+N". A wide
 * fan-out (18 agents) would otherwise push the counts off the row.
 */
const MAX_AGENT_PIPS = 12;

/** One running thing, normalized across the three sources. */
export type WorkingRow =
  | { kind: 'quick'; id: string; row: QuickSessionRow }
  | { kind: 'run'; id: string; run: ActiveRunRow }
  | { kind: 'dynamic'; id: string; workflow: DynamicWorkflowRunState };

// ---------------------------------------------------------------------------
// Row chrome
// ---------------------------------------------------------------------------

/** The clickable one-line shell every row shares. Opening it is the only action. */
function RowShell({
  onOpen,
  children,
}: {
  onOpen: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="rq-working-row"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex w-full cursor-pointer items-center gap-2.5 border border-border-primary bg-surface-raised px-3.5 py-2 text-left transition-colors hover:border-border-hover"
    >
      <span
        aria-hidden="true"
        className="h-[7px] w-[7px] shrink-0 animate-cfpulse rounded-full bg-interactive"
      />
      {children}
    </div>
  );
}

function Name({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="shrink-0 text-[12px] font-bold text-text-primary">{children}</span>;
}

function Detail({ text }: { text: string }): React.JSX.Element {
  return (
    <span className="min-w-0 flex-1 truncate text-[11px] text-text-secondary" title={text}>
      {text}
    </span>
  );
}

/** The fallback gutter: what every row showed before progress landed here. */
function RunningPill(): React.JSX.Element {
  return (
    <span className="eyebrow ml-auto shrink-0 rounded-full border border-border-primary px-2 py-px text-text-secondary">
      Running
    </span>
  );
}

function Elapsed({ children }: { children: string }): React.JSX.Element {
  return <span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">{children}</span>;
}

// ---------------------------------------------------------------------------
// Row variants
// ---------------------------------------------------------------------------

function QuickRow({
  row,
  onOpen,
}: {
  row: QuickSessionRow;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <RowShell onOpen={onOpen}>
      <Name>{row.name}</Name>
      {row.summary !== null && <Detail text={row.summary} />}
      <RunningPill />
    </RowShell>
  );
}

/**
 * A flow run: the phase stepper compressed to one bar per phase, filled with the
 * LITERAL phase hex (inline style, never a token — the same design contract
 * FlowProgress follows) up to the current phase, a soft ring on the current one.
 * Labels do not fit at this size, so the plan reads on hover.
 */
function RunRow({ run, nowMs, onOpen }: { run: ActiveRunRow; nowMs: number; onOpen: () => void }): React.JSX.Element {
  const { definition, currentStepId } = useWorkflowPhaseState(run.id);
  const segments = derivePhaseFill(definition, currentStepId);

  const currentStepName = React.useMemo(() => {
    if (definition === null || currentStepId === null) return null;
    for (const phase of definition.phases) {
      for (const step of phase.steps) {
        if (step.id === currentStepId) return step.name;
      }
    }
    return null;
  }, [definition, currentStepId]);

  const plan = segments.map((seg) => seg.label).join(' → ');

  return (
    <RowShell onOpen={onOpen}>
      <Name>{run.workflowName}</Name>
      {run.branch_name !== null && (
        <span className="min-w-0 flex-1 truncate text-[11px] text-status-success" title={run.branch_name}>
          ⌥ {run.branch_name}
        </span>
      )}
      {segments.length === 0 ? (
        <RunningPill />
      ) : (
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          <span
            aria-label={`Phase plan: ${plan}`}
            title={plan}
            className="flex items-center gap-[3px]"
          >
            {segments.map((seg) => (
              <span
                key={seg.phaseId}
                className="h-[3px] w-4"
                style={{
                  backgroundColor: seg.filled ? seg.color : 'var(--color-border-primary)',
                  boxShadow: seg.current ? `0 0 0 2px ${seg.color}33` : undefined,
                }}
              />
            ))}
          </span>
          {currentStepName !== null && (
            <span className="shrink-0 text-[11px] text-text-secondary">
              ▸ <span className="font-bold text-text-primary">{currentStepName}</span>
            </span>
          )}
          <Elapsed>{formatElapsed(run.started_at, nowMs)}</Elapsed>
        </span>
      )}
    </RowShell>
  );
}

/**
 * A dynamic workflow: one pip per subagent — filled for done, pulsing accent for
 * running (the journal only ever reports those two states, so there is no
 * "not started" pip to draw). A wide fan-out collapses past MAX_AGENT_PIPS.
 */
function DynamicRow({
  workflow,
  nowMs,
  onOpen,
}: {
  workflow: DynamicWorkflowRunState;
  nowMs: number;
  onOpen: () => void;
}): React.JSX.Element {
  const agents = React.useMemo(
    () => agentsForDisplay(workflow.agents, workflow.status),
    [workflow.agents, workflow.status],
  );
  const runningCount = agents.filter((a) => a.status === 'running').length;
  const doneCount = agents.length - runningCount;
  const shown = agents.slice(0, MAX_AGENT_PIPS);
  const overflow = agents.length - shown.length;
  const detail = workflow.description ?? workflow.name;

  return (
    <RowShell onOpen={onOpen}>
      <Name>{workflow.sessionName}</Name>
      <Detail text={detail} />
      {agents.length === 0 ? (
        <RunningPill />
      ) : (
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          <span className="flex items-center gap-[3px]" aria-hidden="true">
            {shown.map((agent) => (
              <span
                key={agent.agentId}
                className={`h-[7px] w-[7px] ${
                  agent.status === 'running' ? 'animate-cfpulse bg-interactive' : 'bg-text-tertiary'
                }`}
              />
            ))}
            {overflow > 0 && <span className="text-[10px] text-text-tertiary">+{overflow}</span>}
          </span>
          <span className="shrink-0 text-[11px] text-text-secondary">
            <span className="font-bold text-text-primary">{runningCount}</span> running · {doneCount} done
          </span>
          <Elapsed>{formatElapsed(workflow.startedAt, nowMs)}</Elapsed>
        </span>
      )}
    </RowShell>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export interface WorkingSectionProps {
  rows: WorkingRow[];
  /** Shared page clock, so every elapsed label ticks off one interval. */
  nowMs: number;
  /** Render an empty dashed strip instead of hiding the section (the all-idle state). */
  showWhenEmpty: boolean;
  onOpenQuickSession: (row: QuickSessionRow) => void;
  onOpenRun: (run: ActiveRunRow) => void;
  onOpenDynamicWorkflow: (workflow: DynamicWorkflowRunState) => void;
}

/** WorkingSection — see {@link WorkingSectionProps}. */
export function WorkingSection({
  rows,
  nowMs,
  showWhenEmpty,
  onOpenQuickSession,
  onOpenRun,
  onOpenDynamicWorkflow,
}: WorkingSectionProps): React.JSX.Element | null {
  if (rows.length === 0 && !showWhenEmpty) return null;
  return (
    <section data-testid="rq-working-section" className="flex flex-col gap-2">
      <SectionHeader
        dotClass="bg-interactive"
        title="Working"
        count={rows.length}
        countMuted={rows.length === 0}
        subtitle={rows.length > 0 ? 'Running — nothing needed from you' : undefined}
      />
      {rows.length === 0 ? (
        <EmptyStrip>No agents running.</EmptyStrip>
      ) : (
        rows.map((entry) => {
          if (entry.kind === 'quick') {
            return <QuickRow key={entry.id} row={entry.row} onOpen={() => onOpenQuickSession(entry.row)} />;
          }
          if (entry.kind === 'run') {
            return (
              <RunRow key={entry.id} run={entry.run} nowMs={nowMs} onOpen={() => onOpenRun(entry.run)} />
            );
          }
          return (
            <DynamicRow
              key={entry.id}
              workflow={entry.workflow}
              nowMs={nowMs}
              onOpen={() => onOpenDynamicWorkflow(entry.workflow)}
            />
          );
        })
      )}
    </section>
  );
}
