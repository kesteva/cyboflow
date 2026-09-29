/**
 * Web consent, renderer side: the sheet on the tab, the strip's attention dot,
 * and the Agent access view. docs/proposals/native-web-viewer.md §7.
 */
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WebConsentRequest } from '../../../../../shared/types/webViewer';

const respondMutate = vi.fn();
const grantsQuery = vi.fn();
const activityQuery = vi.fn();
const revokeGrantMutate = vi.fn();
const revokeTabMutate = vi.fn();

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      webViewer: {
        respondConsent: { mutate: (...a: unknown[]) => respondMutate(...a) },
        grants: { query: (...a: unknown[]) => grantsQuery(...a) },
        activity: { query: (...a: unknown[]) => activityQuery(...a) },
        revokeGrant: { mutate: (...a: unknown[]) => revokeGrantMutate(...a) },
        revokeTab: { mutate: (...a: unknown[]) => revokeTabMutate(...a) },
      },
    },
  },
}));

import { WebConsentSheet } from '../WebConsentSheet';
import { WebAccessModal } from '../WebAccessModal';
import { CenterPaneTabStrip } from '../CenterPaneTabStrip';
import { useWebConsentStore } from '../../../stores/webConsentStore';
import { isOccluded, resetOcclusionForTests } from '../../../utils/occlusion';

const REQ: WebConsentRequest = {
  requestId: 'req-1',
  sessionId: 's1',
  tabId: 'web:1',
  runId: 'run-1',
  capability: 'drive',
  origin: 'http://localhost:5173',
  reason: 'check the login form',
  requestedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  respondMutate.mockResolvedValue({ ok: true });
  grantsQuery.mockResolvedValue([]);
  activityQuery.mockResolvedValue([]);
  revokeGrantMutate.mockResolvedValue({ ok: true });
  revokeTabMutate.mockResolvedValue({ ok: true });
  useWebConsentStore.setState({ byRequestId: {} });
});
afterEach(() => resetOcclusionForTests());

describe('WebConsentSheet', () => {
  it('hides the native page while shown — it would otherwise paint over the sheet', () => {
    const { unmount } = render(<WebConsentSheet request={REQ} />);
    expect(isOccluded()).toBe(true);
    unmount();
    expect(isOccluded()).toBe(false);
  });

  it('names the capability and the ORIGIN, and labels the reason as the agent’s claim', () => {
    render(<WebConsentSheet request={REQ} />);
    expect(screen.getByText(/wants to control this tab/)).toBeInTheDocument();
    expect(screen.getByText('http://localhost:5173')).toBeInTheDocument();
    expect(screen.getByTestId('web-consent-reason')).toHaveTextContent('The agent says');
  });

  it.each(['allow', 'deny'] as const)('%s answers main and clears the prompt locally', (decision) => {
    useWebConsentStore.getState().add(REQ);
    render(<WebConsentSheet request={REQ} />);
    fireEvent.click(screen.getByTestId(`web-consent-${decision}`));
    expect(respondMutate).toHaveBeenCalledWith({ requestId: 'req-1', decision });
    expect(useWebConsentStore.getState().byRequestId).toEqual({});
  });
});

describe('CenterPaneTabStrip consent dot', () => {
  const tabs = [
    { id: 'flow', kind: 'flow' as const, label: 'Flow', pinned: true },
    { id: 'web:1', kind: 'web' as const, label: 'Local', initialUrl: 'http://localhost:5173/' },
  ];

  it('marks a web tab with a waiting request, and clears when it resolves', () => {
    render(<CenterPaneTabStrip tabs={tabs} activeTabId="flow" onTabClick={vi.fn()} onTabClose={vi.fn()} />);
    expect(screen.queryByTestId('center-pane-tab-consent-web:1')).toBeNull();
    act(() => useWebConsentStore.getState().add(REQ));
    expect(screen.getByTestId('center-pane-tab-consent-web:1')).toBeInTheDocument();
    act(() => useWebConsentStore.getState().resolve('req-1'));
    expect(screen.queryByTestId('center-pane-tab-consent-web:1')).toBeNull();
  });
});

describe('WebAccessModal', () => {
  it('lists this tab’s grants only and revokes one', async () => {
    grantsQuery.mockResolvedValue([
      { grantId: 'g1', sessionId: 's1', tabId: 'web:1', runId: 'run-1234567890', capability: 'drive', origin: 'http://localhost:5173', grantedAt: 1 },
      { grantId: 'g2', sessionId: 's1', tabId: 'web:2', runId: 'run-2', capability: 'observe', origin: 'https://x.test', grantedAt: 1 },
    ]);
    render(<WebAccessModal isOpen onClose={vi.fn()} sessionKey="s1" tabId="web:1" />);
    await waitFor(() => expect(screen.getByTestId('web-access-grant-g1')).toBeInTheDocument());
    expect(screen.queryByTestId('web-access-grant-g2')).toBeNull();
    fireEvent.click(screen.getByText('Revoke'));
    expect(revokeGrantMutate).toHaveBeenCalledWith({ grantId: 'g1' });
  });

  it('revokes everything on the tab', async () => {
    grantsQuery.mockResolvedValue([
      { grantId: 'g1', sessionId: 's1', tabId: 'web:1', runId: 'run-1', capability: 'observe', origin: null, grantedAt: 1 },
    ]);
    render(<WebAccessModal isOpen onClose={vi.fn()} sessionKey="s1" tabId="web:1" />);
    await waitFor(() => screen.getByTestId('web-access-revoke-all'));
    fireEvent.click(screen.getByTestId('web-access-revoke-all'));
    expect(revokeTabMutate).toHaveBeenCalledWith({ tabId: 'web:1' });
  });
});
