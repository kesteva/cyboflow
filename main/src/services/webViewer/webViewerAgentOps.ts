/**
 * webViewerAgentOps — what an AGENT may do with web tabs: list, read, open.
 * The MCP tool handlers (orchestrator layer) reach this through the
 * `WebViewerAgentLike` seam; this module is where the consent rules are applied.
 *
 * THE ORDER OF A READ, and why:
 *   1. Scope. A tab outside the caller's session is `tab_not_found` — never a
 *      different error that would confirm it exists.
 *   2. Load. An evicted tab is re-navigated BEFORE consent is resolved: a reload
 *      commits a new navigation epoch, which (correctly) drops every grant bound
 *      to the old one — resolving consent first would hand the human a prompt
 *      whose answer the reload then throws away.
 *   3. Consent for the TOP principal (the tab's origin), then the frame snapshot,
 *      then consent for every OTHER principal in it (§3.3: `frame: 'all'` over a
 *      page with a cross-origin artifact iframe needs two grants, not one).
 *   4. Recheck immediately before reading: the top principal and epoch must be
 *      the ones consented to (`origin_changed`), a frame's principal must be the
 *      one in the snapshot (`frame_principal_changed`), and a provisional
 *      navigation fails `navigating` rather than racing it.
 *
 * WHAT IS FREE. Only a tab this run opened itself, never human-touched, in a
 * cookie jar no human has touched (`consentRequirement`). Everything else —
 * including listing a tab's URL and title — needs a live grant. A pre-grant
 * listing carries the opaque id, state, opener and ORIGIN only.
 *
 * See docs/proposals/native-web-viewer.md §6–7.
 */
import { makeWebTabId } from '../../../../shared/types/centerPane';
import type {
  AgentCaller,
  AgentDriveArgs,
  AgentDriveResult,
  AgentFrameRead,
  AgentReadArgs,
  AgentReadResult,
  AgentResult,
  AgentTelemetrySlice,
  AgentWebTab,
  WebViewerAgentLike,
  WebViewerOpenArgs,
  WebViewerOpenResult,
} from '../../orchestrator/trpc/contracts/webViewerOps';
import type { WebConsentCapability, WebTabSnapshot } from '../../../../shared/types/webViewer';
import type { WebViewerAck } from '../../orchestrator/trpc/contracts/webViewerOps';
import type { WebEventInput } from '../../database/webTabsRepository';
import { consentRequirement, type ConsentFlags, type ConsentResult, type ConsentAsk } from './webViewerConsent';
import type { WebFrameTarget, WebTabConsentView } from './webViewerManager';
import type { TelemetryRead, TelemetryKind } from './webViewerTelemetry';

export const AGENT_READ_LIMITS = {
  /** Per-frame caps, in characters. */
  maxText: 50_000,
  maxDom: 200_000,
  /** Frames read by one `frame: 'all'` call. */
  maxFrames: 16,
  /** One frame's script budget. A hung page must not hold the tool call. */
  frameTimeoutMs: 5_000,
  /** Bound on waiting for an evicted tab to reload. */
  loadTimeoutMs: 15_000,
  /** A drive script (click / type / eval) — eval may await a promise. */
  driveTimeoutMs: 10_000,
  /** eval results, as JSON characters. */
  maxEvalResult: 50_000,
} as const;

// Read-only extraction scripts. No user gesture (see `frameTargets`), no writes.
const TEXT_SCRIPT = `(() => { const b = document.body; return b ? String(b.innerText) : ''; })()`;
const DOM_SCRIPT = `(() => { const d = document.documentElement; return d ? String(d.outerHTML) : ''; })()`;

