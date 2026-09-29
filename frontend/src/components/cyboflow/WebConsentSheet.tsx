/**
 * WebConsentSheet — an agent's request to read or control this tab, shown ON the
 * tab it concerns (docs/proposals/native-web-viewer.md §7).
 *
 * The page is a native view that paints above all DOM, so the sheet holds an
 * occlusion lease: the page is hidden while the human decides. What the sheet
 * shows is the ORIGIN, never a URL — the decision is "this site", and the full
 * address is exactly what the agent is not yet allowed to see. The agent's
 * stated reason is labelled as its claim.
 */
import type { ReactElement } from 'react';
import { ShieldQuestion } from 'lucide-react';
import type { WebConsentRequest } from '../../../../shared/types/webViewer';
import { useOcclusion } from '../../hooks/useOcclusion';
import { trpc } from '../../trpc/client';
import { useWebConsentStore } from '../../stores/webConsentStore';

export function WebConsentSheet({ request }: { request: WebConsentRequest }): ReactElement {
  useOcclusion(true, 'web-consent');
  const resolve = useWebConsentStore((s) => s.resolve);

  const answer = (decision: 'allow' | 'deny'): void => {
    // Optimistic: the prompt is gone from THIS surface either way; main's
    // `resolved` event is idempotent with it.
    resolve(request.requestId);
    void trpc.cyboflow.webViewer.respondConsent
      .mutate({ requestId: request.requestId, decision })
      .catch((err: unknown) => console.warn('[WebConsentSheet] respond failed:', err));
  };

  const verb = request.capability === 'drive' ? 'control' : 'read';
  return (
    <div
      role="dialog"
      aria-label="Agent access request"
      data-testid="web-consent-sheet"
      className="absolute inset-0 z-10 flex items-center justify-center bg-surface-primary px-6"
    >
      <div className="flex max-w-md flex-col gap-3 rounded-card border border-border-primary bg-surface-secondary p-4">
        <div className="flex items-center gap-2">
          <ShieldQuestion className="h-5 w-5 text-status-warning" />
          <p className="text-sm font-medium text-text-primary">
            An agent wants to {verb} this tab
          </p>
        </div>
        <p className="text-xs text-text-secondary">
          Site: <span className="font-mono text-text-primary">{request.origin ?? 'unknown'}</span>
        </p>
        <p className="text-xs text-text-tertiary">
          {request.capability === 'drive'
            ? 'It could click, type, navigate and run scripts in this page, using whatever you are signed in as.'
            : 'It could read this page’s content, console and network activity, including anything you are signed in to see.'}{' '}
          Access ends if the page navigates to another document, and when the run ends.
        </p>
        {request.reason && (
          <p data-testid="web-consent-reason" className="text-xs text-text-secondary">
            The agent says: <span className="italic">“{request.reason}”</span>
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="web-consent-deny"
            onClick={() => answer('deny')}
            className="rounded-button border border-border-primary px-3 py-1 text-xs text-text-secondary hover:border-border-emphasized hover:text-text-primary"
          >
            Deny
          </button>
          <button
            type="button"
            data-testid="web-consent-allow"
            onClick={() => answer('allow')}
            className="rounded-button bg-interactive px-3 py-1 text-xs text-text-on-interactive hover:bg-interactive-hover"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
