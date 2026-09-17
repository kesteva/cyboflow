/**
 * SaveViewDialog — names a NEW view for the open draft
 * (docs/proposals/CUSTOM-VIEWS.md §6, the "Save view" artboard).
 *
 * Pins the client-side validation gate (empty name, ≤60 chars, a
 * case-insensitive duplicate among the surface's existing view names) that
 * must never round-trip to the server, the happy path's exact `createView`
 * call and cleanup, and that a server-side failure (`save` keeping the draft
 * with `draft.saveError` set) leaves the dialog open with the mapped message.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CustomView, LayoutItem, ViewLayout } from '../../../../../shared/types/customViews';

let createViewImpl: (input: { surface: string; name: string; layout: ViewLayout }) => Promise<CustomView> = () =>
  Promise.reject(new Error('not configured'));
const setActiveView = vi.fn((_input: { surface: string; viewId: string }) => Promise.resolve({ ok: true as const }));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      customViews: {
        listViews: { query: vi.fn(() => Promise.resolve([])) },
        getActiveView: { query: vi.fn(() => Promise.resolve({ viewId: 'default' })) },
        listWidgets: { query: vi.fn(() => Promise.resolve([])) },
        createView: {
          mutate: (input: { surface: string; name: string; layout: ViewLayout }) => createViewImpl(input),
        },
        setActiveView: { mutate: (input: { surface: string; viewId: string }) => setActiveView(input) },
        onWidgetDraft: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
      },
    },
  },
}));

import { SaveViewDialog } from '../../edit/SaveViewDialog';
import { useCustomViewsStore } from '../../../stores/customViewsStore';

function existingView(id: string, name: string): CustomView {
  return {
    id,
    surface: 'review-queue',
    name,
    layout: { version: 1, items: [] },
    revision: 1,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
}

const DRAFT_ITEMS: LayoutItem[] = [
  { instanceId: 'i1', widget: { type: 'catalog', catalogId: 'queue.usage-cards' }, settings: {} },
];

beforeEach(() => {
  createViewImpl = () => Promise.reject(new Error('not configured'));
  setActiveView.mockClear();
  useCustomViewsStore.setState({
    viewsBySurface: {
      'review-queue': [existingView('v1', 'Ship week')],
      'project-overview': [],
    },
    activeViewIdBySurface: { 'review-queue': 'default', 'project-overview': 'default' },
    widgets: [],
    loadedSurfaces: { 'review-queue': false, 'project-overview': false },
    authoring: null,
    draft: {
      surface: 'review-queue',
      layout: { version: 1, items: DRAFT_ITEMS },
      baseViewId: null,
      baseRevision: null,
      dirty: true,
      saveError: null,
    },
  });
});

describe('SaveViewDialog — client-side validation', () => {
  it('requires a non-empty name', async () => {
    const createView = vi.fn(createViewImpl);
    createViewImpl = createView;
    const user = userEvent.setup();
    render(<SaveViewDialog isOpen onClose={() => {}} surface="review-queue" />);

    await user.click(screen.getByTestId('save-view-submit'));

    expect(screen.getByTestId('save-view-error')).toHaveTextContent('Name is required.');
    expect(createView).not.toHaveBeenCalled();
  });

  it('rejects a case-insensitive duplicate of an existing view name', async () => {
    const createView = vi.fn(createViewImpl);
    createViewImpl = createView;
    const user = userEvent.setup();
    render(<SaveViewDialog isOpen onClose={() => {}} surface="review-queue" />);

    fireEvent.change(screen.getByTestId('save-view-name'), { target: { value: 'ship WEEK' } });
    await user.click(screen.getByTestId('save-view-submit'));

    expect(screen.getByTestId('save-view-error')).toHaveTextContent('A view with that name already exists.');
    expect(createView).not.toHaveBeenCalled();
  });
});

describe('SaveViewDialog — saving', () => {
  it('a valid name calls createView with the draft layout, clears the draft, and closes', async () => {
    const saved = existingView('v2', 'Weekly digest');
    const createView = vi.fn((input: { surface: string; name: string; layout: ViewLayout }) => {
      void input;
      return Promise.resolve(saved);
    });
    createViewImpl = createView;
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SaveViewDialog isOpen onClose={onClose} surface="review-queue" />);

    fireEvent.change(screen.getByTestId('save-view-name'), { target: { value: 'Weekly digest' } });
    await user.click(screen.getByTestId('save-view-submit'));

    await waitFor(() => expect(createView).toHaveBeenCalledWith({
      surface: 'review-queue',
      name: 'Weekly digest',
      layout: { version: 1, items: DRAFT_ITEMS },
    }));
    await waitFor(() => expect(useCustomViewsStore.getState().draft).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open and shows the mapped error when the store save fails', async () => {
    createViewImpl = () => Promise.reject(new Error('name_taken'));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SaveViewDialog isOpen onClose={onClose} surface="review-queue" />);

    fireEvent.change(screen.getByTestId('save-view-name'), { target: { value: 'Brand new name' } });
    await user.click(screen.getByTestId('save-view-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('save-view-error')).toHaveTextContent('A view with that name already exists.'),
    );
    expect(useCustomViewsStore.getState().draft).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
