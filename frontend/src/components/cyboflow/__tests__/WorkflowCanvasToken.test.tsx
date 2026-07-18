/**
 * WorkflowCanvasToken component tests (renderer-perf fix: isolate the
 * per-frame animated token from WorkflowCanvas's own render).
 *
 * Behaviors verified:
 *   (a) exported as a React.memo-wrapped component
 *   (b) enabled + endpoints present → renders a <circle> at the from-
 *       coordinates before the first RAF tick (t=0)
 *   (c) enabled=false → renders nothing (no <svg>, no <circle>)
 *   (d) endpoints not yet measured (undefined) → renders nothing even when
 *       enabled=true
 */
import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { WorkflowCanvasToken } from '../WorkflowCanvasToken';

/** Minimal shape of a React.memo-wrapped component for the identity check below. */
interface MemoLike {
  $$typeof: symbol;
}

describe('WorkflowCanvasToken — memoization', () => {
  it('(a) is wrapped in React.memo so identical props skip re-render', () => {
    expect((WorkflowCanvasToken as unknown as MemoLike).$$typeof).toBe(Symbol.for('react.memo'));
  });
});

describe('WorkflowCanvasToken — rendering', () => {
  it('(b) renders a <circle> at the from-coordinates before the first RAF tick', () => {
    const { container } = render(
      <WorkflowCanvasToken enabled fromX={10} fromY={20} toX={110} toY={220} />,
    );

    expect(container.querySelector('[data-testid="workflow-canvas-token-overlay"]')).not.toBeNull();
    const circle = container.querySelector('circle');
    expect(circle).not.toBeNull();
    expect(circle?.getAttribute('cx')).toBe('10');
    expect(circle?.getAttribute('cy')).toBe('20');
    expect(circle?.getAttribute('r')).toBe('4');
    expect(circle?.getAttribute('fill')).toBe('#c96442');
  });

  it('(c) enabled=false renders nothing', () => {
    const { container } = render(
      <WorkflowCanvasToken enabled={false} fromX={10} fromY={20} toX={110} toY={220} />,
    );

    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('circle')).toBeNull();
  });

  it('(d) missing endpoints renders nothing even when enabled=true', () => {
    const { container } = render(<WorkflowCanvasToken enabled />);

    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('circle')).toBeNull();
  });
});
