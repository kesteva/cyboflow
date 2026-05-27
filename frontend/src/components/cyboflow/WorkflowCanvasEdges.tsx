/**
 * WorkflowCanvasEdges — SVG overlay that wires step cards into a phase graph.
 *
 * Renders one <path> per edge plus an optional animated token <circle>.
 * Positioned absolute, inset-0, pointer-events-none so it overlays the card grid.
 *
 * Edge types (mirroring dashboard.jsx FlowReadOnly lines 279–305):
 *   "down"   — vertical connector between consecutive steps within a phase
 *   "across" — horizontal connector from the last step of one phase to the
 *              first step of the next phase
 *   "loop"   — dashed rust connector from a step with step.loopback set back
 *              to the target step within the same phase
 *
 * Color note: #1a1815 (solid edge stroke) and #c96442 (loop/token rust) are
 * protoflow accent strokes with no semantic-token equivalent. The Q5 decision
 * to use CSS design tokens applies to surfaces and text; these two hex values
 * are intentional protoflow accent strokes and are therefore inlined here.
 *
 * TASK-770 / IDEA-026
 */
import type { WorkflowDefinition } from '../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Head-bar center Y offset within a card row (matches dashboard.jsx center()). */
export const HEAD_BAR_CENTER_Y = 30;

// Protoflow accent strokes — not in semantic token palette; see file comment.
const SOLID_STROKE = '#1a1815';
const LOOP_STROKE = '#c96442';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowCanvasEdgesProps {
  definition: WorkflowDefinition;
  currentStepIndex: number;
  stepRects: Map<string, DOMRect>;
  containerRect: DOMRect | null;
  token?: { x: number; y: number } | null;
}

interface Edge {
  fromId: string;
  toId: string;
  kind: 'down' | 'across' | 'loop';
}

// ---------------------------------------------------------------------------
// Edge enumeration (adapted from dashboard.jsx FlowReadOnly)
// ---------------------------------------------------------------------------

function enumerateEdges(definition: WorkflowDefinition): Edge[] {
  const edges: Edge[] = [];

  definition.phases.forEach((phase, phaseIdx) => {
    // Within-phase vertical connectors
    phase.steps.forEach((step, stepInPhase) => {
      if (stepInPhase < phase.steps.length - 1) {
        edges.push({
          fromId: step.id,
          toId: phase.steps[stepInPhase + 1].id,
          kind: 'down',
        });
      }

      // Loopback connector
      if (step.loopback) {
        const target = phase.steps.find((s) => s.id === step.loopback);
        if (target) {
          edges.push({ fromId: step.id, toId: target.id, kind: 'loop' });
        }
      }
    });

    // Across-phase connector: last step of this phase → first step of next phase
    if (phaseIdx < definition.phases.length - 1) {
      const lastStep = phase.steps[phase.steps.length - 1];
      const nextPhase = definition.phases[phaseIdx + 1];
      if (lastStep && nextPhase.steps.length > 0) {
        edges.push({
          fromId: lastStep.id,
          toId: nextPhase.steps[0].id,
          kind: 'across',
        });
      }
    }
  });

  return edges;
}

// ---------------------------------------------------------------------------
// Center computation (container-relative)
// ---------------------------------------------------------------------------

/**
 * Returns the center-top of a step card, container-relative.
 * cx = rect.x + rect.width / 2 (horizontal center)
 * cy = rect.y + HEAD_BAR_CENTER_Y (center of head bar)
 *
 * All rects are assumed to be already container-relative (computed by
 * WorkflowCanvas via getBoundingClientRect + containerRect subtraction).
 */
function center(rect: DOMRect): { cx: number; cy: number } {
  return {
    cx: rect.x + rect.width / 2,
    cy: rect.y + HEAD_BAR_CENTER_Y,
  };
}

// ---------------------------------------------------------------------------
// SVG path generator (adapted from dashboard.jsx path())
// ---------------------------------------------------------------------------

function buildPath(
  edge: Edge,
  fromRect: DOMRect,
  toRect: DOMRect,
): string {
  const a = center(fromRect);
  const b = center(toRect);

  if (edge.kind === 'down') {
    // Vertical connector: from bottom of head bar on from-card to top of head bar on to-card
    return `M ${a.cx} ${a.cy + HEAD_BAR_CENTER_Y} L ${a.cx} ${b.cy - HEAD_BAR_CENTER_Y}`;
  }

  if (edge.kind === 'across') {
    // Horizontal connector: from right edge of from-card to left edge of to-card
    const ax = a.cx + fromRect.width / 2;
    const bx = b.cx - toRect.width / 2;
    return `M ${ax} ${a.cy} L ${bx} ${b.cy}`;
  }

  if (edge.kind === 'loop') {
    // L-shaped loopback out to the right then back
    const midX = a.cx + fromRect.width / 2 + 12;
    return `M ${a.cx + fromRect.width / 2} ${a.cy} L ${midX} ${a.cy} L ${midX} ${b.cy} L ${b.cx + toRect.width / 2} ${b.cy}`;
  }

  return '';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkflowCanvasEdges({
  definition,
  currentStepIndex: _currentStepIndex,
  stepRects,
  containerRect,
  token = null,
}: WorkflowCanvasEdgesProps) {
  const edges = enumerateEdges(definition);

  // Resolve paths — skip any edge whose rects are missing or container is null
  const resolvedPaths: Array<{ d: string; edge: Edge }> = [];

  if (containerRect !== null) {
    for (const edge of edges) {
      const fromRect = stepRects.get(edge.fromId);
      const toRect = stepRects.get(edge.toId);
      if (!fromRect || !toRect) continue;
      const d = buildPath(edge, fromRect, toRect);
      if (d) {
        resolvedPaths.push({ d, edge });
      }
    }
  }

  return (
    <svg
      // SVG overlay: position:absolute; inset:0; pointer-events:none; width:100%; height:100%
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
      aria-hidden="true"
    >
      <defs>
        <marker
          id="cyboflow-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" fill={SOLID_STROKE} />
        </marker>
        <marker
          id="cyboflow-arrow-loop"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" fill={LOOP_STROKE} />
        </marker>
      </defs>

      {resolvedPaths.map(({ d, edge }, idx) => {
        const isLoop = edge.kind === 'loop';
        return (
          <path
            key={idx}
            d={d}
            stroke={isLoop ? LOOP_STROKE : SOLID_STROKE}
            strokeWidth={isLoop ? 1.2 : 1.4}
            strokeDasharray={isLoop ? '4 3' : '0'}
            fill="none"
            markerEnd={`url(#${isLoop ? 'cyboflow-arrow-loop' : 'cyboflow-arrow'})`}
          />
        );
      })}

      {token !== null && (
        <circle cx={token.x} cy={token.y} r={4} fill={LOOP_STROKE} />
      )}
    </svg>
  );
}
