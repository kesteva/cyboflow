/**
 * webViewerAgentOps — the consent rules as an agent meets them. Real
 * WebViewerConsent and WebViewerTelemetry; the manager is a fake that holds
 * consent views and frames directly (no electron).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as vm from 'node:vm';
import { WebViewerAgentOps, clickScript, evalScript, typeScript, type WebViewerAgentOpsDeps } from '../webViewerAgentOps';
import { WebViewerConsent } from '../webViewerConsent';
import { WebViewerTelemetry } from '../webViewerTelemetry';
import type { WebFrameTarget, WebTabConsentView } from '../webViewerManager';
import type { WebEventInput } from '../../../database/webTabsRepository';
import type { WebTabSnapshot } from '../../../../../shared/types/webViewer';
import type { WebViewerOpenArgs } from '../../../orchestrator/trpc/contracts/webViewerOps';

const ME = { runId: 'run-me', sessionKey: 'sess-1' };

function view(over: Partial<WebTabConsentView> & { tabId: string }): WebTabConsentView {
  return {
    sessionId: 'sess-1',
    openedBy: 'user',
    openedByRunId: null,
    humanTouched: false,
    partitionHumanTouched: false,
    principal: 'https://app.example',
    epoch: 1,
    state: 'hidden',
    loading: false,
    ...over,
  };
}

function frame(token: string, principal: string, isTop: boolean, content: Record<string, string> = {}): WebFrameTarget {
  return {
    frameToken: token,
    isTop,
    url: `${principal}/`,
    principal,
    execute: async (code: string) => (code.includes('innerText') ? (content.text ?? '') : (content.dom ?? '')),
  };
}

class FakeManager {
  views = new Map<string, WebTabConsentView>();
  frames = new Map<string, WebFrameTarget[]>();
  reads: string[] = [];
  loads: string[] = [];
  telemetry = new WebViewerTelemetry(() => 1000);
  /** Runs inside loadForAgent — lets a test model the reload's new epoch. */
  onLoad: ((tabId: string) => void) | null = null;

  consentView(tabId: string): WebTabConsentView | null {
    return this.views.get(tabId) ?? null;
  }
  async get(tabId: string): Promise<WebTabSnapshot | null> {
    const v = this.views.get(tabId);
    if (!v) return null;
    return {
      tabId,
      sessionId: v.sessionId,
      state: v.state,
      currentUrl: `${v.principal}/secret?code=abc`,
      title: 'Inbox (3) — private subject',
      openedBy: v.openedBy,
      openedByRunId: v.openedByRunId,
      humanTouched: v.humanTouched,
      canGoBack: false,
      canGoForward: false,
      loading: v.loading,
      blockedReason: null,
    };
  }
  tabIdsForSession(sessionId: string): string[] {
    return [...this.views.values()].filter((v) => v.sessionId === sessionId).map((v) => v.tabId);
  }
  async loadForAgent(tabId: string): Promise<WebTabSnapshot['state'] | null> {
    this.loads.push(tabId);
    const v = this.views.get(tabId);
    if (!v) return null;
    this.onLoad?.(tabId);
    v.state = 'hidden';
    return v.state;
  }
  frameTargets(tabId: string, which: 'top' | 'all'): WebFrameTarget[] {
    const all = this.frames.get(tabId) ?? [];
    return which === 'top' ? all.filter((f) => f.isTop) : all;
  }
  noteAgentRead(tabId: string): void {
    this.reads.push(tabId);
  }
  navs: string[] = [];
  async navigate(tabId: string, url: string): Promise<{ ok: true }> {
    this.navs.push(`navigate ${tabId} ${url}`);
    return { ok: true };
  }
  async back(tabId: string): Promise<{ ok: true }> {
    this.navs.push(`back ${tabId}`);
    return { ok: true };
  }
  async forward(tabId: string): Promise<{ ok: true }> {
    this.navs.push(`forward ${tabId}`);
    return { ok: true };
  }
  async reload(tabId: string): Promise<{ ok: true }> {
    this.navs.push(`reload ${tabId}`);
    return { ok: true };
  }
}

