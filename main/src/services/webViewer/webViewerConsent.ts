/**
 * webViewerConsent — who may observe or drive a web tab, and the prompt that
 * asks the human when the answer is "only with permission".
 *
 * GRANT KEY: (runId, tabId, principal, navigationEpoch), checked at DISPATCH.
 * Keying on the tab alone is an escalation: approve drive on localhost:5173 →
 * navigate the same tab to github.com → `eval` now runs in a github.com document
 * with the user's session. So a grant names the principal it was given for (the
 * top-frame origin in v1) and the navigation epoch it was given at, and every
 * check re-resolves both. A cross-document navigation drops the tab's grants; a
 * same-origin IN-PAGE change (pushState, hash) keeps them — same document, same
 * principal — and rebinds them to the new epoch.
 *
 * NOT QuestionRouter. That path moves the run to `awaiting_input`, supersedes an
 * existing pending question, and runs plan-approval side effects on an answer —
 * a web-consent prompt could clobber a real agent gate or, worse, have "Allow"
 * read as a plan approval. This module owns its own prompts: many can be
 * pending at once, each with its own timeout, none touching `workflow_runs` or
 * the questions table. The renderer shows each as a sheet on its tab.
 *
 * FREE ACCESS (no prompt) is narrow: the run that opened an agent tab may use it
 * while no human has touched it — AND while no human has touched ANY tab in that
 * cookie jar. The agent partition is per session, shared by its tabs, so a
 * credential typed into one agent tab would otherwise be readable through a
 * sibling's cookies.
 *
 * Every request, grant, denial, timeout and revocation is audited by the caller-
 * supplied `audit` sink (session_web_events), origin only.
 *
 * See docs/proposals/native-web-viewer.md §7.
 */
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  WebConsentCapability,
  WebConsentEvent,
  WebConsentGrant,
  WebConsentRequest,
} from '../../../../shared/types/webViewer';

export const WEB_CONSENT_EVENT = 'web-viewer:consent';

/** How long a prompt waits for the human before failing `consent_timeout`. */
export const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_REASON = 280;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface ConsentSubject {
  openedBy: 'user' | 'agent';
  openedByRunId: string | null;
  humanTouched: boolean;
  /** Any tab in this tab's cookie jar was human-touched (latched per partition). */
  partitionHumanTouched: boolean;
}

export interface ConsentFlags {
  agentObserve: boolean;
  agentDrive: boolean;
}

export type ConsentRequirement = 'disabled' | 'free' | 'grant';

/** Does this run need a grant to do this to this tab? */
export function consentRequirement(
  capability: WebConsentCapability,
  callerRunId: string,
  subject: ConsentSubject,
  flags: ConsentFlags,
): ConsentRequirement {
  // The config flags gate the capability outright — drive needs both.
  if (!flags.agentObserve) return 'disabled';
  if (capability === 'drive' && !flags.agentDrive) return 'disabled';
  const owned =
    subject.openedBy === 'agent' &&
    subject.openedByRunId !== null &&
    subject.openedByRunId === callerRunId;
  if (owned && !subject.humanTouched && !subject.partitionHumanTouched) return 'free';
  return 'grant';
}

// ---------------------------------------------------------------------------
// Grants + prompts
// ---------------------------------------------------------------------------

interface Grant extends WebConsentGrant {
  /** The principal the human approved — the top-frame origin in v1. */
  principal: string | null;
  epoch: number;
}

interface Pending {
  request: WebConsentRequest;
  principal: string | null;
  epoch: number;
  timer: ReturnType<typeof setTimeout> | null;
  waiters: Array<(result: ConsentResult) => void>;
}

export type ConsentResult =
  | { ok: true; grantId: string }
  | { ok: false; error: 'consent_denied' | 'consent_timeout' | 'origin_changed' };

export interface ConsentAuditEvent {
  sessionId: string;
  tabId: string;
  runId: string;
  kind: 'consent_requested' | 'consent_granted' | 'consent_denied' | 'consent_timeout' | 'consent_revoked';
  origin: string | null;
  detail?: string | null;
}

