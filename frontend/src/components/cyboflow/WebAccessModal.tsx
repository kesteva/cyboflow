/**
 * WebAccessModal — the tab's agent-access view: live grants with revocation,
 * and the tab's activity (the audit trail — origin only, never a URL).
 * docs/proposals/native-web-viewer.md §7.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { WebActivityEntry, WebConsentGrant } from '../../../../shared/types/webViewer';
import { Modal, ModalBody, ModalHeader } from '../ui/Modal';
import { trpc } from '../../trpc/client';

const KIND_LABEL: Record<string, string> = {
  tab_opened: 'Opened',
  tab_closed: 'Closed',
  tab_evicted: 'Unloaded to save memory',
  tab_crashed: 'Crashed',
  human_touched: 'You interacted with it',
  consent_requested: 'Agent asked for access',
  consent_granted: 'Access granted',
  consent_denied: 'Access denied',
  consent_timeout: 'Request timed out',
  consent_revoked: 'Access revoked',
  agent_read: 'Agent read the page',
  agent_drive: 'Agent acted on the page',
};

export function WebAccessModal({
  isOpen,
  onClose,
  sessionKey,
  tabId,
}: {
  isOpen: boolean;
  onClose: () => void;
  sessionKey: string;
  tabId: string;
}): ReactElement {
  const [grants, setGrants] = useState<WebConsentGrant[]>([]);
  const [activity, setActivity] = useState<WebActivityEntry[]>([]);

  const refresh = useCallback(() => {
    void trpc.cyboflow.webViewer.grants
      .query({ sessionId: sessionKey })
      .then((all) => setGrants(all.filter((g) => g.tabId === tabId)))
      .catch(() => setGrants([]));
    void trpc.cyboflow.webViewer.activity
      .query({ sessionId: sessionKey, tabId })
      .then(setActivity)
      .catch(() => setActivity([]));
  }, [sessionKey, tabId]);

  useEffect(() => {
    if (isOpen) refresh();
  }, [isOpen, refresh]);

  const revoke = (grantId: string): void => {
    void trpc.cyboflow.webViewer.revokeGrant.mutate({ grantId }).finally(refresh);
  };
  const revokeAll = (): void => {
    void trpc.cyboflow.webViewer.revokeTab.mutate({ tabId }).finally(refresh);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      <ModalHeader title="Agent access" onClose={onClose} />
      <ModalBody>
        <div data-testid="web-access-modal" className="flex flex-col gap-4 text-xs">
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-text-primary">Active grants</h3>
              {grants.length > 0 && (
                <button
                  type="button"
                  data-testid="web-access-revoke-all"
                  onClick={revokeAll}
                  className="rounded-button border border-border-primary px-2 py-0.5 text-text-secondary hover:text-text-primary"
                >
                  Revoke all
                </button>
              )}
            </div>
            {grants.length === 0 ? (
              <p className="text-text-tertiary">No agent has access to this tab.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {grants.map((g) => (
                  <li
                    key={g.grantId}
                    data-testid={`web-access-grant-${g.grantId}`}
                    className="flex items-center justify-between rounded-button border border-border-primary px-2 py-1"
                  >
                    <span className="text-text-secondary">
                      {g.capability === 'drive' ? 'Control' : 'Read'} ·{' '}
                      <span className="font-mono">{g.origin ?? 'unknown'}</span> · run{' '}
                      <span className="font-mono">{g.runId.slice(0, 8)}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => revoke(g.grantId)}
                      className="text-status-error hover:underline"
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-text-primary">Activity</h3>
            {activity.length === 0 ? (
              <p className="text-text-tertiary">Nothing recorded yet.</p>
            ) : (
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {activity.map((e) => (
                  <li key={e.id} className="flex justify-between gap-2 text-text-secondary">
                    <span>
                      {KIND_LABEL[e.kind] ?? e.kind}
                      {e.origin && <span className="font-mono text-text-tertiary"> · {e.origin}</span>}
                    </span>
                    <span className="shrink-0 text-text-tertiary">{new Date(e.createdAt).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </ModalBody>
    </Modal>
  );
}
