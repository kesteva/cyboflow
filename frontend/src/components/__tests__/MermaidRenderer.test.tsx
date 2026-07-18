/**
 * MermaidRenderer async-race tests.
 *
 * `mermaid.render` is asynchronous and the effect re-runs on every `chart`
 * revision (streamed charts revise rapidly while the SAME component instance
 * is preserved). Without the cancellation fence, an OLDER render resolving
 * last would overwrite the newer chart's SVG in the shared elementRef.
 */
import '@testing-library/jest-dom';
import { render, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Deferred {
  promise: Promise<{ svg: string }>;
  resolve: (value: { svg: string }) => void;
}
function createDeferred(): Deferred {
  let resolve!: (value: { svg: string }) => void;
  const promise = new Promise<{ svg: string }>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const renderCalls: Array<{ chart: string; deferred: Deferred }> = [];

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn((_graphId: string, chart: string) => {
      const deferred = createDeferred();
      renderCalls.push({ chart, deferred });
      return deferred.promise;
    }),
  },
}));

import { MermaidRenderer } from '../MermaidRenderer';

beforeEach(() => {
  renderCalls.length = 0;
  vi.clearAllMocks();
});

describe('MermaidRenderer', () => {
  it('a stale render resolving after a newer chart revision does not overwrite it', async () => {
    const { container, rerender } = render(
      <MermaidRenderer chart="graph TD; A-->B" id="test" />,
    );

    // The effect defers renderChart by 50ms — wait for the first call to start.
    await waitFor(() => expect(renderCalls.length).toBe(1));
    expect(renderCalls[0].chart).toBe('graph TD; A-->B');

    // Chart revision while the first render is still in flight.
    rerender(<MermaidRenderer chart="graph TD; A-->C" id="test" />);
    await waitFor(() => expect(renderCalls.length).toBe(2));

    // The NEWER render resolves first and lands its SVG...
    await act(async () => {
      renderCalls[1].deferred.resolve({ svg: '<svg data-chart="new"></svg>' });
    });
    await waitFor(() =>
      expect(container.querySelector('[data-chart="new"]')).toBeInTheDocument(),
    );

    // ...then the STALE first render resolves — it must be discarded.
    await act(async () => {
      renderCalls[0].deferred.resolve({ svg: '<svg data-chart="stale"></svg>' });
    });
    expect(container.querySelector('[data-chart="new"]')).toBeInTheDocument();
    expect(container.querySelector('[data-chart="stale"]')).not.toBeInTheDocument();
  });

  it('renders the SVG for the current chart on the happy path', async () => {
    const { container } = render(<MermaidRenderer chart="graph LR; X-->Y" id="ok" />);

    await waitFor(() => expect(renderCalls.length).toBe(1));
    await act(async () => {
      renderCalls[0].deferred.resolve({ svg: '<svg data-chart="ok"></svg>' });
    });
    await waitFor(() =>
      expect(container.querySelector('[data-chart="ok"]')).toBeInTheDocument(),
    );
  });
});