export interface WebViewerAgentOpsDeps {
  manager: {
    consentView(tabId: string): WebTabConsentView | null;
    get(tabId: string): Promise<WebTabSnapshot | null>;
    tabIdsForSession(sessionId: string): string[];
    loadForAgent(tabId: string, timeoutMs?: number): Promise<WebTabSnapshot['state'] | null>;
    frameTargets(tabId: string, which: 'top' | 'all'): WebFrameTarget[];
    noteAgentRead(tabId: string): void;
    navigate(tabId: string, url: string): Promise<WebViewerAck>;
    back(tabId: string): Promise<WebViewerAck>;
    forward(tabId: string): Promise<WebViewerAck>;
    reload(tabId: string): Promise<WebViewerAck>;
    telemetry: { read(tabId: string, kind: TelemetryKind, since?: number): TelemetryRead<unknown> | null };
  };
  /** The PERSISTING viewer, so an agent open gets its row and audit like any other. */
  viewer: { open(args: WebViewerOpenArgs): Promise<WebViewerOpenResult> };
  consent: {
    findGrant(
      runId: string,
      tabId: string,
      capability: WebConsentCapability,
      principal: string | null,
      epoch: number,
    ): unknown;
    request(ask: ConsentAsk): Promise<ConsentResult>;
  };
  /** Read LIVE per call: flipping a flag in Settings takes effect immediately. */
  flags: () => ConsentFlags;
  audit: (event: WebEventInput) => void;
  mintTabId?: () => string;
}

type Access = AgentWebTab['access'];

const DISABLED = 'viewer_disabled: agent access to web tabs is off (Settings → Web viewer)';
const DISABLED_DRIVE = 'viewer_disabled: agent control of web tabs is off (Settings → Web viewer)';

export class WebViewerAgentOps implements WebViewerAgentLike {
  constructor(private readonly deps: WebViewerAgentOpsDeps) {}

  async listTabs(caller: AgentCaller): Promise<AgentResult<{ tabs: AgentWebTab[] }>> {
    const flags = this.deps.flags();
    if (!flags.agentObserve) return { ok: false, error: DISABLED };
    const tabs: AgentWebTab[] = [];
    for (const tabId of this.deps.manager.tabIdsForSession(caller.sessionKey)) {
      const view = this.deps.manager.consentView(tabId);
      if (!view) continue;
      tabs.push(await this.describe(caller, view, this.access(caller.runId, view, flags)));
    }
    return { ok: true, tabs };
  }

  async readTab(caller: AgentCaller, args: AgentReadArgs): Promise<AgentResult<AgentReadResult>> {
    const flags = this.deps.flags();
    if (!flags.agentObserve) return { ok: false, error: DISABLED };
    const initial = this.scoped(caller, args.tabId);
    if (!initial) return { ok: false, error: 'tab_not_found' };

    const blocked = blockedState(initial.state);
    if (blocked) return { ok: false, error: blocked };

    const wantsContent = (args.include?.length ?? 0) > 0;
    // (2) Load first — see the header.
    if (wantsContent && initial.state === 'evicted') {
      const after = await this.deps.manager.loadForAgent(args.tabId, AGENT_READ_LIMITS.loadTimeoutMs);
      if (after === null) return { ok: false, error: 'tab_closed' };
      const stillBlocked = blockedState(after);
      if (stillBlocked) return { ok: false, error: stillBlocked };
      if (after === 'evicted') return { ok: false, error: 'tab_evicted: the tab could not be reloaded' };
    }

    // (3) Top-principal consent.
    const view = this.scoped(caller, args.tabId);
    if (!view) return { ok: false, error: 'tab_closed' };
    // Copied as VALUES: the recheck below compares against what was consented
    // to, whatever happens to the view object in between.
    const consented = { principal: view.principal, epoch: view.epoch };
    const requirement = consentRequirement('observe', caller.runId, view, flags);
    if (requirement === 'disabled') return { ok: false, error: DISABLED };
    const gated = requirement === 'grant';
    if (gated) {
      const granted = await this.ensureGrant(caller, view, consented.principal, consented.epoch, args.reason);
      if (!granted.ok) return granted;
    }

    // Frame snapshot, then consent for every other principal in it.
    const frames = wantsContent
      ? this.deps.manager.frameTargets(args.tabId, args.frame ?? 'top').slice(0, AGENT_READ_LIMITS.maxFrames)
      : [];
    const deniedPrincipals = new Map<string, string>();
    if (gated && frames.length > 0) {
      const others = [...new Set(frames.map((f) => f.principal))].filter((p) => p !== consented.principal);
      const results = await Promise.all(
        others.map(async (p) => [p, await this.ensureGrant(caller, view, p, consented.epoch, args.reason)] as const),
      );
      for (const [p, r] of results) if (!r.ok) deniedPrincipals.set(p, r.error);
    }

    // (4) Recheck, immediately before reading.
    const now = this.scoped(caller, args.tabId);
    if (!now) return { ok: false, error: 'tab_closed' };
    if (now.principal !== consented.principal || now.epoch !== consented.epoch) {
      return { ok: false, error: 'origin_changed' };
    }
    if (now.loading && wantsContent) return { ok: false, error: 'navigating' };

    // A grant covers the principals it names. Console and network entries from
    // any OTHER frame origin are withheld on a gated tab — reported as a count,
    // so a thin slice is never mistaken for a quiet page. An opaque (sandboxed)
    // frame's entries carry its URL origin, which no grant names: withheld too.
    const allowed = gated
      ? new Set<string | null>([consented.principal, ...frames.map((f) => f.principal).filter((p) => !deniedPrincipals.has(p))])
      : null;
    const result: AgentReadResult = {
      tab: await this.describe(caller, now, gated ? 'granted' : 'free'),
      console: this.slice(args.tabId, 'console', args.since?.console, allowed),
      network: this.slice(args.tabId, 'network', args.since?.network, allowed),
      navigation: this.slice(args.tabId, 'navigation', args.since?.navigation, null),
    };
    if (wantsContent) {
      const live = new Map(
        this.deps.manager.frameTargets(args.tabId, args.frame ?? 'top').map((f) => [f.frameToken, f]),
      );
      result.frames = await Promise.all(
        frames.map((f) => this.readFrame(f, live.get(f.frameToken), deniedPrincipals.get(f.principal), args.include ?? [])),
      );
    }

    this.deps.manager.noteAgentRead(args.tabId);
    if (gated) {
      this.deps.audit({
        sessionId: now.sessionId,
        tabId: now.tabId,
        runId: caller.runId,
        kind: 'agent_read',
        origin: now.principal,
        detail: wantsContent ? `include=${(args.include ?? []).join(',')} frame=${args.frame ?? 'top'}` : 'telemetry',
      });
    }
    return { ok: true, ...result };
  }

