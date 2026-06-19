/**
 * GalleryNew — the "New workflow" picker modal.
 *
 * Two regions:
 *   1. "From template" — one card per existing workflow, DEDUPED BY `row.name`
 *      (so the 3 builtins + any distinctly-named customs each appear once). Each
 *      card shows the workflow name + a presentational {@link PhaseRibbon}
 *      preview (`thin`). Clicking a card calls
 *      `onSelect(definition, permissionMode, name, scopeProjectId)`.
 *   2. "Blank canvas" — a single card; clicking calls
 *      `onSelect(undefined, undefined, undefined, scopeProjectId)` so the caller
 *      seeds a brand-new custom skeleton.
 *
 * SCOPE (migration 030): a new flow defaults to GLOBAL (scopeProjectId null,
 * shown across all projects). A scope control offers either Global or a specific
 * project; the chosen scope is threaded as the 4th `onSelect` argument. The
 * project options come from `projects`; if none are supplied only Global is
 * offered.
 *
 * GalleryNew is PURELY PRESENTATIONAL over the passed-in `templates`: the caller
 * supplies the store's already-fetched workflows — GalleryNew never fetches.
 *
 * Mirrors the paper aesthetic: white surfaces, hairline `--color-*` borders,
 * SQUARE corners, the `0 2px 0 var(--color-text-primary)` hover lift.
 */
import { useEffect, useState } from 'react';
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

/** A project the new flow can be scoped to — the minimal shape the picker needs. */
export interface GalleryNewProject {
  id: number;
  name: string;
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
   * Projects the new flow can be scoped to (migration 030). Empty ⇒ only the
   * Global scope is offered.
   */
  projects?: GalleryNewProject[];
  /**
   * The scope preselected for the picker: a gallery project-filter pins that
   * project, `null` defaults to GLOBAL (the product default for a new flow).
   */
  defaultScopeProjectId?: number | null;
  /**
   * Selection callback. The 4th arg is the chosen scope (`null` ⇒ GLOBAL, an
   * integer ⇒ project-scoped). Called with `(undefined, undefined, undefined,
   * scope)` for the blank canvas, or with `(definition, permissionMode, name,
   * scope)` for a chosen template.
   */
  onSelect: (
    def?: WorkflowDefinition,
    permissionMode?: PermissionMode,
    name?: string,
    scopeProjectId?: number | null,
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

/** Sentinel `<option>` value for the GLOBAL (null scope) choice. */
const GLOBAL_SCOPE_VALUE = 'global';

/** GalleryNew — see the file header. */
export function GalleryNew({
  isOpen,
  onClose,
  templates,
  projects = [],
  defaultScopeProjectId = null,
  onSelect,
}: GalleryNewProps): React.JSX.Element {
  const deduped = dedupeByName(templates);

  // Chosen scope for the new flow: null ⇒ GLOBAL (the default). Re-seeded each
  // open so a stale prior selection never leaks.
  const [scopeProjectId, setScopeProjectId] = useState<number | null>(defaultScopeProjectId);
  useEffect(() => {
    if (isOpen) setScopeProjectId(defaultScopeProjectId);
  }, [isOpen, defaultScopeProjectId]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      {/* No onClose here — the Modal renders its own close X; passing onClose to
          ModalHeader too would stack a second X on top of it (matches the
          SaveScopeDialog pattern). */}
      <ModalHeader title="New workflow" />
      <ModalBody className="flex flex-col gap-6">
        {/* Scope (migration 030) — GLOBAL default, or scope to one project. */}
        <section className="flex flex-col gap-2">
          <h3 className="eyebrow text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
            Scope
          </h3>
          <label className="flex items-center gap-2">
            <span className="text-[11px] text-text-secondary">This flow is available to</span>
            <select
              data-testid="gallery-new-scope-select"
              aria-label="Scope for the new workflow"
              value={scopeProjectId === null ? GLOBAL_SCOPE_VALUE : String(scopeProjectId)}
              onChange={(e) =>
                setScopeProjectId(
                  e.target.value === GLOBAL_SCOPE_VALUE ? null : Number(e.target.value),
                )
              }
              className="rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary focus:border-border-emphasized focus:outline-none"
            >
              <option value={GLOBAL_SCOPE_VALUE}>All projects (global)</option>
              {projects.map((project) => (
                <option key={project.id} value={String(project.id)}>
                  Only {project.name}
                </option>
              ))}
            </select>
          </label>
        </section>

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
                    onSelect(definition, row.permission_mode, row.name, scopeProjectId)
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
            onClick={() => onSelect(undefined, undefined, undefined, scopeProjectId)}
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
