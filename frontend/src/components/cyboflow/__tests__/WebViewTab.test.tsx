/**
 * WebViewTab — the center-pane body for a `web` tab.
 *
 * The page is NOT in this tree: it is a main-process WebContentsView composited
 * over the anchor rect. So what this suite can assert is the contract between the
 * component and main — that the anchor exists and is measured, that visibility
 * follows mount/unmount (a native view left visible would paint over whatever
 * tab replaced it), and that the three states a human has to resolve
 * (crashed / auth / TLS) render an explanation rather than an empty rect.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { acquireOcclusion, resetOcclusionForTests } from '../../../utils/occlusion';
import { useWebConsentStore } from '../../../stores/webConsentStore';
import type { TabItem } from '../../../../../shared/types/centerPane';
import type { WebTabSnapshot } from '../../../../../shared/types/webViewer';

const getQuery = vi.fn();
const setVisibleMutate = vi.fn();
const setBoundsMutate = vi.fn();
const reloadMutate = vi.fn();
const onTabStateSubscribe = vi.fn();

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      webViewer: {
        get: { query: (...a: unknown[]) => getQuery(...a) },
        setVisible: { mutate: (...a: unknown[]) => setVisibleMutate(...a) },
        setBounds: { mutate: (...a: unknown[]) => setBoundsMutate(...a) },
        reload: { mutate: (...a: unknown[]) => reloadMutate(...a) },
        back: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
        forward: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
        onTabState: { subscribe: (...a: unknown[]) => onTabStateSubscribe(...a) },
      },
    },
  },
}));

import { WebViewTab } from '../WebViewTab';

const TAB: TabItem = {
  id: 'web:aaaa',
  kind: 'web',
  label: 'docs.anthropic.com',
  initialUrl: 'https://docs.anthropic.com/en/docs',
  currentUrl: 'https://docs.anthropic.com/en/docs',
  openedBy: 'user',
};

function snapshot(over: Partial<WebTabSnapshot> = {}): WebTabSnapshot {
  return {
    tabId: TAB.id,
    sessionId: 'sess-1',
    state: 'live',
    currentUrl: TAB.currentUrl ?? null,
    title: 'Docs',
    openedBy: 'user',
    openedByRunId: null,
    humanTouched: false,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    blockedReason: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getQuery.mockResolvedValue(snapshot());
  setVisibleMutate.mockResolvedValue({ ok: true });
  setBoundsMutate.mockResolvedValue({ ok: true });
  reloadMutate.mockResolvedValue({ ok: true });
  onTabStateSubscribe.mockReturnValue({ unsubscribe: vi.fn() });
});

afterEach(() => resetOcclusionForTests());

describe('WebViewTab', () => {
  it('renders the bounds anchor keyed to the tab id', () => {
    render(<WebViewTab tab={TAB} sessionKey="sess-1" active />);
    const anchor = screen.getByTestId('web-view-tab-anchor');
    expect(anchor).toBeInTheDocument();
    expect(anchor).toHaveAttribute('data-web-tab-id', TAB.id);
  });

  it('shows the tab URL and never an <img> favicon', () => {
    // No favicon in v1 on purpose: the packaged renderer CSP's img-src would
    // block a remote one, so it would work in dev and break in every build.
    const { container } = render(<WebViewTab tab={TAB} sessionKey="sess-1" active />);
    expect(screen.getByTestId('web-view-tab-url')).toHaveTextContent(
      'https://docs.anthropic.com/en/docs',
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('makes the view visible on mount and HIDES it on unmount', async () => {
    const { unmount } = render(<WebViewTab tab={TAB} sessionKey="sess-1" active />);
    await waitFor(() =>
      expect(setVisibleMutate).toHaveBeenCalledWith({ tabId: TAB.id, visible: true }),
    );

    unmount();
    // Only the ACTIVE tab's body is mounted, so an unmount means the user
    // switched tabs — a view left visible would paint over the new one.
    expect(setVisibleMutate).toHaveBeenCalledWith({ tabId: TAB.id, visible: false });
  });

  it('hides the view while an overlay holds an occlusion lease, and restores it after', async () => {
    // A native view paints above all DOM: a modal left showing would render
    // BEHIND the page. §3.7.
    render(<WebViewTab tab={TAB} sessionKey="sess-1" active />);
    await waitFor(() =>
      expect(setVisibleMutate).toHaveBeenLastCalledWith({ tabId: TAB.id, visible: true }),
    );
    let release: () => void = () => {};
    act(() => {
      release = acquireOcclusion('test-modal');
    });
    expect(setVisibleMutate).toHaveBeenLastCalledWith({ tabId: TAB.id, visible: false });
    act(() => release());
    expect(setVisibleMutate).toHaveBeenLastCalledWith({ tabId: TAB.id, visible: true });
  });

  it('covers the tab with the consent sheet while an agent request is pending — and hides the page', async () => {
    act(() =>
      useWebConsentStore.getState().add({
        requestId: 'r1', sessionId: 'sess-1', tabId: TAB.id, runId: 'run-1',
        capability: 'observe', origin: 'https://docs.anthropic.com', reason: null, requestedAt: 1,
      }),
    );
    render(<WebViewTab tab={TAB} sessionKey="sess-1" active />);
    expect(screen.getByTestId('web-consent-sheet')).toBeInTheDocument();
    await waitFor(() =>
      expect(setVisibleMutate).toHaveBeenLastCalledWith({ tabId: TAB.id, visible: false }),
    );
    act(() => useWebConsentStore.setState({ byRequestId: {} }));
  });

  it('never makes an inactive tab visible', async () => {
    render(<WebViewTab tab={TAB} sessionKey="sess-1" active={false} />);
    await waitFor(() => expect(setVisibleMutate).toHaveBeenCalled());
    expect(setVisibleMutate).not.toHaveBeenCalledWith({ tabId: TAB.id, visible: true });
  });

  it('marks an agent-opened tab in the chrome', () => {
    render(
      <WebViewTab tab={{ ...TAB, openedBy: 'agent' }} sessionKey="sess-1" active />,
    );
    expect(screen.getByTestId('web-view-tab-agent-badge')).toBeInTheDocument();
  });

  it('enables back/forward only when main says the history exists', async () => {
    getQuery.mockResolvedValue(snapshot({ canGoBack: true, canGoForward: false }));
    render(<WebViewTab tab={TAB} sessionKey="sess-1" active />);

    await waitFor(() => expect(screen.getByTestId('web-view-tab-back')).toBeEnabled());
    expect(screen.getByTestId('web-view-tab-forward')).toBeDisabled();
  });

  it.each([
    ['crashed', 'This page crashed.'],
    ['auth_required', 'This page asked for a username and password.'],
    ['certificate_error', 'certificate could not be verified'],
  ] as const)('explains the %s state instead of leaving a blank rect', async (state, text) => {
    getQuery.mockResolvedValue(snapshot({ state, blockedReason: 'SOME_DETAIL' }));
    render(<WebViewTab tab={TAB} sessionKey="sess-1" active />);

    await waitFor(() => expect(screen.getByTestId('web-view-tab-blocked')).toBeInTheDocument());
    expect(screen.getByTestId('web-view-tab-blocked')).toHaveTextContent(text);
    expect(screen.getByTestId('web-view-tab-blocked')).toHaveTextContent('SOME_DETAIL');
  });

  it('offers a reload only for a crash — recovery there is a FRESH view', async () => {
    getQuery.mockResolvedValue(snapshot({ state: 'crashed' }));
    render(<WebViewTab tab={TAB} sessionKey="sess-1" active />);
    await waitFor(() => expect(screen.getByTestId('web-view-tab-recover')).toBeInTheDocument());

    getQuery.mockResolvedValue(snapshot({ state: 'certificate_error' }));
    render(<WebViewTab tab={{ ...TAB, id: 'web:bbbb' }} sessionKey="sess-1" active />);
    // A TLS/auth block is a human's to resolve, never something a reload retries
    // into — and never something a drive grant can unlock.
    await waitFor(() => expect(screen.getAllByTestId('web-view-tab-blocked')).toHaveLength(2));
    expect(screen.getAllByTestId('web-view-tab-recover')).toHaveLength(1);
  });

  it('renders nothing blocking for a healthy tab', async () => {
    render(<WebViewTab tab={TAB} sessionKey="sess-1" active />);
    await waitFor(() => expect(getQuery).toHaveBeenCalled());
    expect(screen.queryByTestId('web-view-tab-blocked')).toBeNull();
  });
});