  async openTab(
    caller: AgentCaller,
    args: { url: string; reason?: string; waitForLoad?: boolean },
  ): Promise<AgentResult<{ tab: AgentWebTab }>> {
    const flags = this.deps.flags();
    if (!flags.agentObserve) return { ok: false, error: DISABLED };
    const tabId = (this.deps.mintTabId ?? makeWebTabId)();
    const opened = await this.deps.viewer.open({
      sessionId: caller.sessionKey,
      tabId,
      url: args.url,
      openedBy: 'agent',
      openedByRunId: caller.runId,
    });
    if (!opened.ok) return opened;
    if (args.waitForLoad === true) {
      await this.deps.manager.loadForAgent(tabId, AGENT_READ_LIMITS.loadTimeoutMs);
    }
    const view = this.deps.manager.consentView(tabId);
    if (!view) return { ok: false, error: 'tab_closed' };
    return { ok: true, tab: await this.describe(caller, view, this.access(caller.runId, view, flags)) };
  }


  /**
   * One drive verb. Same order as a read — scope, load, consent, recheck — with
   * `drive` consent (which also needs the agentDrive flag), and the recheck done
   * IMMEDIATELY before dispatch: a grant approved for `localhost` must never run
   * `eval` in a document that has since become `github.com` (§7).
   */
  async driveTab(caller: AgentCaller, args: AgentDriveArgs): Promise<AgentResult<AgentDriveResult>> {
    const flags = this.deps.flags();
    if (!flags.agentObserve || !flags.agentDrive) return { ok: false, error: DISABLED_DRIVE };
    const initial = this.scoped(caller, args.tabId);
    if (!initial) return { ok: false, error: 'tab_not_found' };

    const inPage = args.action === 'click' || args.action === 'type' || args.action === 'eval';
    const invalid = invalidDriveArgs(args);
    if (invalid) return { ok: false, error: invalid };
    // A crashed tab can only be reloaded (into a fresh view); the in-page verbs
    // need a working document.
    if (initial.state === 'crashed' && args.action !== 'reload') return { ok: false, error: 'tab_crashed' };
    if (inPage) {
      const blocked = blockedState(initial.state);
      if (blocked) return { ok: false, error: blocked };
      if (initial.state === 'evicted') {
        const after = await this.deps.manager.loadForAgent(args.tabId, AGENT_READ_LIMITS.loadTimeoutMs);
        if (after === null) return { ok: false, error: 'tab_closed' };
        if (after !== 'live' && after !== 'hidden') return { ok: false, error: blockedState(after) ?? 'tab_evicted' };
      }
    }

    const view = this.scoped(caller, args.tabId);
    if (!view) return { ok: false, error: 'tab_closed' };
    const consented = { principal: view.principal, epoch: view.epoch };
    const requirement = consentRequirement('drive', caller.runId, view, flags);
    if (requirement === 'disabled') return { ok: false, error: DISABLED_DRIVE };
    const gated = requirement === 'grant';
    if (gated) {
      const granted = await this.ensureGrant(caller, view, consented.principal, consented.epoch, args.reason, 'drive');
      if (!granted.ok) return granted;
    }

    // The target frame, and its own grant when it is another principal.
    let target: WebFrameTarget | null = null;
    if (inPage) {
      const frames = this.deps.manager.frameTargets(args.tabId, args.frame ? 'all' : 'top');
      target = (args.frame ? frames.find((f) => f.frameToken === args.frame) : frames[0]) ?? null;
      if (!target) return { ok: false, error: 'frame_not_found' };
      if (gated && target.principal !== consented.principal) {
        const granted = await this.ensureGrant(caller, view, target.principal, consented.epoch, args.reason, 'drive');
        if (!granted.ok) return granted;
      }
    }

    // Recheck, immediately before dispatch.
    const now = this.scoped(caller, args.tabId);
    if (!now) return { ok: false, error: 'tab_closed' };
    if (now.principal !== consented.principal || now.epoch !== consented.epoch) {
      return { ok: false, error: 'origin_changed' };
    }
    let live: WebFrameTarget | undefined;
    if (inPage && target) {
      if (now.loading) return { ok: false, error: 'navigating' };
      const snapshotToken = target.frameToken;
      live = this.deps.manager
        .frameTargets(args.tabId, args.frame ? 'all' : 'top')
        .find((f) => f.frameToken === snapshotToken);
      if (!live) return { ok: false, error: 'frame_not_found' };
      if (live.principal !== target.principal) return { ok: false, error: 'frame_principal_changed' };
    }

    const out = await this.dispatch(args, live);
    this.deps.manager.noteAgentRead(args.tabId);
    this.deps.audit({
      sessionId: now.sessionId,
      tabId: now.tabId,
      runId: caller.runId,
      kind: 'agent_drive',
      origin: live?.principal ?? now.principal,
      // The verb and, for navigate, the TARGET ORIGIN — never a URL, selector
      // text or typed value (a typed value can be a password).
      detail: args.action === 'navigate' ? `navigate → ${originOrNull(args.url) ?? '(invalid)'}` : args.action,
    });
    if (!out.ok) return out;

    const after = this.deps.manager.consentView(args.tabId);
    if (!after) return { ok: false, error: 'tab_closed' };
    const access: Access = gated
      ? this.deps.consent.findGrant(caller.runId, after.tabId, 'observe', after.principal, after.epoch)
        ? 'granted'
        : 'consent_required'
      : 'free';
    return {
      ok: true,
      tab: await this.describe(caller, after, access),
      ...(out.value !== undefined ? { value: out.value } : {}),
      ...(out.truncated ? { truncated: true } : {}),
    };
  }

