/**
 * WorkflowCard action-gating tests (TASK-091).
 *
 * Pins the three card states the archive/unarchive seam introduces:
 *   1. A GLOBAL built-in / `__quick__` sentinel (`deletable === false`) shows
 *      NONE of Archive / Unarchive / Delete.
 *   2. A deletable, non-archived card ALWAYS shows Archive, and shows Delete
 *      only when `lastUsedAt === null` (never-run).
 *   3. A deletable, ARCHIVED card shows Unarchive only — never Archive or
 *      Delete, regardless of `lastUsedAt`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkflowCard } from '../WorkflowCard';
import type { WorkflowGalleryEntry } from '../../../stores/workflowsStore';
import type { WorkflowDefinition } from '../../../../../shared/types/workflows';
import { wfMeta } from '../wfMeta';

const DEFINITION: WorkflowDefinition = {
  id: 'planner',
  phases: [
    {
      id: 'plan',
      label: 'Plan',
      color: '#3b6dd6',
      steps: [{ id: 's1', name: 'Draft', agent: 'planner', mcps: [], retries: 0 }],
    },
  ],
};

function buildEntry(over: Partial<WorkflowGalleryEntry['row']> = {}, lastUsedAt: string | null = null): WorkflowGalleryEntry {
  return {
    row: {
      id: 'wf-1',
      project_id: 1,
      name: 'Custom Flow',
      workflow_path: null,
      permission_mode: 'default',
      spec_json: '{}',
      created_at: '2026-06-10T00:00:00.000Z',
      archived_at: null,
      ...over,
    },
    definition: DEFINITION,
    meta: wfMeta(DEFINITION),
    lastUsedAt,
    projectName: 'Acme',
  };
}

describe('WorkflowCard — Archive/Unarchive/Delete gating', () => {
  it('shows NONE of Archive/Unarchive/Delete for a GLOBAL built-in (non-deletable)', () => {
    const entry = buildEntry({ project_id: null, name: 'planner' });
    render(
      <WorkflowCard
        entry={entry}
        showProjectChip={false}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    expect(screen.queryByTestId(`workflow-card-archive-${entry.row.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`workflow-card-unarchive-${entry.row.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`workflow-card-delete-${entry.row.id}`)).not.toBeInTheDocument();
  });

  it('shows NONE of Archive/Unarchive/Delete for the __quick__ sentinel (non-deletable)', () => {
    const entry = buildEntry({ project_id: 1, name: '__quick__' });
    render(
      <WorkflowCard
        entry={entry}
        showProjectChip={false}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    expect(screen.queryByTestId(`workflow-card-archive-${entry.row.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`workflow-card-unarchive-${entry.row.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`workflow-card-delete-${entry.row.id}`)).not.toBeInTheDocument();
  });

  it('deletable + non-archived + never-run: shows Archive AND Delete, not Unarchive', () => {
    const entry = buildEntry({}, null);
    render(
      <WorkflowCard
        entry={entry}
        showProjectChip={false}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    expect(screen.getByTestId(`workflow-card-archive-${entry.row.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`workflow-card-delete-${entry.row.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`workflow-card-unarchive-${entry.row.id}`)).not.toBeInTheDocument();
  });

  it('deletable + non-archived + has run history: shows Archive but NOT Delete', () => {
    const entry = buildEntry({}, '2026-06-11T00:00:00.000Z');
    render(
      <WorkflowCard
        entry={entry}
        showProjectChip={false}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    expect(screen.getByTestId(`workflow-card-archive-${entry.row.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`workflow-card-delete-${entry.row.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`workflow-card-unarchive-${entry.row.id}`)).not.toBeInTheDocument();
  });

  it('deletable + archived: shows Unarchive only — never Archive or Delete', () => {
    const entry = buildEntry({ archived_at: '2026-06-12T00:00:00.000Z' }, null);
    render(
      <WorkflowCard
        entry={entry}
        showProjectChip={false}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    expect(screen.getByTestId(`workflow-card-unarchive-${entry.row.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`workflow-card-archive-${entry.row.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`workflow-card-delete-${entry.row.id}`)).not.toBeInTheDocument();
  });

  it('invokes onArchive/onUnarchive with the entry on click', () => {
    const onArchive = vi.fn();
    const active = buildEntry({}, null);
    render(
      <WorkflowCard entry={active} showProjectChip={false} onArchive={onArchive} />,
    );
    screen.getByTestId(`workflow-card-archive-${active.row.id}`).click();
    expect(onArchive).toHaveBeenCalledWith(active);

    const onUnarchive = vi.fn();
    const archived = buildEntry({ archived_at: '2026-06-12T00:00:00.000Z' }, null);
    render(
      <WorkflowCard entry={archived} showProjectChip={false} onUnarchive={onUnarchive} />,
    );
    screen.getByTestId(`workflow-card-unarchive-${archived.row.id}`).click();
    expect(onUnarchive).toHaveBeenCalledWith(archived);
  });
});
