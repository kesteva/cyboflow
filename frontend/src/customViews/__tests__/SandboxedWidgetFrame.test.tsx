/**
 * SandboxedWidgetFrame — the parent half of the tier-3 bridge
 * (docs/proposals/CUSTOM-VIEWS.md §5.4, §10's "Frame isolation").
 *
 * What matters here is what the parent REFUSES. A widget document is arbitrary
 * author JS; the only thing standing between it and the executor is the
 * acceptance rule for inbound messages, so that rule is tested directly
 * (`isTrustedFrameMessage`) as well as through a rendered frame. The frame's own
 * `sandbox` attribute is pinned too: `allow-scripts` and nothing else — adding
 * `allow-same-origin` would hand the document the app's own origin.
 */
import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WIDGET_ACT_MESSAGE,
  WIDGET_DATA_MESSAGE,
  WIDGET_RESIZE_MESSAGE,
} from '../../../../shared/customViews/widgetDocument';

const ensure = vi.fn();

vi.mock('../../trpc/client', () => ({
  trpc: { cyboflow: { customWidgetServer: { ensure: { mutate: () => ensure() } } } },
}));

import {
  SandboxedWidgetFrame,
  isTrustedFrameMessage,
  MAX_FRAME_HEIGHT,
  MIN_FRAME_HEIGHT,
} from '../SandboxedWidgetFrame';

const ORIGIN = 'http://127.0.0.1:51234';
const BASE_URL = `${ORIGIN}/tok3n`;

beforeEach(() => {
  ensure.mockReset().mockResolvedValue({ baseUrl: BASE_URL, origin: ORIGIN });
});

// ---------------------------------------------------------------------------
// The acceptance rule, in isolation
// ---------------------------------------------------------------------------

describe('isTrustedFrameMessage', () => {
  const frameWindow = {} as Window;

  it('accepts the frame window posting from its opaque sandbox origin', () => {
    expect(isTrustedFrameMessage({ source: frameWindow, origin: 'null' }, frameWindow, ORIGIN)).toBe(true);
  });

  it('accepts the frame window posting from the server origin', () => {
    expect(isTrustedFrameMessage({ source: frameWindow, origin: ORIGIN }, frameWindow, ORIGIN)).toBe(true);
  });

  it('refuses a different source window even with the right origin', () => {
    const other = {} as Window;
    expect(isTrustedFrameMessage({ source: other, origin: ORIGIN }, frameWindow, ORIGIN)).toBe(false);
  });

  it('refuses a foreign origin even from the frame window', () => {
    expect(
      isTrustedFrameMessage({ source: frameWindow, origin: 'https://evil.example' }, frameWindow, ORIGIN),
    ).toBe(false);
  });

  it('refuses everything before the frame has a content window', () => {
    expect(isTrustedFrameMessage({ source: null, origin: 'null' }, null, ORIGIN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The rendered frame
// ---------------------------------------------------------------------------

describe('SandboxedWidgetFrame', () => {
  function renderFrame(onAct = vi.fn(), draft = false): { onAct: ReturnType<typeof vi.fn> } {
    render(
      <SandboxedWidgetFrame
        widgetId="w7"
        revision={4}
        draft={draft}
        sources={{ rows: { columns: ['a'], rows: [{ a: 1 }], truncated: false, tookMs: 1 } }}
        settings={{ project: null }}
        context={{ projectId: null }}
        onAct={onAct}
      />,
    );
    return { onAct };
  }

  it('serves the published document from the loopback server, script-sandboxed', async () => {
    renderFrame();
    const frame = await screen.findByTestId('widget-sandbox-frame');
    expect(frame).toHaveAttribute('src', `${BASE_URL}/widget/w7/4`);
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  });

  it('serves the draft document when told the spec is a draft', async () => {
    renderFrame(vi.fn(), true);
    const frame = await screen.findByTestId('widget-sandbox-frame');
    expect(frame).toHaveAttribute('src', `${BASE_URL}/widget-draft/w7/4`);
  });

  it('pushes the data payload into the frame on load', async () => {
    renderFrame();
    const frame = (await screen.findByTestId('widget-sandbox-frame')) as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage }, configurable: true });

    act(() => {
      frame.dispatchEvent(new Event('load'));
    });
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    const [message] = postMessage.mock.calls[0] as [{ type: string; payload: { theme: unknown } }];
    expect(message.type).toBe(WIDGET_DATA_MESSAGE);
    expect(message.payload.theme).toBeDefined();
  });

  it('forwards a valid act request and ignores wrong-origin / wrong-source ones', async () => {
    const onAct = vi.fn();
    renderFrame(onAct);
    const frame = (await screen.findByTestId('widget-sandbox-frame')) as HTMLIFrameElement;
    const frameWindow = { postMessage: vi.fn() };
    Object.defineProperty(frame, 'contentWindow', { value: frameWindow, configurable: true });

    const post = (source: unknown, origin: string, data: unknown): void => {
      const event = new MessageEvent('message', { data, origin });
      Object.defineProperty(event, 'source', { value: source });
      act(() => {
        window.dispatchEvent(event);
      });
    };
    const actMessage = { type: WIDGET_ACT_MESSAGE, actionId: 'open', rowKeyValue: 's-1' };

    post({}, 'null', actMessage); // a different window
    post(frameWindow, 'https://evil.example', actMessage); // a foreign origin
    expect(onAct).not.toHaveBeenCalled();

    post(frameWindow, 'null', actMessage);
    expect(onAct).toHaveBeenCalledWith('open', 's-1');
  });

  it('clamps a resize request into the allowed range', async () => {
    renderFrame();
    const frame = (await screen.findByTestId('widget-sandbox-frame')) as HTMLIFrameElement;
    const frameWindow = { postMessage: vi.fn() };
    Object.defineProperty(frame, 'contentWindow', { value: frameWindow, configurable: true });

    const resize = (height: number): void => {
      const event = new MessageEvent('message', {
        data: { type: WIDGET_RESIZE_MESSAGE, height },
        origin: 'null',
      });
      Object.defineProperty(event, 'source', { value: frameWindow });
      act(() => {
        window.dispatchEvent(event);
      });
    };

    resize(99_999);
    await waitFor(() => expect(frame.style.height).toBe(`${MAX_FRAME_HEIGHT}px`));
    resize(1);
    await waitFor(() => expect(frame.style.height).toBe(`${MIN_FRAME_HEIGHT}px`));
  });

  it('reports a server that will not start rather than rendering a dead frame', async () => {
    ensure.mockRejectedValue(new Error('EADDRINUSE'));
    renderFrame();
    expect(await screen.findByTestId('widget-frame-unavailable')).toHaveTextContent('EADDRINUSE');
  });
});