  // -------------------------------------------------------------------------

  private async dispatch(
    args: AgentDriveArgs,
    frame: WebFrameTarget | undefined,
  ): Promise<{ ok: true; value?: unknown; truncated?: boolean } | { ok: false; error: string }> {
    const m = this.deps.manager;
    switch (args.action) {
      case 'navigate':
        return m.navigate(args.tabId, args.url ?? '');
      case 'back':
        return m.back(args.tabId);
      case 'forward':
        return m.forward(args.tabId);
      case 'reload':
        return m.reload(args.tabId);
      case 'click':
      case 'type':
      case 'eval': {
        if (!frame) return { ok: false, error: 'frame_not_found' };
        const code =
          args.action === 'click'
            ? clickScript(args.selector ?? '')
            : args.action === 'type'
              ? typeScript(args.selector ?? '', args.text ?? '')
              : evalScript(args.expression ?? '');
        let raw: unknown;
        try {
          raw = await withTimeout(frame.execute(code), AGENT_READ_LIMITS.driveTimeoutMs);
        } catch (err) {
          if (err instanceof Error && err.message === 'frame_timeout') return { ok: false, error: 'drive_timeout' };
          return { ok: false, error: `script_error: ${clipError(err)}` };
        }
        if (args.action === 'eval') return clipValue(raw);
        const res = raw as { ok?: unknown; error?: unknown } | null;
        return res && res.ok === true ? { ok: true } : { ok: false, error: typeof res?.error === 'string' ? res.error : 'drive_failed' };
      }
    }
  }

