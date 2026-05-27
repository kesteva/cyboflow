/**
 * WorkflowCanvasEdges component tests (TASK-770).
 *
 * Uses synthetic WorkflowDefinition (2 phases × 2 steps, one step with loopback)
 * and a fully-populated stepRects Map.
 *
 * Behaviors verified:
 *   (a) Correct path count for a 2-phase × 2-step definition with one loopback
 *   (b) Loop edges have stroke-dasharray='4 3' and stroke='#c96442'
 *   (c) Missing stepRects → no paths rendered, no throw
 *   (d) Two marker elements present in <defs>
 *   (e) Optional token prop renders <circle> at given cx/cy
 */
import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { WorkflowCanvasEdges } from '../WorkflowCanvasEdges';
import type { WorkflowDefinition } from '../../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a DOMRect-compatible object.
 * jsdom does not always expose the DOMRect constructor, so we create a plain
 * object matching the DOMRect interface used by WorkflowCanvasEdges.
 */
function makeRect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * 2-phase × 2-step definition.
 *   phase-1: step-a, step-b (step-b has loopback → step-a)
 *   phase-2: step-c, step-d
 *
 * Expected edges:
 *   down:   step-a → step-b  (within phase-1)
 *   loop:   step-b → step-a  (loopback in phase-1)
 *   across: step-b → step-c  (phase-1 last → phase-2 first)
 *   down:   step-c → step-d  (within phase-2)
 *   Total: 4 edges → 4 <path> elements
 */
const DEFINITION: WorkflowDefinition = {
  id: 'sprint',
  phases: [
    {
      id: 'phase-1',
      label: 'Plan',
      color: '#3b6dd6',
      steps: [
        { id: 'step-a', name: 'Step A', agent: 'planner', mcps: [], retries: 0 },
        { id: 'step-b', name: 'Step B', agent: 'executor', mcps: [], retries: 3, loopback: 'step-a' },
      ],
    },
    {
      id: 'phase-2',
      label: 'Execute',
      color: '#c96442',
      steps: [
        { id: 'step-c', name: 'Step C', agent: 'verifier', mcps: [], retries: 0 },
        { id: 'step-d', name: 'Step D', agent: 'human', mcps: [], retries: 0, human: true },
      ],
    },
  ],
};

// Layout: phase-1 at x=12, phase-2 at x=12+138+14=164; each card 138×86
const STEP_RECTS: Map<string, DOMRect> = new Map([
  ['step-a', makeRect(12,  28, 138, 86)],
  ['step-b', makeRect(12, 114, 138, 86)],
  ['step-c', makeRect(164,  28, 138, 86)],
  ['step-d', makeRect(164, 114, 138, 86)],
]);

const CONTAINER_RECT = makeRect(0, 0, 400, 300);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowCanvasEdges — path count', () => {
  it('(a) renders 4 paths for 2-phase × 2-step definition with one loopback', () => {
    const { container } = render(
      <WorkflowCanvasEdges
        definition={DEFINITION}
        currentStepIndex={0}
        stepRects={STEP_RECTS}
        containerRect={CONTAINER_RECT}
      />,
    );

    const paths = container.querySelectorAll('path[stroke]');
    // 4 edge paths (down + loop + across + down); marker inner paths have fill not stroke
    expect(paths).toHaveLength(4);
  });
});

describe('WorkflowCanvasEdges — loop edge styling', () => {
  it('(b) loop edges have stroke-dasharray="4 3" and stroke="#c96442"', () => {
    const { container } = render(
      <WorkflowCanvasEdges
        definition={DEFINITION}
        currentStepIndex={0}
        stepRects={STEP_RECTS}
        containerRect={CONTAINER_RECT}
      />,
    );

    const allPaths = Array.from(container.querySelectorAll('path[stroke]'));
    const loopPaths = allPaths.filter(
      (p) => p.getAttribute('stroke-dasharray') === '4 3',
    );
    expect(loopPaths).toHaveLength(1);
    const loopPath = loopPaths[0];
    expect(loopPath.getAttribute('stroke')).toBe('#c96442');
    expect(loopPath.getAttribute('stroke-dasharray')).toBe('4 3');
    expect(loopPath.getAttribute('marker-end')).toBe('url(#cyboflow-arrow-loop)');
  });

  it('solid edges have stroke="#1a1815" and no dasharray', () => {
    const { container } = render(
      <WorkflowCanvasEdges
        definition={DEFINITION}
        currentStepIndex={0}
        stepRects={STEP_RECTS}
        containerRect={CONTAINER_RECT}
      />,
    );

    const allPaths = Array.from(container.querySelectorAll('path[stroke]'));
    const solidPaths = allPaths.filter(
      (p) => p.getAttribute('stroke') === '#1a1815',
    );
    // 3 solid paths: down + across + down
    expect(solidPaths).toHaveLength(3);
    solidPaths.forEach((p) => {
      expect(p.getAttribute('marker-end')).toBe('url(#cyboflow-arrow)');
    });
  });
});

