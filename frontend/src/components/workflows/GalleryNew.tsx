/**
 * GalleryNew — the "New workflow" picker modal.
 *
 * Two regions:
 *   1. "From template" — one card per existing workflow, DEDUPED BY `row.name`
 *      (so the 3 builtins + any distinctly-named customs each appear once). Each
 *      card shows the workflow name + a presentational {@link PhaseRibbon}
 *      preview (`thin`). Clicking a card calls
 *      `onSelect(definition, permissionMode, name)`.
 *   2. "Blank canvas" — a single card; clicking calls `onSelect(undefined)` so
 *      the caller seeds a brand-new custom skeleton.
 *
 * GalleryNew is PURELY PRESENTATIONAL over the passed-in `templates`: the caller
 * supplies the store's already-fetched workflows — GalleryNew never fetches.
 *
 * Mirrors the paper aesthetic: white surfaces, hairline `--color-*` borders,
 * SQUARE corners, the `0 2px 0 var(--color-text-primary)` hover lift.
 */
import { Modal, ModalHeader, ModalBody } from '../ui/Modal';
import { PhaseRibbon } from './PhaseRibbon';
import type {
  WorkflowRow,
  WorkflowDefinition,
  PermissionMode,
} from '../../../../shared/types/workflows';

export interface GalleryNewTemplate {
  /** The underlying `workflows` table row (carries name + permission_mode). */
  row: WorkflowRow;
  /** The row's resolved effective definition (drives the ribbon preview). */
  definition: WorkflowDefinition;
}

export interface GalleryNewProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The caller-supplied, already-fetched workflows (e.g. from
   * `workflowsStore`). GalleryNew dedupes these by `row.name` for the template
   * grid — it does NOT fetch.
   */
  templates: GalleryNewTemplate[];
  /**
   * Selection callback. Called with `(undefined)` for the blank canvas, or with
   * `(definition, permissionMode, name)` for a chosen template.
   */
  onSelect: (
    def?: WorkflowDefinition,
    permissionMode?: PermissionMode,
    name?: string,
  ) => void;
}

/** Hover-lift wrapper shared by the template + blank cards. */
function liftOn(e: React.MouseEvent<HTMLButtonElement>): void {
  e.currentTarget.style.boxShadow = '0 2px 0 var(--color-text-primary)';
}
function liftOff(e: React.MouseEvent<HTMLButtonElement>): void {
  e.currentTarget.style.boxShadow = 'none';
}

/**
 * Dedupe templates by `row.name` (first occurrence wins), preserving order — so
 * the 3 builtins + any distinctly-named customs each appear once.
 */
function dedupeByName(templates: GalleryNewTemplate[]): GalleryNewTemplate[] {
  const seen = new Set<string>();
  const out: GalleryNewTemplate[] = [];
  for (const t of templates) {
    if (seen.has(t.row.name)) continue;
    seen.add(t.row.name);
    out.push(t);
  }
  return out;
}

/** GalleryNew — see the file header. */
export function GalleryNew({
  isOpen,
  onClose,
  templates,
  onSelect,
}: GalleryNewProps): React.JSX.Element {
  const deduped = dedupeByName(templates);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalHeader title="New workflow" onClose={onClose} />
      <ModalBody className="flex flex-col gap-6">
        {/* Region 1 — From template */}
        <section className="flex flex-col gap-3">
          <h3 className="eyebrow text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
            From template
          </h3>
          {deduped.length === 0 ? (
            <p className="text-[12px] text-text-tertiary">
              No workflows to use as a template yet.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {deduped.map(({ row, definition }) => (
                <button
                  key={row.id}
                  type="button"
                  data-testid={`gallery-new-template-${row.id}`}
                  onClick={() =>
                    onSelect(definition, row.permission_mode, row.name)
                  }
                  onMouseEnter={liftOn}
                  onMouseLeave={liftOff}
                  className="flex flex-col gap-3 border border-border-primary bg-surface-primary p-4 text-left transition-[border-color,box-shadow] duration-150 hover:border-text-primary"
                >
                  <span className="min-w-0 truncate text-[14px] font-bold tracking-[-0.01em] text-text-primary">
                    {row.name}
                  </span>
                  <PhaseRibbon definition={definition} thin />
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Region 2 — Blank canvas */}
        <section className="flex flex-col gap-3">
          <h3 className="eyebrow text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
            Blank canvas
          </h3>
          <button
            type="button"
            data-testid="gallery-new-blank"
            onClick={() => onSelect(undefined)}
            onMouseEnter={liftOn}
            onMouseLeave={liftOff}
            className="flex flex-col gap-1 border border-dashed border-border-primary bg-surface-primary p-4 text-left transition-[border-color,box-shadow] duration-150 hover:border-text-primary"
          >
            <span className="text-[14px] font-bold tracking-[-0.01em] text-text-primary">
              Start from scratch
            </span>
            <span className="text-[11px] text-text-tertiary">
              Build a workflow phase by phase in the editor.
            </span>
          </button>
        </section>
      </ModalBody>
    </Modal>
  );
}
