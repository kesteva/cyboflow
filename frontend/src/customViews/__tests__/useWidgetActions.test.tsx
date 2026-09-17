/**
 * useWidgetActions — the consent model, end to end
 * (docs/proposals/CUSTOM-VIEWS.md §4.4, §10's "Consent").
 *
 * Three rules are load-bearing and each has a test:
 *
 *   1. A parent-rendered button with `confirm: false` runs straight away — it
 *      IS a user gesture.
 *   2. The SAME action, requested by a tier-3 frame, still opens the dialog.
 *      Script can call `cyboflow.act()` on load, so a frame request is never a
 *      gesture and the spec's opt-out does not apply to it.
 *   3. Nothing runs from a view with no saved identity: the controls are
 *      disabled and a request reports why instead of firing.
 *
 * Plus the failure surfaces the server can return — `stale_row` / `stale_view`
 * come back as a CONFLICT whose message IS the code, and the widget shows it.
 */
import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LayoutItem, WidgetDataPayload, WidgetSpec } from '../../../../shared/types/customViews';

const runWidget = vi.fn();
const previewAction = vi.fn();
const executeAction = vi.fn();

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      customViews: {
        runWidget: { query: (input: unknown) => runWidget(input) },
        resetBreaker: { mutate: vi.fn() },
        previewAction: { query: (input: unknown) => previewAction(input) },
        executeAction: { mutate: (input: unknown) => executeAction(input) },
        listViews: { query: vi.fn(() => Promise.resolve([])) },
        getActiveView: { query: vi.fn(() => Promise.resolve({ viewId: 'default' })) },
        listWidgets: { query: vi.fn(() => Promise.resolve([])) },
        onWidgetDraft: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
      },
      customWidgetServer: {
        ensure: {
          mutate: vi.fn(() =>
            Promise.resolve({ baseUrl: 'http://127.0.0.1:5000/tok', origin: 'http://127.0.0.1:5000' }),
          ),
        },
      },
    },
  },
}));

const navigateToProposalTarget = vi.fn();
vi.mock('../../components/agentRail/proposalNavigation', () => ({
  navigateToProposalTarget: (target: unknown) => navigateToProposalTarget(target),
}));

import { WidgetHost } from '../WidgetHost';
import { ViewIdentityContext, type ViewIdentity } from '../viewContext';
import { useCustomViewsStore } from '../../stores/customViewsStore';
import { WIDGET_ACT_MESSAGE } from '../../../../shared/customViews/widgetDocument';

// ---------------------------------------------------------------------------
// Fixtures — a list widget with one header action and one row action
// ---------------------------------------------------------------------------

function listSpec(confirm: boolean | undefined): WidgetSpec {
  return {
    version: 1,
    sources: { recent: { type: 'sql', sql: 'SELECT id, name FROM sessions' } },
    render: { type: 'shape', shape: 'list', source: 'recent', title: 'name' },
    actions: [
      { id: 'refresh-all', label: 'Refresh all', kind: 'navigate', params: {}, placement: 'header', confirm },
      {
        id: 'open',
        label: 'Open',
        kind: 'open-session',
        placement: 'row',
        rowKey: 'id',
        params: { target: 'quick-session', sessionId: '{row.id}' },
        confirm,
      },
    ],
  };
}

const ITEM: LayoutItem = {
  instanceId: 'inst-9',
  widget: { type: 'custom', widgetId: 'w-1' },
  settings: {},
};

const SAVED: ViewIdentity = { viewId: 'view-1', viewRevision: 6, editing: false };

const PAYLOAD: WidgetDataPayload = {
  sources: {
    recent: {
      columns: ['id', 'name'],
      rows: [{ id: 's-1', name: 'humble-plain' }],
      truncated: false,
      tookMs: 2,
    },
  },
  warnings: [],
  computedAt: new Date().toISOString(),
};

function renderHost(spec: WidgetSpec, identity: ViewIdentity = SAVED): void {
  render(
    <ViewIdentityContext.Provider value={identity}>
      <WidgetHost item={ITEM} spec={spec} context={{ projectId: null }} />
    </ViewIdentityContext.Provider>,
  );
}

beforeEach(() => {
  runWidget.mockReset().mockResolvedValue(PAYLOAD);
  previewAction.mockReset();
  executeAction.mockReset();
  navigateToProposalTarget.mockReset();
});

// ---------------------------------------------------------------------------

