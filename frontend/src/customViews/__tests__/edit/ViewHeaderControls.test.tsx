/**
 * ViewHeaderControls — the header-right cluster's two faces
 * (docs/proposals/CUSTOM-VIEWS.md §6, §9 row S5).
 *
 * Outside customize mode it is the view switcher + Customize; clicking a
 * switcher item calls the store's `setActive`, and clicking Customize opens a
 * draft (`enterCustomize`) which flips the SAME slot over to Save/Save
 * as…/Discard — pinned here by asserting the switcher/Customize controls are
 * gone and the draft controls are present, with no unmount/remount of a
 * different component.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CustomView } from '../../../../../shared/types/customViews';

let mockViews: CustomView[] = [];
let mockActiveViewId = 'default';
const setActiveView = vi.fn((input: { surface: string; viewId: string }) => {
  mockActiveViewId = input.viewId;
  return Promise.resolve({ ok: true });
});

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      customViews: {
        listViews: { query: vi.fn(() => Promise.resolve(mockViews)) },
        getActiveView: { query: vi.fn(() => Promise.resolve({ viewId: mockActiveViewId })) },
        listWidgets: { query: vi.fn(() => Promise.resolve([])) },
        setActiveView: { mutate: (input: { surface: string; viewId: string }) => setActiveView(input) },
        onWidgetDraft: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
      },
    },
  },
}));

import { ViewHeaderControls } from '../../edit/ViewHeaderControls';
import { useCustomViewsStore } from '../../../stores/customViewsStore';

function view(id: string, name: string, revision = 1): CustomView {
  return {
    id,
    surface: 'review-queue',
    name,
    layout: { version: 1, items: [] },
    revision,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
}

// The header cluster never seeds the surface itself — `ViewSurface` owns the
// ref-counted `init(surface)` wiring and both pages always mount it alongside
// this component. The test stands in for ViewSurface here.
let release: (() => void) | null = null;

beforeEach(() => {
  mockViews = [view('v1', 'Ship week')];
  mockActiveViewId = 'default';
  setActiveView.mockClear();
  useCustomViewsStore.setState({
    viewsBySurface: { 'review-queue': [], 'project-overview': [] },
    activeViewIdBySurface: { 'review-queue': 'default', 'project-overview': 'default' },
    widgets: [],
    loadedSurfaces: { 'review-queue': false, 'project-overview': false },
    authoring: null,
    draft: null,
  });
  release = useCustomViewsStore.getState().init('review-queue');
});

afterEach(() => {
  release?.();
  release = null;
});

describe('ViewHeaderControls — switcher', () => {
  it('lists Default plus the surface\'s views and switches on click', async () => {
    const user = userEvent.setup();
    render(<ViewHeaderControls surface="review-queue" />);
    await waitFor(() => expect(useCustomViewsStore.getState().loadedSurfaces['review-queue']).toBe(true));

    await user.click(screen.getByTestId('view-switcher-trigger'));
    expect(screen.getAllByText('Default').length).toBeGreaterThanOrEqual(2); // trigger label + menu item
    await user.click(screen.getByText('Ship week'));

    await waitFor(() => expect(setActiveView).toHaveBeenCalledWith({ surface: 'review-queue', viewId: 'v1' }));
    expect(useCustomViewsStore.getState().activeViewIdBySurface['review-queue']).toBe('v1');
  });
});

describe('ViewHeaderControls — entering customize', () => {
  it('Customize opens a draft and swaps the slot to Save/Save as…/Discard', async () => {
    const user = userEvent.setup();
    render(<ViewHeaderControls surface="review-queue" />);
    await waitFor(() => expect(useCustomViewsStore.getState().loadedSurfaces['review-queue']).toBe(true));

    expect(screen.getByTestId('customize-button')).toBeInTheDocument();
    await user.click(screen.getByTestId('customize-button'));

    expect(useCustomViewsStore.getState().isCustomizing('review-queue')).toBe(true);
    expect(screen.queryByTestId('customize-button')).toBeNull();
    expect(screen.queryByTestId('view-switcher-trigger')).toBeNull();
    expect(screen.getByTestId('draft-save')).toBeInTheDocument();
    expect(screen.getByTestId('draft-discard')).toBeInTheDocument();
  });
});
