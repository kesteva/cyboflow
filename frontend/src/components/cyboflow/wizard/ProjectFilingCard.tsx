/**
 * ProjectFilingCard — one project rendered as an index-card / manila-folder tab
 * in the wizard's step-1 project grid.
 *
 * A white card with a rust diagonal-hatch "tab" along the top edge, a folder
 * glyph + project name, and KEY/VALUE rows for PATH and BRANCH. The branch is
 * lazily detected via `API.projects.detectBranch(project.path)` on mount
 * (the Project row carries no branch field). Selected → terracotta border.
 */
import { useEffect, useState } from 'react';
import { API } from '../../../utils/api';
import type { Project } from '../../../types/project';

interface ProjectFilingCardProps {
  project: Project;
  selected: boolean;
  onSelect: () => void;
}

/** The rust diagonal-hatch tab fill (terracotta over its darker shade). */
const HATCH_TAB_STYLE: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(135deg, #c96442 0 7px, #b9573a 7px 14px)',
};

export function ProjectFilingCard({
  project,
  selected,
  onSelect,
}: ProjectFilingCardProps): React.JSX.Element {
  const [branch, setBranch] = useState<string | null>(null);

  // Lazily resolve the project's current branch — the Project row has no
  // branch column, so we ask the main process per card.
  useEffect(() => {
    let cancelled = false;
    void API.projects
      .detectBranch(project.path)
      .then((res) => {
        if (cancelled) return;
        if (res.success && typeof res.data === 'string') {
          setBranch(res.data);
        }
      })
      .catch(() => {
        /* branch stays null — the row renders an em dash */
      });
    return () => {
      cancelled = true;
    };
  }, [project.path]);

  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="project-filing-card"
      aria-pressed={selected}
      className={`flex flex-col overflow-hidden border bg-surface-primary text-left transition-colors ${
        selected
          ? 'border-interactive'
          : 'border-border-primary hover:border-border-emphasized'
      }`}
    >
      {/* Rust diagonal-hatch tab */}
      <div className="h-2 w-full" style={HATCH_TAB_STYLE} aria-hidden="true" />

      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <span aria-hidden="true">📁</span>
          <span
            className="truncate text-text-primary"
            style={{ fontSize: '14px', fontWeight: 700 }}
            title={project.name}
          >
            {project.name}
          </span>
        </div>

        <dl className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <dt className="eyebrow shrink-0 text-text-muted">Path</dt>
            <dd
              className="truncate font-mono text-xs text-text-secondary"
              title={project.path}
            >
              {project.path}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="eyebrow shrink-0 text-text-muted">Branch</dt>
            <dd className="truncate font-mono text-xs text-status-success">
              {branch ?? '—'}
            </dd>
          </div>
        </dl>
      </div>
    </button>
  );
}
