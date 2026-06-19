/**
 * WorkflowCard — one workflow tile in the stacked gallery's Workflows section.
 *
 * Renders a {@link WorkflowGalleryEntry}: the flow name, an optional project
 * chip (shown only in the cross-project "All projects" view AND only for a
 * project-scoped flow — a GLOBAL flow with `row.project_id === null` shows no
 * chip), a presentational
 * {@link PhaseRibbon} preview (NO subscription — see PhaseRibbon's header), the
 * {@link WfMeta} headline counts (steps / phases / human gates / loops), the
 * relative "used" timestamp, and a Run / Edit / Duplicate action footer.
 *
 * Mirrors the design reference's `.GB-card` block: white surface, hairline
 * border, SQUARE corners, and a `0 2px 0 var(--color-text-primary)` hover lift.
 * The Run accent uses the interactive-primary token (the design's rust accent).
 *
 * The three action handlers are thin `onX` props passed from WorkflowsView; the
 * handler BODIES are wired in P4 (Run / editor integration). They are optional
 * so render never crashes before wiring.
 */
import { PhaseRibbon } from './PhaseRibbon';
import type { WorkflowGalleryEntry } from '../../stores/workflowsStore';
import { formatDistanceToNow } from '../../utils/timestampUtils';
import { isCyboflowWorkflowName } from '../../../../shared/types/workflows';

export interface WorkflowCardProps {
  /** The workflow gallery row (row + resolved definition + derived meta). */
  entry: WorkflowGalleryEntry;
  /**
   * True when the gallery is in the cross-project "All projects" view, which
   * shows the owning-project chip. Hidden when a single project is filtered.
   */
  showProjectChip: boolean;
  /** Launch a run of this workflow. Wired in P4. */
  onRun?: (entry: WorkflowGalleryEntry) => void;
  /** Open this workflow in the editor. Wired in P4. */
  onEdit?: (entry: WorkflowGalleryEntry) => void;
  /** Duplicate this workflow into a new editable draft. Wired in P4. */
  onDuplicate?: (entry: WorkflowGalleryEntry) => void;
  /**
   * Delete this workflow. Only invoked for a DELETABLE card (see `deletable`
   * below) — a global built-in and the __quick__ sentinel never offer Delete,
   * mirroring the registry's `deleteWorkflow` guard. Omitting it hides the button.
   */
  onDelete?: (entry: WorkflowGalleryEntry) => void;
}

/** Small uppercase footer button — the design's `.GB-mini`. */
function MiniButton({
  label,
  onClick,
  accent = false,
  danger = false,
  testId,
}: {
  label: string;
  onClick?: () => void;
  accent?: boolean;
  danger?: boolean;
  testId?: string;
}): React.JSX.Element {
  const className = danger
    ? 'border border-status-error bg-surface-primary px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-status-error transition-colors hover:bg-status-error hover:text-text-on-status-error'
    : accent
      ? 'border border-interactive bg-surface-primary px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-interactive transition-colors hover:bg-interactive hover:text-text-on-interactive'
      : 'border border-border-primary bg-surface-primary px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-text-primary transition-colors hover:border-text-primary';
  return (
    <button type="button" onClick={onClick} data-testid={testId} className={className}>
      {label}
    </button>
  );
}

/** WorkflowCard — see the file header. */
export function WorkflowCard({
  entry,
  showProjectChip,
  onRun,
  onEdit,
  onDuplicate,
  onDelete,
}: WorkflowCardProps): React.JSX.Element {
  const { row, definition, meta, lastUsedAt, projectName } = entry;
  const used =
    lastUsedAt !== null ? `used ${formatDistanceToNow(lastUsedAt)}` : 'never run';

  // Delete is offered for everything EXCEPT a GLOBAL built-in (project_id null AND
  // a cyboflow built-in name) and the __quick__ sentinel — both re-seed, so the
  // server refuses to delete them. Mirrors the registry's deleteWorkflow guard.
  const deletable =
    !(row.project_id === null && isCyboflowWorkflowName(row.name)) && row.name !== '__quick__';

  return (
    <div
      data-testid={`workflow-card-${row.id}`}
      className="flex flex-col border border-border-primary bg-surface-primary transition-[border-color,box-shadow] duration-150 hover:border-text-primary"
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = '0 2px 0 var(--color-text-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] font-bold tracking-[-0.01em] text-text-primary">
            {row.name}
          </span>
          {/* Project chip — shown only in the cross-project view AND only for a
              project-scoped flow (row.project_id !== null). A GLOBAL flow
              (project_id null, migration 030) carries no owning project, so it
              shows NO chip at all. */}
          {showProjectChip && row.project_id !== null && projectName !== '' && (
            <span
              data-testid="workflow-card-project-chip"
              className="shrink-0 truncate rounded-badge border border-border-primary bg-bg-secondary px-1.5 py-px text-[9px] font-semibold text-text-tertiary"
            >
              {projectName}
            </span>
          )}
        </div>

        <PhaseRibbon definition={definition} />

        <div className="flex flex-wrap gap-3.5 text-[10px] tracking-[0.04em] text-text-secondary">
          <span>
            <b className="font-bold tabular-nums text-text-primary">{meta.steps}</b> steps
          </span>
          <span>
            <b className="font-bold tabular-nums text-text-primary">{meta.phases}</b> phases
          </span>
          <span>
            <b className="font-bold tabular-nums text-text-primary">{meta.human}</b> human
          </span>
          {meta.loops > 0 && (
            <span>
              <b className="font-bold tabular-nums text-text-primary">{meta.loops}</b>
              {'↺'} loop
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-dashed border-border-primary bg-bg-secondary px-3 py-2">
        <span className="flex-1 truncate text-[9.5px] uppercase tracking-[0.06em] text-text-tertiary">
          {used}
        </span>
        <MiniButton
          label="Edit"
          testId={`workflow-card-edit-${row.id}`}
          onClick={onEdit !== undefined ? () => onEdit(entry) : undefined}
        />
        <MiniButton
          label="Duplicate"
          testId={`workflow-card-duplicate-${row.id}`}
          onClick={onDuplicate !== undefined ? () => onDuplicate(entry) : undefined}
        />
        {deletable && onDelete !== undefined && (
          <MiniButton
            label="Delete"
            danger
            testId={`workflow-card-delete-${row.id}`}
            onClick={() => onDelete(entry)}
          />
        )}
        <MiniButton
          label="Run"
          accent
          testId={`workflow-card-run-${row.id}`}
          onClick={onRun !== undefined ? () => onRun(entry) : undefined}
        />
      </div>
    </div>
  );
}