  /** The tab, only if it belongs to the caller's session. */
  private scoped(caller: AgentCaller, tabId: string): WebTabConsentView | null {
    const view = this.deps.manager.consentView(tabId);
    return view && view.sessionId === caller.sessionKey ? view : null;
  }

  private access(runId: string, view: WebTabConsentView, flags: ConsentFlags): Access {
    const req = consentRequirement('observe', runId, view, flags);
    if (req === 'free') return 'free';
    const grant = this.deps.consent.findGrant(runId, view.tabId, 'observe', view.principal, view.epoch);
    return grant ? 'granted' : 'consent_required';
  }

  private async describe(caller: AgentCaller, view: WebTabConsentView, access: Access): Promise<AgentWebTab> {
    const readable = access !== 'consent_required';
    const snap = readable ? await this.deps.manager.get(view.tabId) : null;
    return {
      tabId: view.tabId,
      state: view.state,
      openedBy: view.openedBy,
      ownedByCaller: view.openedBy === 'agent' && view.openedByRunId === caller.runId,
      access,
      origin: view.principal,
      url: snap?.currentUrl ?? null,
      title: snap?.title ?? null,
    };
  }

  /** A live grant, or a prompt on the tab that blocks until the human answers. */
  private async ensureGrant(
    caller: AgentCaller,
    view: WebTabConsentView,
    principal: string | null,
    epoch: number,
    reason: string | undefined,
    capability: WebConsentCapability = 'observe',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.deps.consent.findGrant(caller.runId, view.tabId, capability, principal, epoch)) return { ok: true };
    const answer = await this.deps.consent.request({
      sessionId: view.sessionId,
      tabId: view.tabId,
      runId: caller.runId,
      capability,
      principal,
      epoch,
      reason: reason ?? null,
    });
    return answer.ok ? { ok: true } : { ok: false, error: answer.error };
  }

  private slice(
    tabId: string,
    kind: TelemetryKind,
    since: number | undefined,
    allowed: Set<string | null> | null,
  ): AgentTelemetrySlice<unknown> {
    const read = this.deps.manager.telemetry.read(tabId, kind, since ?? 0);
    if (!read) return { entries: [], cursor: since ?? 0, gap: 0 };
    if (!allowed) return read;
    const entries = read.entries.filter((e) => {
      const origin = (e as { frameOrigin?: string | null }).frameOrigin ?? null;
      return origin === null || allowed.has(origin);
    });
    const withheld = read.entries.length - entries.length;
    return withheld > 0 ? { ...read, entries, withheld } : { ...read, entries };
  }

  private async readFrame(
    snapshot: WebFrameTarget,
    live: WebFrameTarget | undefined,
    denied: string | undefined,
    include: Array<'text' | 'dom'>,
  ): Promise<AgentFrameRead> {
    const base: AgentFrameRead = {
      frameToken: snapshot.frameToken,
      isTop: snapshot.isTop,
      url: snapshot.url,
      principal: snapshot.principal,
      truncated: false,
    };
    if (denied) return { ...base, error: denied };
    if (!live) return { ...base, error: 'frame_not_found' };
    if (live.principal !== snapshot.principal) return { ...base, error: 'frame_principal_changed' };
    const out = { ...base };
    try {
      if (include.includes('text')) {
        const [text, cut] = clip(await withTimeout(live.execute(TEXT_SCRIPT)), AGENT_READ_LIMITS.maxText);
        out.text = text;
        out.truncated ||= cut;
      }
      if (include.includes('dom')) {
        const [dom, cut] = clip(await withTimeout(live.execute(DOM_SCRIPT)), AGENT_READ_LIMITS.maxDom);
        out.dom = dom;
        out.truncated ||= cut;
      }
    } catch (err) {
      out.error = err instanceof Error && err.message === 'frame_timeout' ? 'frame_timeout' : 'frame_read_failed';
    }
    return out;
  }
}