describe('WorkflowCanvasEdges — missing stepRects', () => {
  it('(c) empty stepRects → no paths rendered, no throw', () => {
    const { container } = render(
      <WorkflowCanvasEdges
        definition={DEFINITION}
        currentStepIndex={0}
        stepRects={new Map()}
        containerRect={CONTAINER_RECT}
      />,
    );

    const paths = container.querySelectorAll('path[stroke]');
    expect(paths).toHaveLength(0);
  });

  it('(c) null containerRect → no paths rendered, no throw', () => {
    const { container } = render(
      <WorkflowCanvasEdges
        definition={DEFINITION}
        currentStepIndex={0}
        stepRects={STEP_RECTS}
        containerRect={null}
      />,
    );

    const paths = container.querySelectorAll('path[stroke]');
    expect(paths).toHaveLength(0);
  });

  it('(c) partially populated stepRects → only paths with both rects present', () => {
    // Only step-a and step-b present; step-c/step-d missing
    // Edges: down(a→b) + loop(b→a) → 2 paths; across(b→c) skipped
    const partialRects: Map<string, DOMRect> = new Map([
      ['step-a', makeRect(12,  28, 138, 86)],
      ['step-b', makeRect(12, 114, 138, 86)],
    ]);

    const { container } = render(
      <WorkflowCanvasEdges
        definition={DEFINITION}
        currentStepIndex={0}
        stepRects={partialRects}
        containerRect={CONTAINER_RECT}
      />,
    );

    const paths = container.querySelectorAll('path[stroke]');
    expect(paths).toHaveLength(2);
  });
});

describe('WorkflowCanvasEdges — SVG markers', () => {
  it('(d) defines marker#cyboflow-arrow and marker#cyboflow-arrow-loop', () => {
    const { container } = render(
      <WorkflowCanvasEdges
        definition={DEFINITION}
        currentStepIndex={0}
        stepRects={STEP_RECTS}
        containerRect={CONTAINER_RECT}
      />,
    );

    // Query by ID within the SVG defs
    const arrowMarker = container.querySelector('marker#cyboflow-arrow');
    const loopMarker = container.querySelector('marker#cyboflow-arrow-loop');

    expect(arrowMarker).not.toBeNull();
    expect(loopMarker).not.toBeNull();

    // Fallback: innerHTML contains the id strings (jsdom marker-query defensive)
    expect(container.innerHTML).toContain('id="cyboflow-arrow"');
    expect(container.innerHTML).toContain('id="cyboflow-arrow-loop"');
  });
});

describe('WorkflowCanvasEdges — token prop', () => {
  it('(e) renders no <circle> when token is not passed', () => {
    const { container } = render(
      <WorkflowCanvasEdges
        definition={DEFINITION}
        currentStepIndex={0}
        stepRects={STEP_RECTS}
        containerRect={CONTAINER_RECT}
      />,
    );

    expect(container.querySelector('circle')).toBeNull();
  });

  it('(e) token={x:42,y:24} renders <circle cx="42" cy="24" r="4" fill="#c96442">', () => {
    const { container } = render(
      <WorkflowCanvasEdges
        definition={DEFINITION}
        currentStepIndex={0}
        stepRects={STEP_RECTS}
        containerRect={CONTAINER_RECT}
        token={{ x: 42, y: 24 }}
      />,
    );

    const circle = container.querySelector('circle');
    expect(circle).not.toBeNull();
    expect(circle?.getAttribute('cx')).toBe('42');
    expect(circle?.getAttribute('cy')).toBe('24');
    expect(circle?.getAttribute('r')).toBe('4');
    expect(circle?.getAttribute('fill')).toBe('#c96442');
  });

  it('(e) token=null renders no <circle>', () => {
    const { container } = render(
      <WorkflowCanvasEdges
        definition={DEFINITION}
        currentStepIndex={0}
        stepRects={STEP_RECTS}
        containerRect={CONTAINER_RECT}
        token={null}
      />,
    );

    expect(container.querySelector('circle')).toBeNull();
  });
});
