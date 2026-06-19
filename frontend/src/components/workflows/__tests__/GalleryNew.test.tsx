/**
 * GalleryNew tests — the "New workflow" picker modal.
 *
 * Pins the contract points:
 *   1. Templates are DEDUPED by `row.name` (one card per distinct name).
 *   2. Clicking a template card calls onSelect(def, permissionMode, name, scope).
 *   3. The blank-canvas card calls onSelect(undefined, undefined, undefined, scope).
 *   4. Renders standalone (Modal portals to document.body; no tRPC provider).
 *   5. A new flow defaults to GLOBAL scope (null); choosing a project threads it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GalleryNew, type GalleryNewTemplate, type GalleryNewProject } from '../GalleryNew';
import type {
  WorkflowRow,
  WorkflowDefinition,
} from '../../../../../shared/types/workflows';

function def(id: string): WorkflowDefinition {
  return {
    id,
    phases: [
      {
        id: 'p1',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [{ id: 's1', name: 'S1', agent: 'context', mcps: [], retries: 0 }],
      },
    ],
  };
}

function row(id: string, name: string): WorkflowRow {
  return {
    id,
    project_id: 1,
    name,
    workflow_path: null,
    permission_mode: 'acceptEdits',
    spec_json: '{}',
    created_at: '2026-06-17T00:00:00.000Z',
  };
}

const TEMPLATES: GalleryNewTemplate[] = [
  { row: row('a', 'Planner'), definition: def('planner') },
  { row: row('b', 'Sprint'), definition: def('sprint') },
  // Duplicate name 'Planner' — must be deduped away (first wins).
  { row: row('c', 'Planner'), definition: def('planner-dupe') },
];

const PROJECTS: GalleryNewProject[] = [
  { id: 1, name: 'Acme' },
  { id: 2, name: 'Beta' },
];

describe('GalleryNew', () => {
  it('renders one template card per distinct row.name (deduped)', () => {
    render(
      <GalleryNew isOpen onClose={() => {}} templates={TEMPLATES} onSelect={() => {}} />,
    );
    // 'a' and 'b' present; 'c' (dupe name) absent.
    expect(screen.getByTestId('gallery-new-template-a')).toBeTruthy();
    expect(screen.getByTestId('gallery-new-template-b')).toBeTruthy();
    expect(screen.queryByTestId('gallery-new-template-c')).toBeNull();
  });

  it('clicking a template card calls onSelect(def, permissionMode, name, GLOBAL scope by default)', () => {
    const onSelect = vi.fn();
    render(
      <GalleryNew isOpen onClose={() => {}} templates={TEMPLATES} projects={PROJECTS} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByTestId('gallery-new-template-a'));
    // 4th arg = scope; default is GLOBAL (null) for a new flow (migration 030).
    expect(onSelect).toHaveBeenCalledWith(def('planner'), 'acceptEdits', 'Planner', null);
  });

  it('clicking blank canvas calls onSelect(undefined, …, GLOBAL scope)', () => {
    const onSelect = vi.fn();
    render(
      <GalleryNew isOpen onClose={() => {}} templates={TEMPLATES} projects={PROJECTS} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByTestId('gallery-new-blank'));
    expect(onSelect).toHaveBeenCalledWith(undefined, undefined, undefined, null);
  });

  it('defaults to the preselected project scope when defaultScopeProjectId is set', () => {
    const onSelect = vi.fn();
    render(
      <GalleryNew
        isOpen
        onClose={() => {}}
        templates={TEMPLATES}
        projects={PROJECTS}
        defaultScopeProjectId={2}
        onSelect={onSelect}
      />,
    );
    // The scope select reflects the preselected project, and onSelect threads it.
    expect(screen.getByTestId('gallery-new-scope-select')).toHaveValue('2');
    fireEvent.click(screen.getByTestId('gallery-new-template-a'));
    expect(onSelect).toHaveBeenCalledWith(def('planner'), 'acceptEdits', 'Planner', 2);
  });

  it('threads the project scope chosen in the scope select into onSelect', () => {
    const onSelect = vi.fn();
    render(
      <GalleryNew isOpen onClose={() => {}} templates={TEMPLATES} projects={PROJECTS} onSelect={onSelect} />,
    );
    // Default is GLOBAL; switch to project 1 then pick a template.
    fireEvent.change(screen.getByTestId('gallery-new-scope-select'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('gallery-new-template-b'));
    expect(onSelect).toHaveBeenCalledWith(def('sprint'), 'acceptEdits', 'Sprint', 1);
  });

  it('renders an empty-state message when no templates are supplied', () => {
    render(<GalleryNew isOpen onClose={() => {}} templates={[]} onSelect={() => {}} />);
    expect(screen.getByText(/No workflows to use as a template/i)).toBeTruthy();
    // Blank canvas is always available.
    expect(screen.getByTestId('gallery-new-blank')).toBeTruthy();
  });
});