function blockedState(state: WebTabSnapshot['state']): string | null {
  if (state === 'crashed') return 'tab_crashed';
  if (state === 'auth_required') return 'auth_required';
  if (state === 'certificate_error') return 'certificate_error';
  return null;
}

function clip(value: unknown, max: number): [string, boolean] {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? [text.slice(0, max), true] : [text, false];
}

function withTimeout<T>(p: Promise<T>, ms: number = AGENT_READ_LIMITS.frameTimeoutMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('frame_timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Drive scripts. Values are embedded with JSON.stringify — a selector or text
// can never break out of its string literal.
//
// They run as page script (`executeJavaScript`), NOT as input events: the
// manager latches `human_touched` on `before-input-event` and on view focus, and
// an agent's own clicks must not flip its own tab into the consent-gated state.
// ---------------------------------------------------------------------------

export function clickScript(selector: string): string {
  return `((sel) => {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, error: 'element_not_found' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, button: 0, view: window,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new MouseEvent('mousedown', o));
  if (typeof el.focus === 'function') el.focus();
  el.dispatchEvent(new PointerEvent('pointerup', o));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  if (typeof el.click === 'function') el.click(); else el.dispatchEvent(new MouseEvent('click', o));
  return { ok: true };
})(${JSON.stringify(selector)})`;
}

/** Sets the value through the prototype setter so framework-controlled inputs (React) see it. */
export function typeScript(selector: string, text: string): string {
  return `((sel, text) => {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, error: 'element_not_found' };
  if (typeof el.focus === 'function') el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel2 = window.getSelection();
    if (sel2) { sel2.removeAllRanges(); sel2.addRange(range); }
    document.execCommand('insertText', false, text);
    return { ok: true };
  }
  return { ok: false, error: 'element_not_editable' };
})(${JSON.stringify(selector)}, ${JSON.stringify(text)})`;
}

/**
 * The expression is inlined, not passed to `eval()`: a page CSP without
 * 'unsafe-eval' would block an eval call, while `executeJavaScript` itself is
 * not subject to the page's CSP.
 */
export function evalScript(expression: string): string {
  return `(async () => {
  const __v = await (
${expression}
  );
  if (__v === undefined) return null;
  try { return JSON.parse(JSON.stringify(__v)); } catch { return String(__v); }
})()`;
}

function clipValue(raw: unknown): { ok: true; value: unknown; truncated?: boolean } {
  let json: string;
  try {
    json = JSON.stringify(raw ?? null);
  } catch {
    json = JSON.stringify(String(raw));
  }
  if (json.length <= AGENT_READ_LIMITS.maxEvalResult) return { ok: true, value: raw ?? null };
  return { ok: true, value: json.slice(0, AGENT_READ_LIMITS.maxEvalResult), truncated: true };
}

function clipError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function invalidDriveArgs(args: AgentDriveArgs): string | null {
  switch (args.action) {
    case 'navigate':
      return args.url ? null : 'invalid_arguments: navigate needs url';
    case 'click':
      return args.selector ? null : 'invalid_arguments: click needs selector';
    case 'type':
      return args.selector && typeof args.text === 'string' ? null : 'invalid_arguments: type needs selector and text';
    case 'eval':
      return args.expression ? null : 'invalid_arguments: eval needs expression';
    default:
      return null;
  }
}

function originOrNull(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}