let manager: FakeManager;
let consent: WebViewerConsent;
let audit: WebEventInput[];
let opened: WebViewerOpenArgs[];
let flags: { agentObserve: boolean; agentDrive: boolean };
let ops: WebViewerAgentOps;

beforeEach(() => {
  manager = new FakeManager();
  consent = new WebViewerConsent({ audit: () => undefined, timeoutMs: 60_000 });
  audit = [];
  opened = [];
  flags = { agentObserve: true, agentDrive: false };
  const deps: WebViewerAgentOpsDeps = {
    manager,
    viewer: {
      open: async (args) => {
        opened.push(args);
        manager.views.set(
          args.tabId,
          view({ tabId: args.tabId, openedBy: 'agent', openedByRunId: args.openedByRunId ?? null, principal: 'http://localhost:5173' }),
        );
        return { ok: true, snapshot: (await manager.get(args.tabId)) as WebTabSnapshot };
      },
    },
    consent,
    flags: () => flags,
    audit: (e) => audit.push(e),
    mintTabId: () => 'web:new',
  };
  ops = new WebViewerAgentOps(deps);
});

/** Answer the next prompt that appears, with `decision`. */
function answerNext(decision: 'allow' | 'deny'): Promise<void> {
  return new Promise((resolve) => {
    consent.once('web-viewer:consent', (ev: { kind: string; request?: { requestId: string } }) => {
      if (ev.kind === 'requested' && ev.request) {
        consent.respond(ev.request.requestId, decision);
        resolve();
      }
    });
  });
}

describe('the kill switch', () => {
  it('refuses every tool while agent observation is off', async () => {
    flags.agentObserve = false;
    manager.views.set('web:a', view({ tabId: 'web:a' }));
    for (const r of [await ops.listTabs(ME), await ops.readTab(ME, { tabId: 'web:a' }), await ops.openTab(ME, { url: 'http://x.test' })]) {
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/^viewer_disabled/);
    }
    expect(opened).toEqual([]);
  });
});

describe('listTabs', () => {
  it('shows a tab it may not read by origin only — never its URL or title', async () => {
    manager.views.set('web:human', view({ tabId: 'web:human' }));
    const r = await ops.listTabs(ME);
    expect(r).toEqual({
      ok: true,
      tabs: [
        {
          tabId: 'web:human',
          state: 'hidden',
          openedBy: 'user',
          ownedByCaller: false,
          access: 'consent_required',
          origin: 'https://app.example',
          url: null,
          title: null,
        },
      ],
    });
  });

  it('shows URL and title for the caller’s own untouched tab', async () => {
    manager.views.set('web:mine', view({ tabId: 'web:mine', openedBy: 'agent', openedByRunId: 'run-me' }));
    const r = await ops.listTabs(ME);
    expect(r.ok && r.tabs[0]).toMatchObject({ access: 'free', ownedByCaller: true, url: 'https://app.example/secret?code=abc' });
  });

  it('never lists another session’s tabs', async () => {
    manager.views.set('web:other', view({ tabId: 'web:other', sessionId: 'sess-2' }));
    expect(await ops.listTabs(ME)).toEqual({ ok: true, tabs: [] });
  });
});

describe('readTab — scope and state', () => {
  it('a tab in another session is tab_not_found, not a consent prompt', async () => {
    manager.views.set('web:other', view({ tabId: 'web:other', sessionId: 'sess-2' }));
    expect(await ops.readTab(ME, { tabId: 'web:other' })).toEqual({ ok: false, error: 'tab_not_found' });
    expect(consent.listPending('sess-2')).toEqual([]);
  });

  it('a crashed tab fails tab_crashed', async () => {
    manager.views.set('web:c', view({ tabId: 'web:c', state: 'crashed', openedBy: 'agent', openedByRunId: 'run-me' }));
    expect(await ops.readTab(ME, { tabId: 'web:c' })).toEqual({ ok: false, error: 'tab_crashed' });
  });
});

