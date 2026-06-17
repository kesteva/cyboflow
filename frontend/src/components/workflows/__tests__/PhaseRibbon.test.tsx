/**
 * PhaseRibbon tests — the PURELY PRESENTATIONAL phase ribbon.
 *
 * Pins the three contract points called out for Stage 1:
 *   1. Segment width is PROPORTIONAL to step count (a 3-step phase is 3x a
 *      1-step phase) via flexGrow = max(1, steps) + flexBasis 0 — the fix for
 *      FlowProgress's equal-width `flex-1`.
 *   2. `thin` renders an 8px-tall, label-less bar.
 *   3. It renders with NO runId / NO subscription — the props don't even admit a
 *      runId, and rendering N ribbons opens zero subscriptions. We assert it
 *      renders standalone (no provider / no trpc client) without throwing.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PhaseRibbon } from '../PhaseRibbon';
import type { WorkflowDefinition } from '../../../../../shared/types/workflows';

const DEF: WorkflowDefinition = {
  id: 'fixture',
  phases: [
    {
      id: 'one',
      label: 'Plan',
      color: '#3b6dd6',
      steps: [{ id: 's1', name: 'S1', agent: 'context', mcps: [], retries: 0 }],
    },
    {
      id: 'three',
      label: 'Execute',
      color: '#c96442',
      steps: [
        { id: 's2', name: 'S2', agent: 'implement', mcps: [], retries: 0 },
        { id: 's3', name: 'S3', agent: 'implement', mcps: [], retries: 0 },
        { id: 's4', name: 'S4', agent: 'implement', mcps: [], retries: 0 },
      ],
    },
  ],
};

describe('PhaseRibbon', () => {
  it('renders one segment per phase with width proportional to step count', () => {
    const { container } = render(<PhaseRibbon definition={DEF} />);
    const segments = container.firstElementChild!.children;
    expect(segments).toHaveLength(2);

    const oneStep = segments[0] as HTMLElement;
    const threeStep = segments[1] as HTMLElement;

    // flexGrow encodes the proportional width; a 3-step phase is 3x a 1-step phase.
    expect(oneStep.style.flexGrow).toBe('1');
    expect(threeStep.style.flexGrow).toBe('3');
    // flexBasis 0 so flexGrow alone drives the proportion.
    expect(oneStep.style.flexBasis).toBe('0px');
    expect(threeStep.style.flexBasis).toBe('0px');
  });

  it('fills each segment bar with the literal phase hex', () => {
    const { container } = render(<PhaseRibbon definition={DEF} />);
    const bars = container.querySelectorAll('div.h-1');
    expect(bars).toHaveLength(2);
    expect((bars[0] as HTMLElement).style.backgroundColor).toBe('rgb(59, 109, 214)'); // #3b6dd6
    expect((bars[1] as HTMLElement).style.backgroundColor).toBe('rgb(201, 100, 66)'); // #c96442
  });

  it('renders uppercase phase abbreviations as labels (non-thin)', () => {
    const { container } = render(<PhaseRibbon definition={DEF} />);
    const labels = Array.from(container.querySelectorAll('span')).map((s) => s.textContent);
    expect(labels).toEqual(['PLAN', 'EXEC']);
  });

  it('thin renders an 8px-tall, label-less bar', () => {
    const { container } = render(<PhaseRibbon definition={DEF} thin />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.height).toBe('8px');
    // No labels in thin mode.
    expect(container.querySelectorAll('span')).toHaveLength(0);
    // Still one proportional segment per phase.
    const segments = root.children;
    expect(segments).toHaveLength(2);
    expect((segments[0] as HTMLElement).style.flexGrow).toBe('1');
    expect((segments[1] as HTMLElement).style.flexGrow).toBe('3');
  });

  it('renders standalone with NO runId / NO subscription (no provider needed)', () => {
    // The props admit no runId; rendering without any tRPC provider must not throw
    // and must open zero subscriptions — proven by the bare render succeeding.
    expect(() => render(<PhaseRibbon definition={DEF} />)).not.toThrow();
  });
});
