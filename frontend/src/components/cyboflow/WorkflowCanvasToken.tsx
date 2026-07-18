/**
 * WorkflowCanvasToken — isolated animated token dot for the workflow canvas.
 *
 * Owns the per-frame RAF clock (useWorkflowTokenAnimation) so the ~60-120fps
 * setState it drives stays confined to this small leaf component instead of
 * cascading through WorkflowCanvas's step-card + edge tree on every frame.
 * Receives stable endpoint props (fromX/fromY/toX/toY, computed by
 * WorkflowCanvas from stepRects + currentIdx) that only change on a real step
 * transition or rect re-measure — never on the token's own ticks.
 *
 * Renders an absolutely-positioned SVG overlay containing only the token
 * <circle>, using the same container-relative coordinate system as
 * WorkflowCanvasEdges so it visually aligns with the edge paths beneath it.
 * Memoized so identical props (unchanged endpoints/enabled) skip re-render.
 *
 * Renders nothing when disabled or when endpoints haven't been measured yet
 * (mirrors the prior inline token useMemo's null cases).
 */
import { memo } from 'react';
import { useWorkflowTokenAnimation } from '../../hooks/useWorkflowTokenAnimation';

// Protoflow loop/token accent stroke — matches WorkflowCanvasEdges' LOOP_STROKE.
const TOKEN_FILL = '#c96442';

export interface WorkflowCanvasTokenProps {
  enabled: boolean;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
}

function WorkflowCanvasTokenImpl({ enabled, fromX, fromY, toX, toY }: WorkflowCanvasTokenProps) {
  const t = useWorkflowTokenAnimation({ enabled });

  if (!enabled || fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
    return null;
  }

  const x = fromX + (toX - fromX) * t;
  const y = fromY + (toY - fromY) * t;

  return (
    <svg
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
      aria-hidden="true"
      data-testid="workflow-canvas-token-overlay"
    >
      <circle cx={x} cy={y} r={4} fill={TOKEN_FILL} />
    </svg>
  );
}

export const WorkflowCanvasToken = memo(WorkflowCanvasTokenImpl);