describe('readTab — free', () => {
  it('reads its own tab without a prompt, text included, and pins it', async () => {
    manager.views.set('web:mine', view({ tabId: 'web:mine', openedBy: 'agent', openedByRunId: 'run-me' }));
    manager.frames.set('web:mine', [frame('1:1', 'https://app.example', true, { text: 'hello' })]);
    manager.telemetry.appendConsole('web:mine', { level: 'error', message: 'boom', frame: { url: 'https://app.example/' } });
    const r = await ops.readTab(ME, { tabId: 'web:mine', include: ['text'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tab.access).toBe('free');
    expect(r.console.entries).toHaveLength(1);
    expect(r.frames).toEqual([
      { frameToken: '1:1', isTop: true, url: 'https://app.example/', principal: 'https://app.example', text: 'hello', truncated: false },
    ]);
    expect(manager.reads).toEqual(['web:mine']);
    expect(audit).toEqual([]); // free reads are not privileged reads
  });

  it('a human touch on the tab — or anywhere in its cookie jar — makes it gated', async () => {
    manager.views.set('web:t', view({ tabId: 'web:t', openedBy: 'agent', openedByRunId: 'run-me', partitionHumanTouched: true }));
    const answered = answerNext('deny');
    expect(await ops.readTab(ME, { tabId: 'web:t' })).toEqual({ ok: false, error: 'consent_denied' });
    await answered;
  });

  it('another run’s agent tab is not free', async () => {
    manager.views.set('web:x', view({ tabId: 'web:x', openedBy: 'agent', openedByRunId: 'run-other' }));
    const answered = answerNext('deny');
    expect(await ops.readTab(ME, { tabId: 'web:x' })).toEqual({ ok: false, error: 'consent_denied' });
    await answered;
  });
});

describe('readTab — gated', () => {
  it('prompts, and on Allow reads and audits the privileged read', async () => {
    manager.views.set('web:h', view({ tabId: 'web:h' }));
    const answered = answerNext('allow');
    const r = await ops.readTab(ME, { tabId: 'web:h', reason: 'check the error' });
    await answered;
    expect(r.ok && r.tab).toMatchObject({ access: 'granted', url: 'https://app.example/secret?code=abc' });
    expect(audit).toEqual([
      expect.objectContaining({ kind: 'agent_read', tabId: 'web:h', runId: 'run-me', origin: 'https://app.example', detail: 'telemetry' }),
    ]);
    // The grant is reused: no second prompt.
    expect((await ops.readTab(ME, { tabId: 'web:h' })).ok).toBe(true);
    expect(consent.listPending('sess-1')).toEqual([]);
  });

  it('fails origin_changed when the tab navigated while the prompt was up', async () => {
    const v = view({ tabId: 'web:h' });
    manager.views.set('web:h', v);
    consent.once('web-viewer:consent', (ev: { kind: string; request?: { requestId: string } }) => {
      // An in-page, same-origin navigation keeps the prompt alive but moves the
      // epoch; the answer lands, and the recheck must still see the move.
      v.epoch = 2;
      if (ev.request) consent.respond(ev.request.requestId, 'allow');
    });
    expect(await ops.readTab(ME, { tabId: 'web:h' })).toEqual({ ok: false, error: 'origin_changed' });
  });

  it('frame=all asks once per extra principal; a denied iframe returns no content', async () => {
    manager.views.set('web:h', view({ tabId: 'web:h' }));
    manager.frames.set('web:h', [
      frame('1:1', 'https://app.example', true, { text: 'wrapper' }),
      frame('2:7', 'https://artifact.example', false, { text: 'artifact' }),
    ]);
    manager.telemetry.appendConsole('web:h', { level: 'info', message: 'top', frame: { url: 'https://app.example/' } });
    manager.telemetry.appendConsole('web:h', { level: 'error', message: 'iframe', frame: { url: 'https://artifact.example/' } });

    const decisions: Array<'allow' | 'deny'> = ['allow', 'deny'];
    const seen: string[] = [];
    consent.on('web-viewer:consent', (ev: { kind: string; request?: { requestId: string; origin: string | null } }) => {
      if (ev.kind !== 'requested' || !ev.request) return;
      seen.push(ev.request.origin ?? '');
      const d = decisions.shift() ?? 'deny';
      queueMicrotask(() => consent.respond(ev.request!.requestId, d));
    });

    const r = await ops.readTab(ME, { tabId: 'web:h', include: ['text'], frame: 'all' });
    expect(seen).toEqual(['https://app.example', 'https://artifact.example']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frames?.[0]).toMatchObject({ text: 'wrapper' });
    expect(r.frames?.[1]).toEqual(expect.objectContaining({ principal: 'https://artifact.example', error: 'consent_denied' }));
    expect(r.frames?.[1]).not.toHaveProperty('text');
    // The denied iframe's console line is withheld, and counted.
    expect(r.console.entries.map((e) => (e as { message: string }).message)).toEqual(['top']);
    expect(r.console.withheld).toBe(1);
  });

  it('a frame whose principal changed between snapshot and read is refused', async () => {
    manager.views.set('web:mine', view({ tabId: 'web:mine', openedBy: 'agent', openedByRunId: 'run-me' }));
    const f = frame('3:3', 'https://a.example', false, { text: 'x' });
    manager.frames.set('web:mine', [frame('1:1', 'https://app.example', true), f]);
    let calls = 0;
    const real = manager.frameTargets.bind(manager);
    manager.frameTargets = (tabId, which) => {
      calls += 1;
      const out = real(tabId, which);
      // Second enumeration (the recheck) sees the iframe on a new origin.
      return calls === 1 ? out : out.map((t) => (t.frameToken === '3:3' ? { ...t, principal: 'https://b.example' } : t));
    };
    const r = await ops.readTab(ME, { tabId: 'web:mine', include: ['text'], frame: 'all' });
    expect(r.ok && r.frames?.[1]).toMatchObject({ frameToken: '3:3', error: 'frame_principal_changed' });
  });
});

describe('readTab — evicted', () => {
  it('reloads before resolving consent, so the grant binds to the reloaded document', async () => {
    const v = view({ tabId: 'web:e', state: 'evicted' });
    manager.views.set('web:e', v);
    manager.frames.set('web:e', [frame('1:1', 'https://app.example', true, { text: 'back' })]);
    manager.onLoad = () => {
      v.epoch = 5; // a reload commits a new navigation
    };
    const answered = answerNext('allow');
    const r = await ops.readTab(ME, { tabId: 'web:e', include: ['text'] });
    await answered;
    expect(manager.loads).toEqual(['web:e']);
    expect(r.ok && r.frames?.[0]).toMatchObject({ text: 'back' });
  });

  it('a telemetry-only read does not reload an evicted tab', async () => {
    manager.views.set('web:e', view({ tabId: 'web:e', state: 'evicted', openedBy: 'agent', openedByRunId: 'run-me' }));
    expect((await ops.readTab(ME, { tabId: 'web:e' })).ok).toBe(true);
    expect(manager.loads).toEqual([]);
  });
});

describe('openTab', () => {
  it('opens in the caller’s session as an agent tab owned by the run', async () => {
    const r = await ops.openTab(ME, { url: 'http://localhost:5173/' });
    expect(opened).toEqual([
      { sessionId: 'sess-1', tabId: 'web:new', url: 'http://localhost:5173/', openedBy: 'agent', openedByRunId: 'run-me' },
    ]);
    expect(r.ok && r.tab).toMatchObject({ tabId: 'web:new', access: 'free', ownedByCaller: true });
  });

  it('waits for the first load only when asked', async () => {
    await ops.openTab(ME, { url: 'http://localhost:5173/' });
    expect(manager.loads).toEqual([]);
    await ops.openTab(ME, { url: 'http://localhost:5173/', waitForLoad: true });
    expect(manager.loads).toEqual(['web:new']);
  });
});

describe('openForUser ($BROWSER)', () => {
  it('opens a HUMAN tab with no run owner, even with every agent flag off', async () => {
    flags.agentObserve = false;
    const r = await ops.openForUser(ME, { url: 'https://claude.ai/code/artifact/x' });
    expect(r).toEqual({ ok: true, tabId: 'web:new' });
    // No openedByRunId: a later agent read of it is consent-gated like any human tab.
    expect(opened).toEqual([
      { sessionId: 'sess-1', tabId: 'web:new', url: 'https://claude.ai/code/artifact/x', openedBy: 'user' },
    ]);
  });
});

describe('driveTab', () => {
  /** A frame that records the scripts it is asked to run and answers `reply`. */
  function scriptedFrame(token: string, principal: string, isTop: boolean, reply: unknown, seen: string[]): WebFrameTarget {
    return { frameToken: token, isTop, url: `${principal}/`, principal, execute: async (code) => (seen.push(code), reply) };
  }

  beforeEach(() => {
    flags.agentDrive = true;
  });

  it('needs the drive flag on top of observe', async () => {
    flags.agentDrive = false;
    manager.views.set('web:mine', view({ tabId: 'web:mine', openedBy: 'agent', openedByRunId: 'run-me' }));
    const r = await ops.driveTab(ME, { tabId: 'web:mine', action: 'reload' });
    expect(!r.ok && r.error).toMatch(/^viewer_disabled/);
    expect(manager.navs).toEqual([]);
  });

  it('drives its own untouched tab without a prompt and audits the verb, never the selector', async () => {
    const seen: string[] = [];
    manager.views.set('web:mine', view({ tabId: 'web:mine', openedBy: 'agent', openedByRunId: 'run-me' }));
    manager.frames.set('web:mine', [scriptedFrame('1:1', 'https://app.example', true, { ok: true }, seen)]);
    const r = await ops.driveTab(ME, { tabId: 'web:mine', action: 'click', selector: '#pay-now' });
    expect(r.ok && r.tab.access).toBe('free');
    expect(seen).toHaveLength(1);
    expect(audit).toEqual([expect.objectContaining({ kind: 'agent_drive', detail: 'click', origin: 'https://app.example' })]);
    expect(JSON.stringify(audit)).not.toContain('pay-now');
  });

  it('an observe grant does not cover drive: a second, drive prompt appears', async () => {
    manager.views.set('web:h', view({ tabId: 'web:h' }));
    let answered = answerNext('allow');
    expect((await ops.readTab(ME, { tabId: 'web:h' })).ok).toBe(true);
    await answered;
    const caps: string[] = [];
    consent.on('web-viewer:consent', (ev: { kind: string; request?: { capability: string } }) => {
      if (ev.kind === 'requested' && ev.request) caps.push(ev.request.capability);
    });
    answered = answerNext('deny');
    expect(await ops.driveTab(ME, { tabId: 'web:h', action: 'reload' })).toEqual({ ok: false, error: 'consent_denied' });
    await answered;
    expect(caps).toEqual(['drive']);
    expect(manager.navs).toEqual([]);
  });

  it('refuses to dispatch into a document that changed while the prompt was up', async () => {
    const seen: string[] = [];
    const v = view({ tabId: 'web:h' });
    manager.views.set('web:h', v);
    manager.frames.set('web:h', [scriptedFrame('1:1', 'https://app.example', true, 42, seen)]);
    consent.once('web-viewer:consent', (ev: { request?: { requestId: string } }) => {
      v.epoch = 9;
      if (ev.request) consent.respond(ev.request.requestId, 'allow');
    });
    expect(await ops.driveTab(ME, { tabId: 'web:h', action: 'eval', expression: 'document.cookie' })).toEqual({
      ok: false,
      error: 'origin_changed',
    });
    expect(seen).toEqual([]);
  });

  it('an iframe on another principal needs its own drive grant', async () => {
    const seen: string[] = [];
    manager.views.set('web:h', view({ tabId: 'web:h' }));
    manager.frames.set('web:h', [
      scriptedFrame('1:1', 'https://app.example', true, 1, seen),
      scriptedFrame('2:7', 'https://artifact.example', false, 2, seen),
    ]);
    const origins: string[] = [];
    consent.on('web-viewer:consent', (ev: { kind: string; request?: { requestId: string; origin: string | null } }) => {
      if (ev.kind !== 'requested' || !ev.request) return;
      origins.push(ev.request.origin ?? '');
      const id = ev.request.requestId;
      queueMicrotask(() => consent.respond(id, 'allow'));
    });
    const r = await ops.driveTab(ME, { tabId: 'web:h', action: 'eval', expression: '1 + 1', frame: '2:7' });
    expect(origins).toEqual(['https://app.example', 'https://artifact.example']);
    expect(r.ok && r.value).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it('fails navigating while the page is mid-load, and frame_not_found for an unknown token', async () => {
    manager.views.set('web:mine', view({ tabId: 'web:mine', openedBy: 'agent', openedByRunId: 'run-me', loading: true }));
    manager.frames.set('web:mine', [frame('1:1', 'https://app.example', true)]);
    expect(await ops.driveTab(ME, { tabId: 'web:mine', action: 'eval', expression: '1' })).toEqual({ ok: false, error: 'navigating' });
    expect(await ops.driveTab(ME, { tabId: 'web:mine', action: 'eval', expression: '1', frame: '9:9' })).toEqual({
      ok: false,
      error: 'frame_not_found',
    });
  });

  it('a crashed tab only accepts reload', async () => {
    manager.views.set('web:c', view({ tabId: 'web:c', state: 'crashed', openedBy: 'agent', openedByRunId: 'run-me' }));
    expect(await ops.driveTab(ME, { tabId: 'web:c', action: 'click', selector: 'a' })).toEqual({ ok: false, error: 'tab_crashed' });
    expect((await ops.driveTab(ME, { tabId: 'web:c', action: 'reload' })).ok).toBe(true);
    expect(manager.navs).toEqual(['reload web:c']);
  });

  it('navigate audits the target origin only', async () => {
    manager.views.set('web:mine', view({ tabId: 'web:mine', openedBy: 'agent', openedByRunId: 'run-me' }));
    await ops.driveTab(ME, { tabId: 'web:mine', action: 'navigate', url: 'https://x.example/reset?token=s3cret' });
    expect(manager.navs).toEqual(['navigate web:mine https://x.example/reset?token=s3cret']);
    expect(audit[0]?.detail).toBe('navigate → https://x.example');
  });

  it('rejects a verb missing its argument before anything runs', async () => {
    manager.views.set('web:mine', view({ tabId: 'web:mine', openedBy: 'agent', openedByRunId: 'run-me' }));
    expect(await ops.driveTab(ME, { tabId: 'web:mine', action: 'type', selector: '#q' })).toEqual({
      ok: false,
      error: 'invalid_arguments: type needs selector and text',
    });
    expect(audit).toEqual([]);
  });

  it('caps a huge eval result and says so', async () => {
    const seen: string[] = [];
    manager.views.set('web:mine', view({ tabId: 'web:mine', openedBy: 'agent', openedByRunId: 'run-me' }));
    manager.frames.set('web:mine', [scriptedFrame('1:1', 'https://app.example', true, 'x'.repeat(60_000), seen)]);
    const r = await ops.driveTab(ME, { tabId: 'web:mine', action: 'eval', expression: 'big' });
    expect(r.ok && r.truncated).toBe(true);
    expect(r.ok && typeof r.value === 'string' && r.value.length).toBe(50_000);
  });
});

describe('drive scripts', () => {
  it('embed selector and text as JSON literals — a quote cannot break out', () => {
    const hostile = `"]'); fetch('https://evil.example'); ('`;
    expect(clickScript(hostile)).toContain(JSON.stringify(hostile));
    expect(typeScript('#q', hostile)).toContain(JSON.stringify(hostile));
  });

  it('eval wrapper returns JSON-safe values and survives a trailing line comment', async () => {
    const run = (expr: string): Promise<unknown> => vm.runInNewContext(evalScript(expr)) as Promise<unknown>;
    expect(await run('1 + 1')).toBe(2);
    expect(await run('undefined')).toBeNull();
    expect(await run('Promise.resolve({ a: [1, 2] }) // trailing')).toEqual({ a: [1, 2] });
    expect(await run('(() => { const f = () => 1; return f; })()')).toMatch(/=>/);
  });
});
