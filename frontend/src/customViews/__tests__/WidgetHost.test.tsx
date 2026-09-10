/**
 * WidgetHost — the state machine around one widget's data
 * (docs/proposals/CUSTOM-VIEWS.md §5.3's "Widget states").
 *
 * Each test pins one state and its exit: loading resolves into a body; an error
 * with nothing cached shows Retry and a Retry re-runs the query; a PAUSED
 * payload (the main process's repeat-suppression breaker) resets the breaker
 * BEFORE refetching, because a plain refetch would just be suppressed again;
 * and a failed refresh over good data keeps the data rather than blanking it.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LayoutItem, WidgetDataPayload, WidgetSpec } from '../../../../shared/types/customViews';

const runWidget = vi.fn();
const resetBreaker = vi.fn();

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      customViews: {
        runWidget: { query: (input: unknown) => runWidget(input) },
        resetBreaker: { mutate: (input: unknown) => resetBreaker(input) },
        previewAction: { query: vi.fn() },
        executeAction: { mutate: vi.fn() },
        listViews: { query: vi.fn(() => Promise.resolve([])) },
        getActiveView: { query: vi.fn(() => Promise.resolve({ viewId: 'default' })) },
        listWidgets: { query: vi.fn(() => Promise.resolve([])) },
        onWidgetDraft: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
      },
    },
  },
}));

import { WidgetHost } from '../WidgetHost';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STAT_SPEC: WidgetSpec = {
  version: 1,
  sources: { tokens: { type: 'sql', sql: 'SELECT 1 AS totalTokens' } },
  render: { type: 'shape', shape: 'stat', source: 'tokens', value: 'totalTokens', label: 'Tokens', format: 'tokens' },
  refreshSec: 60,
};

const ITEM: LayoutItem = {
  instanceId: 'inst-1',
  widget: { type: 'catalog', catalogId: 'stats.tokens-today' },
  settings: {},
};

function payload(rows: Array<Record<string, number>>, extra: Partial<WidgetDataPayload> = {}): WidgetDataPayload {
  return {
    sources: { tokens: { columns: ['totalTokens'], rows, truncated: false, tookMs: 3 } },
    warnings: [],
    computedAt: new Date().toISOString(),
    ...extra,
  };
}

function renderHost(): void {
  render(<WidgetHost item={ITEM} spec={STAT_SPEC} context={{ projectId: null }} />);
}

beforeEach(() => {
  runWidget.mockReset();
  resetBreaker.mockReset().mockResolvedValue({ ok: true });
});

// ---------------------------------------------------------------------------

describe('WidgetHost', () => {
  it('shows a skeleton, then the resolved body', async () => {
    let resolve!: (value: WidgetDataPayload) => void;
    runWidget.mockReturnValue(new Promise<WidgetDataPayload>((r) => { resolve = r; }));

    renderHost();
    expect(screen.getByTestId('widget-loading')).toBeInTheDocument();

    resolve(payload([{ totalTokens: 12_400 }]));
    expect(await screen.findByTestId('widget-stat')).toHaveTextContent('12k');
    expect(screen.queryByTestId('widget-loading')).toBeNull();
  });

  it('shows the empty state when the run succeeded with no rows', async () => {
    runWidget.mockResolvedValue(payload([]));
    renderHost();
    expect(await screen.findByTestId('widget-empty')).toHaveTextContent('Nothing to show yet.');
  });

  it('shows the error with a Retry, and the Retry re-runs the query', async () => {
    runWidget.mockRejectedValueOnce(new Error('invalid_spec:render.source'));
    renderHost();

    expect(await screen.findByTestId('widget-error')).toHaveTextContent('invalid_spec:render.source');
    runWidget.mockResolvedValueOnce(payload([{ totalTokens: 7 }]));

    await userEvent.click(screen.getByTestId('widget-error-retry'));
    expect(await screen.findByTestId('widget-stat')).toHaveTextContent('7');
    expect(runWidget).toHaveBeenCalledTimes(2);
  });

  it('shows the paused state and resets the breaker before refetching', async () => {
    runWidget.mockResolvedValueOnce(payload([], { paused: { tookMs: 4210 } }));
    renderHost();

    const paused = await screen.findByTestId('widget-paused');
    expect(paused).toHaveTextContent('4210ms');

    runWidget.mockResolvedValueOnce(payload([{ totalTokens: 3 }]));
    await userEvent.click(screen.getByTestId('widget-paused-retry'));

    await waitFor(() => expect(resetBreaker).toHaveBeenCalledTimes(1));
    expect(resetBreaker).toHaveBeenCalledWith({
      widget: ITEM.widget,
      settings: ITEM.settings,
      context: { projectId: null },
    });
    expect(await screen.findByTestId('widget-stat')).toHaveTextContent('3');
  });

  it('keeps the last good payload when a refresh fails, and says the data is stale', async () => {
    runWidget.mockResolvedValueOnce(payload([{ totalTokens: 9 }]));
    renderHost();
    expect(await screen.findByTestId('widget-stat')).toHaveTextContent('9');

    // A second run through the same host: a failure must not blank the body.
    // Driven through the visibility path, which is the same refetch the
    // interval performs — without waiting out a 60s timer.
    runWidget.mockRejectedValueOnce(new Error('database is locked'));
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(runWidget).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId('widget-frame-inst-1-status')).toHaveTextContent('database is locked'),
    );
    expect(screen.getByTestId('widget-stat')).toHaveTextContent('9');
  });

  it('renders the unavailable state when no spec resolves', () => {
    render(<WidgetHost item={ITEM} spec={null} context={{ projectId: null }} />);
    expect(screen.getByTestId('widget-unavailable')).toHaveTextContent('This widget is not available');
    expect(runWidget).not.toHaveBeenCalled();
  });

  it('passes the item refresh override through to the query, clamped to the shared limits', async () => {
    runWidget.mockResolvedValue(payload([{ totalTokens: 1 }]));
    render(
      <WidgetHost
        item={{ ...ITEM, refreshSec: 5 }}
        spec={STAT_SPEC}
        context={{ projectId: 12 }}
      />,
    );
    await screen.findByTestId('widget-stat');
    expect(runWidget).toHaveBeenCalledWith({
      widget: ITEM.widget,
      settings: {},
      context: { projectId: 12 },
      refreshSec: 15,
    });
  });
});
