/**
 * Unit tests for CustomWidgetServerManager — the SINGLE process-global
 * token-gated loopback server that serves tier-3 widget documents
 * (docs/proposals/CUSTOM-VIEWS.md §5.4, §9 row S3). Modeled closely on
 * designPrototypeServer.test.ts: drives the REAL node server over loopback
 * fetch, with the widget loader, theme, origin registry, and watchdog control
 * injected as fakes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CustomWidgetServerManager, CUSTOM_WIDGET_SERVER_RUN_ID } from '../customWidgetServer';
import { ARTIFACT_INTERACTIVE_CSP } from '../../../../shared/types/artifacts';
import type { CustomWidget, WidgetSpec } from '../../../../shared/types/customViews';

const THEME = { ink: '#1a1815', paper: '#f5f1e8' };

function htmlSpec(html: string): WidgetSpec {
  return {
    version: 1,
    sources: { s: { type: 'sql', sql: 'SELECT 1 AS x' } },
    render: { type: 'html', html },
  };
}

function statSpec(): WidgetSpec {
  return {
    version: 1,
    sources: { s: { type: 'sql', sql: 'SELECT 1 AS x' } },
    render: { type: 'shape', shape: 'stat', source: 's', value: 'x' },
  };
}

function makeWidget(overrides: Partial<CustomWidget> = {}): CustomWidget {
  return {
    id: overrides.id ?? 'w1',
    name: overrides.name ?? 'Widget',
    description: null,
    publishedSpec: overrides.publishedSpec ?? null,
    draftSpec: overrides.draftSpec ?? null,
    authoringSessionId: overrides.authoringSessionId ?? null,
    revision: overrides.revision ?? 1,
    threadId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makeManager(loadWidget: (widgetId: string) => CustomWidget | null) {
  const registerOrigin = vi.fn();
  const unregisterOrigin = vi.fn();
  const watchdog = { start: vi.fn(), stop: vi.fn() };
  const manager = new CustomWidgetServerManager({
    loadWidget,
    theme: THEME,
    watchdog,
    registerOrigin,
    unregisterOrigin,
  });
  return { manager, registerOrigin, unregisterOrigin, watchdog };
}

let managers: CustomWidgetServerManager[] = [];
function track(m: CustomWidgetServerManager): CustomWidgetServerManager {
  managers.push(m);
  return m;
}
afterEach(async () => {
  for (const m of managers) await m.stop();
  managers = [];
});

describe('CustomWidgetServerManager serving', () => {
  it('serves the published route under the interactive CSP as a RESPONSE HEADER', async () => {
    const widget = makeWidget({ publishedSpec: htmlSpec('<p>hello</p>') });
    const { manager } = makeManager((id) => (id === 'w1' ? widget : null));
    track(manager);
    const { baseUrl } = await manager.ensure();

    const res = await fetch(`${baseUrl}/widget/w1/1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(ARTIFACT_INTERACTIVE_CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('hello');
    expect(body).toContain('window.cyboflow');
    expect(body).toContain('--ink:#1a1815;');
  });

  it('serves the draft route from draftSpec (the authoring slot)', async () => {
    const widget = makeWidget({ draftSpec: htmlSpec('<p>draft body</p>') });
    const { manager } = makeManager(() => widget);
    track(manager);
    const { baseUrl } = await manager.ensure();

    const res = await fetch(`${baseUrl}/widget-draft/w1/1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('draft body');
  });

  it('404s a wrong-token path', async () => {
    const widget = makeWidget({ publishedSpec: htmlSpec('<p>x</p>') });
    const { manager } = makeManager(() => widget);
    track(manager);
    const { origin } = await manager.ensure();

    const res = await fetch(`${origin}/deadbeef/widget/w1/1`);
    expect(res.status).toBe(404);
  });

  it('404s a stray path', async () => {
    const { manager } = makeManager(() => null);
    track(manager);
    const { origin } = await manager.ensure();
    expect((await fetch(`${origin}/`)).status).toBe(404);
  });

  it('404s an unknown widget id', async () => {
    const { manager } = makeManager(() => null);
    track(manager);
    const { baseUrl } = await manager.ensure();
    expect((await fetch(`${baseUrl}/widget/nope/1`)).status).toBe(404);
  });

  it('404s a widget whose spec is not render.type "html"', async () => {
    const widget = makeWidget({ publishedSpec: statSpec() });
    const { manager } = makeManager(() => widget);
    track(manager);
    const { baseUrl } = await manager.ensure();
    expect((await fetch(`${baseUrl}/widget/w1/1`)).status).toBe(404);
  });

  it('404s when the requested slot (published/draft) is absent', async () => {
    const widget = makeWidget({ publishedSpec: htmlSpec('<p>x</p>'), draftSpec: null });
    const { manager } = makeManager(() => widget);
    track(manager);
    const { baseUrl } = await manager.ensure();
    expect((await fetch(`${baseUrl}/widget-draft/w1/1`)).status).toBe(404);
  });

  it('405s a POST', async () => {
    const widget = makeWidget({ publishedSpec: htmlSpec('<p>x</p>') });
    const { manager } = makeManager(() => widget);
    track(manager);
    const { baseUrl } = await manager.ensure();
    expect((await fetch(`${baseUrl}/widget/w1/1`, { method: 'POST' })).status).toBe(405);
  });

  it('supports HEAD with no body', async () => {
    const widget = makeWidget({ publishedSpec: htmlSpec('<p>x</p>') });
    const { manager } = makeManager(() => widget);
    track(manager);
    const { baseUrl } = await manager.ensure();
    const res = await fetch(`${baseUrl}/widget/w1/1`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('CustomWidgetServerManager lifecycle', () => {
  it('ensure is idempotent — same baseUrl, one origin registration, one watchdog start', async () => {
    const { manager, registerOrigin, watchdog } = makeManager(() => null);
    track(manager);
    const a = await manager.ensure();
    const b = await manager.ensure();
    expect(a).toEqual(b);
    expect(registerOrigin).toHaveBeenCalledTimes(1);
    expect(registerOrigin).toHaveBeenCalledWith(a.origin);
    expect(watchdog.start).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent ensures into a single server', async () => {
    const { manager, registerOrigin } = makeManager(() => null);
    track(manager);
    const [a, b] = await Promise.all([manager.ensure(), manager.ensure()]);
    expect(a).toEqual(b);
    expect(registerOrigin).toHaveBeenCalledTimes(1);
  });

  it('stop releases the port, unregisters the origin, stops the watchdog', async () => {
    const { manager, unregisterOrigin, watchdog } = makeManager(() => null);
    track(manager);
    const { baseUrl, origin } = await manager.ensure();

    const stopped = await manager.stop();
    expect(stopped).toBe(true);
    expect(unregisterOrigin).toHaveBeenCalledWith(origin);
    expect(watchdog.stop).toHaveBeenCalledTimes(1);
    await expect(fetch(`${baseUrl}/widget/w1/1`)).rejects.toBeTruthy();
  });

  it('stop returns false when nothing is running', async () => {
    const { manager } = makeManager(() => null);
    track(manager);
    expect(await manager.stop()).toBe(false);
  });

  it('exposes the live target under the custom-widgets sentinel runId', async () => {
    const { manager } = makeManager(() => null);
    track(manager);
    const { origin } = await manager.ensure();
    expect(manager.getTargets()).toEqual([{ origin, runId: CUSTOM_WIDGET_SERVER_RUN_ID }]);
    await manager.stop();
    expect(manager.getTargets()).toEqual([]);
  });
});