describe('useWidgetActions — parent-rendered buttons', () => {
  it('runs a confirm:false header button without a dialog', async () => {
    executeAction.mockResolvedValue({ ok: true, result: { ok: true, status: 'executed' } });
    renderHost(listSpec(false));

    await userEvent.click(await screen.findByTestId('widget-header-action-refresh-all'));

    expect(previewAction).not.toHaveBeenCalled();
    await waitFor(() => expect(executeAction).toHaveBeenCalledTimes(1));
    const call = executeAction.mock.calls[0][0] as Record<string, unknown>;
    expect(call.viewId).toBe('view-1');
    expect(call.viewRevision).toBe(6);
    expect(call.instanceId).toBe('inst-9');
    expect(typeof call.operationId).toBe('string');
    expect(await screen.findByTestId('widget-frame-inst-9-status')).toHaveTextContent('Executed.');
  });

  it('confirms a row action whose spec does not opt out, and sends only the row KEY', async () => {
    previewAction.mockResolvedValue({
      label: 'Open',
      kind: 'open-session',
      resolvedParams: { target: 'quick-session', sessionId: 's-1' },
    });
    executeAction.mockResolvedValue({
      ok: true,
      navigation: { target: 'quick-session', sessionId: 's-1' },
    });
    renderHost(listSpec(undefined));

    await userEvent.click(await screen.findByTestId('widget-row-action-open-s-1'));

    // The dialog body is the SERVER's resolved params, not the client's guess.
    expect(await screen.findByText(/"sessionId": "s-1"/)).toBeInTheDocument();
    expect(executeAction).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(executeAction).toHaveBeenCalledTimes(1));
    expect((executeAction.mock.calls[0][0] as Record<string, unknown>).rowKeyValue).toBe('s-1');
    await waitFor(() => expect(navigateToProposalTarget).toHaveBeenCalledTimes(1));
  });

  it('reports a stale_row conflict inline instead of pretending it worked', async () => {
    previewAction.mockRejectedValue(new Error('stale_row'));
    renderHost(listSpec(undefined));

    await userEvent.click(await screen.findByTestId('widget-row-action-open-s-1'));
    expect(await screen.findByTestId('widget-frame-inst-9-status')).toHaveTextContent('Failed: stale_row');
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('reports a stale_view conflict raised at execute time', async () => {
    executeAction.mockRejectedValue(new Error('stale_view'));
    renderHost(listSpec(false));

    await userEvent.click(await screen.findByTestId('widget-header-action-refresh-all'));
    expect(await screen.findByTestId('widget-frame-inst-9-status')).toHaveTextContent('Failed: stale_view');
  });

  it('shows a replayed operation as already applied rather than as a second run', async () => {
    executeAction.mockResolvedValue({ ok: true, replay: true, proposal: null });
    renderHost(listSpec(false));

    await userEvent.click(await screen.findByTestId('widget-header-action-refresh-all'));
    expect(await screen.findByTestId('widget-frame-inst-9-status')).toHaveTextContent('Already applied');
  });

  it('surfaces a fully-attempted executor failure', async () => {
    executeAction.mockResolvedValue({ ok: true, result: { ok: true, status: 'failed' } });
    renderHost(listSpec(false));

    await userEvent.click(await screen.findByTestId('widget-header-action-refresh-all'));
    expect(await screen.findByTestId('widget-frame-inst-9-status')).toHaveTextContent('Failed');
  });
});

describe('useWidgetActions — consent boundaries', () => {
  it('ALWAYS confirms a frame-originated act, even for an action with confirm:false', async () => {
    previewAction.mockResolvedValue({
      label: 'Open',
      kind: 'open-session',
      resolvedParams: { target: 'quick-session', sessionId: 's-1' },
    });
    // The tier-3 body needs a PUBLISHED revision to build the document URL.
    useCustomViewsStore.setState({
      widgets: [
        {
          id: 'w-1',
          name: 'Recent',
          description: null,
          publishedSpec: null,
          draftSpec: null,
          authoringSessionId: null,
          revision: 2,
          threadId: null,
          createdAt: '2026-09-10T00:00:00.000Z',
          updatedAt: '2026-09-10T00:00:00.000Z',
        },
      ],
    });
    const htmlSpec: WidgetSpec = { ...listSpec(false), render: { type: 'html', html: '<p>hi</p>' } };
    render(
      <ViewIdentityContext.Provider value={SAVED}>
        <WidgetHost item={ITEM} spec={htmlSpec} context={{ projectId: null }} />
      </ViewIdentityContext.Provider>,
    );

    const frame = (await screen.findByTestId('widget-sandbox-frame')) as HTMLIFrameElement;
    const frameWindow = { postMessage: vi.fn() };
    Object.defineProperty(frame, 'contentWindow', { value: frameWindow, configurable: true });

    const event = new MessageEvent('message', {
      data: { type: WIDGET_ACT_MESSAGE, actionId: 'open', rowKeyValue: 's-1' },
      origin: 'null',
    });
    Object.defineProperty(event, 'source', { value: frameWindow });
    act(() => {
      window.dispatchEvent(event);
    });

    // `confirm: false` is IGNORED for a frame request: the dialog still opens
    // with the server-resolved params, and nothing executes until Confirm.
    expect(await screen.findByText(/"sessionId": "s-1"/)).toBeInTheDocument();
    expect(executeAction).not.toHaveBeenCalled();

    executeAction.mockResolvedValue({ ok: true, navigation: { target: 'quick-session', sessionId: 's-1' } });
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(executeAction).toHaveBeenCalledTimes(1));
  });

  it('disables every control and refuses a request when no saved view backs the render', async () => {
    renderHost(listSpec(false), { viewId: null, viewRevision: null, editing: false });

    const header = await screen.findByTestId('widget-header-action-refresh-all');
    expect(header).toBeDisabled();
    expect(screen.getByTestId('widget-row-action-open-s-1')).toBeDisabled();
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('disables every control in customize mode even on a saved view', async () => {
    renderHost(listSpec(false), { viewId: 'view-1', viewRevision: 6, editing: true });

    expect(await screen.findByTestId('widget-header-action-refresh-all')).toBeDisabled();
    expect(screen.getByTestId('widget-row-action-open-s-1')).toBeDisabled();
  });
});
