/**
 * BlockedRunsSection — the amber band: flow runs that stopped and are not
 * represented anywhere else on the page.
 *
 * Most halted runs already have a home: a gate mints a decision item (red band),
 * a clean drain lands in Ready for review, a blocking finding raises a
 * recommended action. What had none was the remainder — a `stuck` run, or one
 * `paused` with nothing filed — which used to be visible only by accident, as
 * its hosting session's quick row in Working wearing a "Running" pill. Deduping
 * that row away made the gap real, so this band is where those runs land.
 *
 * Rows are one line and carry the run's own words for why it stopped
 * (`stuck_reason`) when it has them. The dot does NOT pulse: nothing is moving.
 * The only action is opening the run, because unwedging one is a decision made
 * in the session, not from a list.
 *
 * The section is omitted entirely when empty — an empty well here would imply
 * the queue expects runs to wedge.
 */
import React from 'react';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import { formatElapsedMinutes } from '../../utils/homeClassify';
import { Chip, PrimaryButton, SectionHeader } from './QueuePrimitives';

/** Why the run stopped, in the run's own words where it has them. */
function describeStall(run: ActiveRunRow): string {
  if (run.stuck_reason !== null && run.stuck_reason !== '') return run.stuck_reason;
  switch (run.status) {
    case 'stuck':
      return 'Stuck — no progress reported';
    case 'paused':
      return 'Paused';
    case 'awaiting_input':
      return 'Waiting on input';
    case 'awaiting_review':
      return 'Waiting on review';
    default:
      return 'Stopped';
  }
}

function BlockedRunRow({
  run,
  projectName,
  nowMs,
  onOpen,
}: {
  run: ActiveRunRow;
  projectName: string | null;
  nowMs: number;
  onOpen: () => void;
}): React.JSX.Element {
  const stall = describeStall(run);
  return (
    <div
      data-testid="rq-blocked-run-row"
      className="flex items-center gap-2.5 border border-border-primary bg-surface-raised px-3.5 py-2 shadow-[inset_3px_0_0_var(--color-status-warning)]"
    >
      <span className="shrink-0 text-[12px] font-bold text-text-primary">{run.workflowName}</span>
      {run.branch_name !== null && (
        <span className="shrink-0 truncate text-[11px] text-status-success" title={run.branch_name}>
          ⌥ {run.branch_name}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[11px] text-text-secondary" title={stall}>
        {stall}
      </span>
      {projectName !== null && <Chip title={projectName}>{projectName}</Chip>}
      <span className="shrink-0 text-[10px] text-text-tertiary">
        stopped {formatElapsedMinutes(run.updated_at, nowMs)}
      </span>
      <PrimaryButton onClick={onOpen}>Open →</PrimaryButton>
    </div>
  );
}

export interface BlockedRunsSectionProps {
  runs: ActiveRunRow[];
  projectNameById: Record<number, string>;
  nowMs: number;
  onOpenRun: (run: ActiveRunRow) => void;
}

/** BlockedRunsSection — see {@link BlockedRunsSectionProps}. */
export function BlockedRunsSection({
  runs,
  projectNameById,
  nowMs,
  onOpenRun,
}: BlockedRunsSectionProps): React.JSX.Element | null {
  if (runs.length === 0) return null;
  return (
    <section data-testid="rq-blocked-runs-section" className="flex flex-col gap-2">
      <SectionHeader
        dotClass="bg-status-warning"
        title="Blocked"
        count={runs.length}
        subtitle="Stopped — nothing else is asking for these"
      />
      {runs.map((run) => (
        <BlockedRunRow
          key={run.id}
          run={run}
          projectName={projectNameById[run.project_id] ?? null}
          nowMs={nowMs}
          onOpen={() => onOpenRun(run)}
        />
      ))}
    </section>
  );
}