export interface WebViewerConsentDeps {
  audit: (event: ConsentAuditEvent) => void;
  now?: () => number;
  timeoutMs?: number;
}

export interface ConsentAsk {
  sessionId: string;
  tabId: string;
  runId: string;
  capability: WebConsentCapability;
  /** The tab's current top-frame origin — the principal a grant would bind to. */
  principal: string | null;
  epoch: number;
  reason?: string | null;
}

export class WebViewerConsent extends EventEmitter {
  private readonly grants = new Map<string, Grant>();
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: WebViewerConsentDeps) {
    super();
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? CONSENT_TIMEOUT_MS;
  }

  /**
   * A live grant covering this use RIGHT NOW, or null. Re-resolved per call: the
   * principal and epoch must both still match what the human approved.
   */
  findGrant(
    runId: string,
    tabId: string,
    capability: WebConsentCapability,
    principal: string | null,
    epoch: number,
  ): WebConsentGrant | null {
    for (const g of this.grants.values()) {
      if (g.runId !== runId || g.tabId !== tabId) continue;
      if (capability === 'drive' && g.capability !== 'drive') continue;
      if (g.epoch !== epoch || g.principal !== principal) continue;
      return this.publicGrant(g);
    }
    return null;
  }

  /**
   * Ask the human. Resolves when they answer, the prompt times out, the tab
   * navigates away from the principal, or the run/tab is revoked. An identical
   * outstanding ask (same run, tab, capability, principal, epoch) is joined, not
   * duplicated.
   */
  request(ask: ConsentAsk): Promise<ConsentResult> {
    const existing = this.grantFor(ask);
    if (existing) return Promise.resolve({ ok: true, grantId: existing.grantId });

    for (const p of this.pending.values()) {
      const r = p.request;
      if (
        r.runId === ask.runId &&
        r.tabId === ask.tabId &&
        r.capability === ask.capability &&
        p.principal === ask.principal &&
        p.epoch === ask.epoch
      ) {
        return new Promise((resolve) => p.waiters.push(resolve));
      }
    }

    const request: WebConsentRequest = {
      requestId: randomUUID(),
      sessionId: ask.sessionId,
      tabId: ask.tabId,
      runId: ask.runId,
      capability: ask.capability,
      origin: ask.principal,
      reason: ask.reason ? ask.reason.slice(0, MAX_REASON) : null,
      requestedAt: this.now(),
    };
    return new Promise((resolve) => {
      const entry: Pending = {
        request,
        principal: ask.principal,
        epoch: ask.epoch,
        timer: null,
        waiters: [resolve],
      };
      entry.timer = setTimeout(() => this.settle(request.requestId, { ok: false, error: 'consent_timeout' }), this.timeoutMs);
      this.pending.set(request.requestId, entry);
      this.audit(request, 'consent_requested', request.capability);
      this.publish({ kind: 'requested', sessionId: request.sessionId, request });
    });
  }

  /** The human's answer from the tab sheet. False when the prompt is gone. */
  respond(requestId: string, decision: 'allow' | 'deny'): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    if (decision === 'deny') {
      this.settle(requestId, { ok: false, error: 'consent_denied' });
      return true;
    }
    const grant: Grant = {
      grantId: randomUUID(),
      sessionId: p.request.sessionId,
      tabId: p.request.tabId,
      runId: p.request.runId,
      capability: p.request.capability,
      origin: p.principal,
      grantedAt: this.now(),
      principal: p.principal,
      epoch: p.epoch,
    };
    this.grants.set(grant.grantId, grant);
    this.settle(requestId, { ok: true, grantId: grant.grantId });
    return true;
  }

  /**
   * A committed navigation. Same-origin IN-PAGE → grants and prompts follow to
   * the new epoch. Anything else → grants dropped, prompts fail `origin_changed`
   * (an "Allow" clicked now would approve a document the human never saw).
   */
  onNavigation(tabId: string, next: { epoch: number; principal: string | null; inPage: boolean }): void {
    for (const g of [...this.grants.values()]) {
      if (g.tabId !== tabId) continue;
      if (next.inPage && g.principal === next.principal) {
        g.epoch = next.epoch;
      } else {
        this.grants.delete(g.grantId);
        this.audit(g, 'consent_revoked', 'navigation');
      }
    }
    for (const [id, p] of [...this.pending]) {
      if (p.request.tabId !== tabId) continue;
      if (next.inPage && p.principal === next.principal) p.epoch = next.epoch;
      else this.settle(id, { ok: false, error: 'origin_changed' });
    }
  }

  /** The run ended: every grant it holds goes, every prompt it raised is denied. */
  revokeRun(runId: string): void {
    for (const g of [...this.grants.values()]) {
      if (g.runId === runId) this.revokeGrant(g.grantId, 'run_ended');
    }
    for (const [id, p] of [...this.pending]) {
      if (p.request.runId === runId) this.settle(id, { ok: false, error: 'consent_denied' }, 'run_ended');
    }
  }

  /** The tab closed, or the human revoked everything on it. */
  revokeTab(tabId: string, why = 'revoked'): void {
    for (const g of [...this.grants.values()]) {
      if (g.tabId === tabId) this.revokeGrant(g.grantId, why);
    }
    for (const [id, p] of [...this.pending]) {
      if (p.request.tabId === tabId) this.settle(id, { ok: false, error: 'consent_denied' }, why);
    }
  }

  revokeGrant(grantId: string, why = 'revoked'): boolean {
    const g = this.grants.get(grantId);
    if (!g) return false;
    this.grants.delete(grantId);
    this.audit(g, 'consent_revoked', why);
    return true;
  }

  listGrants(sessionId: string): WebConsentGrant[] {
    return [...this.grants.values()].filter((g) => g.sessionId === sessionId).map((g) => this.publicGrant(g));
  }

  listPending(sessionId: string): WebConsentRequest[] {
    return [...this.pending.values()].filter((p) => p.request.sessionId === sessionId).map((p) => p.request);
  }

  /** Drop everything (session teardown / quit). Outstanding prompts are denied. */
  disposeSession(sessionId: string): void {
    for (const g of [...this.grants.values()]) if (g.sessionId === sessionId) this.grants.delete(g.grantId);
    for (const [id, p] of [...this.pending]) {
      if (p.request.sessionId === sessionId) this.settle(id, { ok: false, error: 'consent_denied' }, 'session_disposed');
    }
  }

  // -------------------------------------------------------------------------

  private grantFor(ask: ConsentAsk): WebConsentGrant | null {
    return this.findGrant(ask.runId, ask.tabId, ask.capability, ask.principal, ask.epoch);
  }

  private settle(requestId: string, result: ConsentResult, why?: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (p.timer) clearTimeout(p.timer);
    const kind = result.ok
      ? 'consent_granted'
      : result.error === 'consent_timeout'
        ? 'consent_timeout'
        : 'consent_denied';
    this.audit(p.request, kind, why ?? (result.ok ? p.request.capability : result.error));
    this.publish({ kind: 'resolved', sessionId: p.request.sessionId, requestId, tabId: p.request.tabId });
    for (const w of p.waiters) w(result);
  }

  private audit(
    from: { sessionId: string; tabId: string; runId: string; origin: string | null },
    kind: ConsentAuditEvent['kind'],
    detail: string | null,
  ): void {
    try {
      this.deps.audit({ sessionId: from.sessionId, tabId: from.tabId, runId: from.runId, kind, origin: from.origin, detail });
    } catch (err) {
      console.warn('[WebViewerConsent] audit write failed:', err);
    }
  }

  private publish(event: WebConsentEvent): void {
    this.emit(WEB_CONSENT_EVENT, event);
  }

  private publicGrant(g: Grant): WebConsentGrant {
    return {
      grantId: g.grantId,
      sessionId: g.sessionId,
      tabId: g.tabId,
      runId: g.runId,
      capability: g.capability,
      origin: g.origin,
      grantedAt: g.grantedAt,
    };
  }
}
