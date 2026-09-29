/**
 * webViewerConsent — the grant key, the prompt lifecycle, revocation, and the
 * narrow free-access rule. docs/proposals/native-web-viewer.md §7.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consentRequirement,
  WebViewerConsent,
  WEB_CONSENT_EVENT,
  type ConsentAuditEvent,
  type ConsentSubject,
} from '../webViewerConsent';
import type { WebConsentEvent } from '../../../../../shared/types/webViewer';

const ON = { agentObserve: true, agentDrive: true };
const agentTab = (over: Partial<ConsentSubject> = {}): ConsentSubject => ({
  openedBy: 'agent',
  openedByRunId: 'run-1',
  humanTouched: false,
  partitionHumanTouched: false,
  ...over,
});

describe('consentRequirement', () => {
  it('is disabled when the config flags are off — drive needs BOTH flags', () => {
    expect(consentRequirement('observe', 'run-1', agentTab(), { agentObserve: false, agentDrive: true })).toBe('disabled');
    expect(consentRequirement('drive', 'run-1', agentTab(), { agentObserve: true, agentDrive: false })).toBe('disabled');
    expect(consentRequirement('observe', 'run-1', agentTab(), { agentObserve: true, agentDrive: false })).toBe('free');
  });

  it('is free only for the OWNING run on its own untouched agent tab', () => {
    expect(consentRequirement('drive', 'run-1', agentTab(), ON)).toBe('free');
    expect(consentRequirement('observe', 'run-2', agentTab(), ON)).toBe('grant');
    expect(consentRequirement('observe', 'run-1', agentTab({ openedBy: 'user', openedByRunId: null }), ON)).toBe('grant');
  });

  it('gates a tab a human touched, and every tab in a jar a human touched', () => {
    expect(consentRequirement('observe', 'run-1', agentTab({ humanTouched: true }), ON)).toBe('grant');
    // A credential typed into a SIBLING agent tab is reachable through the
    // shared per-session cookie jar.
    expect(consentRequirement('observe', 'run-1', agentTab({ partitionHumanTouched: true }), ON)).toBe('grant');
  });
});

describe('WebViewerConsent', () => {
  let audit: ConsentAuditEvent[];
  let events: WebConsentEvent[];
  let consent: WebViewerConsent;
  const ask = (over: Partial<Parameters<WebViewerConsent['request']>[0]> = {}) => ({
    sessionId: 's1',
    tabId: 'web:1',
    runId: 'run-1',
    capability: 'observe' as const,
    principal: 'http://localhost:5173',
    epoch: 3,
    reason: 'check the console',
    ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    audit = [];
    events = [];
    consent = new WebViewerConsent({ audit: (e) => audit.push(e), timeoutMs: 1000 });
    consent.on(WEB_CONSENT_EVENT, (e: WebConsentEvent) => events.push(e));
  });
  afterEach(() => vi.useRealTimers());

  const pendingId = () => consent.listPending('s1')[0].requestId;

  it('publishes a prompt carrying the ORIGIN only, and grants on allow', async () => {
    const result = consent.request(ask());
    expect(events[0]).toMatchObject({ kind: 'requested', request: { origin: 'http://localhost:5173', tabId: 'web:1' } });
    consent.respond(pendingId(), 'allow');
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(consent.findGrant('run-1', 'web:1', 'observe', 'http://localhost:5173', 3)).not.toBeNull();
    expect(audit.map((a) => a.kind)).toEqual(['consent_requested', 'consent_granted']);
  });

  it('fails consent_denied on deny and consent_timeout when nobody answers', async () => {
    const denied = consent.request(ask());
    consent.respond(pendingId(), 'deny');
    await expect(denied).resolves.toEqual({ ok: false, error: 'consent_denied' });

    const timed = consent.request(ask({ tabId: 'web:2' }));
    vi.advanceTimersByTime(1000);
    await expect(timed).resolves.toEqual({ ok: false, error: 'consent_timeout' });
    expect(consent.listPending('s1')).toEqual([]);
  });

  it('keeps concurrent prompts independent, and joins an identical one', async () => {
    const a = consent.request(ask());
    const a2 = consent.request(ask());
    const b = consent.request(ask({ tabId: 'web:2' }));
    expect(consent.listPending('s1')).toHaveLength(2);
    const [first, second] = consent.listPending('s1');
    consent.respond(first.requestId, 'allow');
    consent.respond(second.requestId, 'deny');
    await expect(a).resolves.toMatchObject({ ok: true });
    await expect(a2).resolves.toMatchObject({ ok: true });
    await expect(b).resolves.toMatchObject({ ok: false });
  });

  it('drive covers observe, never the reverse', async () => {
    const p = consent.request(ask({ capability: 'drive' }));
    consent.respond(pendingId(), 'allow');
    await p;
    expect(consent.findGrant('run-1', 'web:1', 'observe', 'http://localhost:5173', 3)).not.toBeNull();
    const q = consent.request(ask({ runId: 'run-2' }));
    consent.respond(pendingId(), 'allow');
    await q;
    expect(consent.findGrant('run-2', 'web:1', 'drive', 'http://localhost:5173', 3)).toBeNull();
  });

  it('binds a grant to the run that asked — another run gets nothing', async () => {
    const p = consent.request(ask());
    consent.respond(pendingId(), 'allow');
    await p;
    expect(consent.findGrant('run-2', 'web:1', 'observe', 'http://localhost:5173', 3)).toBeNull();
  });

  describe('navigation', () => {
    async function granted() {
      const p = consent.request(ask({ capability: 'drive' }));
      consent.respond(pendingId(), 'allow');
      await p;
    }

    it('keeps a grant across a same-origin IN-PAGE change, rebound to the new epoch', async () => {
      await granted();
      consent.onNavigation('web:1', { epoch: 4, principal: 'http://localhost:5173', inPage: true });
      expect(consent.findGrant('run-1', 'web:1', 'drive', 'http://localhost:5173', 4)).not.toBeNull();
      expect(consent.findGrant('run-1', 'web:1', 'drive', 'http://localhost:5173', 3)).toBeNull();
    });

    it('drops the grant on a cross-document navigation — the localhost → github.com escalation', async () => {
      await granted();
      consent.onNavigation('web:1', { epoch: 4, principal: 'https://github.com', inPage: false });
      expect(consent.findGrant('run-1', 'web:1', 'drive', 'https://github.com', 4)).toBeNull();
      expect(consent.listGrants('s1')).toEqual([]);
    });

    it('drops it on a same-origin FULL navigation too (a new document)', async () => {
      await granted();
      consent.onNavigation('web:1', { epoch: 4, principal: 'http://localhost:5173', inPage: false });
      expect(consent.listGrants('s1')).toEqual([]);
    });

    it('never lets a stale grant match a mismatched principal at the same epoch', async () => {
      await granted();
      expect(consent.findGrant('run-1', 'web:1', 'drive', 'https://github.com', 3)).toBeNull();
    });

    it('fails an open prompt origin_changed when the tab navigates under it', async () => {
      const p = consent.request(ask());
      consent.onNavigation('web:1', { epoch: 4, principal: 'https://github.com', inPage: false });
      await expect(p).resolves.toEqual({ ok: false, error: 'origin_changed' });
    });
  });

  describe('revocation', () => {
    it('revokeRun drops the run’s grants and denies its open prompts', async () => {
      const g = consent.request(ask());
      consent.respond(pendingId(), 'allow');
      await g;
      const open = consent.request(ask({ tabId: 'web:2' }));
      consent.revokeRun('run-1');
      expect(consent.listGrants('s1')).toEqual([]);
      await expect(open).resolves.toEqual({ ok: false, error: 'consent_denied' });
      expect(audit.map((a) => a.kind)).toContain('consent_revoked');
    });

    it('revokeTab and revokeGrant remove exactly what they name', async () => {
      for (const tabId of ['web:1', 'web:2']) {
        const p = consent.request(ask({ tabId }));
        consent.respond(pendingId(), 'allow');
        await p;
      }
      consent.revokeTab('web:1');
      expect(consent.listGrants('s1').map((g) => g.tabId)).toEqual(['web:2']);
      expect(consent.revokeGrant(consent.listGrants('s1')[0].grantId)).toBe(true);
      expect(consent.listGrants('s1')).toEqual([]);
    });

    it('a late answer to a resolved prompt is a no-op', async () => {
      const p = consent.request(ask());
      const id = pendingId();
      consent.revokeTab('web:1');
      await p;
      expect(consent.respond(id, 'allow')).toBe(false);
      expect(consent.listGrants('s1')).toEqual([]);
    });
  });
});
