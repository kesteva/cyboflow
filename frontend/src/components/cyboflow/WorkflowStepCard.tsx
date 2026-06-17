/**
 * WorkflowStepCard — single step card with five visual variants.
 *
 * Variants: pending, running, done, human, optional.
 * Variants compose: done+human+optional are all valid simultaneously.
 *
 * TASK-769 / IDEA-026
 */
import type { WorkflowStep, WorkflowPhase } from '../../../../shared/types/workflows';
import { resolveStepAgentKey } from '../../../../shared/types/agentIdentity';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepStatus = 'pending' | 'running' | 'done';

export interface WorkflowStepCardProps {
  step: WorkflowStep;
  phase: WorkflowPhase;
  /** 1-based global step index across all phases. */
  stepIndex: number;
  status: StepStatus;
}

// ---------------------------------------------------------------------------
// WorkflowStepCard
// ---------------------------------------------------------------------------

export function WorkflowStepCard({ step, phase, stepIndex, status }: WorkflowStepCardProps) {
  const isPending = status === 'pending';
  const isRunning = status === 'running';
  const isDone = status === 'done';
  const isHuman = step.human === true;
  const isOptional = step.optional === true;

  // State text for the foot area
  const stateLabel = isRunning ? 'RUNNING' : isDone ? 'DONE' : 'PENDING';

  // ── Root styles ────────────────────────────────────────────────────────────
  // Done cards: position relative + GPU promotion via translateZ(0) + will-change
  // Running cards: 2px outline using status-error token (status-running not yet
  //   defined in tailwind.config.js — substituting status-error per plan guidance).
  // Human cards: amber border (status-warning) + inner halo box-shadow.
  const rootStyle: React.CSSProperties = {
    width: 138,
    borderWidth: '1.4px',
    borderStyle: 'solid',
    borderColor: isDone
      ? '#1a1815'
      : isHuman
        ? 'var(--color-status-warning)'
        : isPending
          ? '#d8cfb8'
          : '#1a1815',
    background: isPending ? '#efeadc' : '#fff',
    position: 'relative',
    ...(isDone
      ? {
          // Done: GPU layer promotion per IDEA-026 Area C
          transform: 'translateZ(0)',
          willChange: 'transform',
        }
      : {}),
    ...(isRunning
      ? {
          // Running: 2px outline using status-error token
          // (status-running not defined; status-error is the rust-red #c96442 equivalent)
          outlineStyle: 'solid',
          outlineWidth: '2px',
          outlineColor: 'var(--color-status-error)',
          outlineOffset: '2px',
        }
      : {}),
    ...(isHuman
      ? {
          // Human: inner amber halo
          boxShadow: '0 0 0 1px var(--color-status-warning)',
        }
      : {}),
  };

  // ── Head bar background ────────────────────────────────────────────────────
  const headBackground = isHuman
    ? 'repeating-linear-gradient(135deg, #d99a3d 0px 6px, #c98a2d 6px 12px)'
    : phase.color;

  // Phase abbreviation — first 3 characters, uppercase
  const phaseAbbrev = phase.label.slice(0, 3).toUpperCase();

  // Step index — zero-padded 2 digits
  const stepIndexStr = String(stepIndex).padStart(2, '0');

  // ── Dot color (foot) ───────────────────────────────────────────────────────
  const dotColor = isDone
    ? 'var(--color-status-success)'
    : isRunning
      ? 'var(--color-status-error)'
      : '#c8bea3';

  // ── Agent short name — resolved canonical key (legacy labels mapped) ───────
  const agentShortName = resolveStepAgentKey(step.id, step.agent) ?? step.agent;

  return (
    <div style={rootStyle} data-testid={`step-card-${step.id}`}>
      {/* ── Head bar ──────────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 7px',
          background: headBackground,
          color: '#fff',
          fontSize: 9,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          ...(isPending ? { filter: 'grayscale(0.7)', opacity: 0.55 } : {}),
        }}
        data-testid={`step-card-head-${step.id}`}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span>{phaseAbbrev}</span>
          {isOptional && (
            <span
              style={{
                fontSize: 8.5,
                letterSpacing: '0.14em',
                fontWeight: 700,
                background: 'rgba(255,255,255,0.22)',
                padding: '1px 5px',
                borderRadius: 2,
              }}
              data-testid={`step-card-optional-chip-${step.id}`}
            >
              OPTIONAL
            </span>
          )}
        </span>
        <span style={{ opacity: 0.6 }}>{stepIndexStr}</span>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div style={{ padding: '6px 8px 7px', minWidth: 0 }}>
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            color: isPending ? '#9c8e6c' : '#1a1815',
            lineHeight: 1.25,
            letterSpacing: '-0.005em',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word',
          }}
        >
          {step.name}
        </div>
        <div
          style={{
            marginTop: 5,
            fontSize: 9.5,
            color: isPending ? '#b3a685' : '#6a5e44',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {agentShortName}
          </span>
          <span style={{ flexShrink: 0 }}>×{step.retries}</span>
        </div>
      </div>

      {/* ── Foot ──────────────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '4px 8px',
          borderTop: isPending ? '1px dashed #e6dec7' : '1px dashed #d8cfb8',
          fontSize: 8.5,
          letterSpacing: '0.08em',
          color: isPending ? '#b3a685' : '#6a5e44',
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: dotColor,
            flexShrink: 0,
          }}
          data-testid={`step-card-dot-${step.id}`}
        />
        <span>{stateLabel}</span>
      </div>

      {/* ── Human badge ───────────────────────────────────────────────────── */}
      {isHuman && (
        <span
          aria-label="human step"
          style={{
            position: 'absolute',
            top: -9,
            right: -9,
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: '#d99a3d',
            border: '1.5px solid #1a1815',
            color: '#1a1815',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 3,
          }}
          data-testid={`step-card-human-badge-${step.id}`}
        >
          {/* Inline SVG person glyph */}
          <svg
            aria-hidden="true"
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="6" cy="4" r="2" />
            <path d="M2 11c.4-2.3 2-3.5 4-3.5s3.6 1.2 4 3.5" />
          </svg>
        </span>
      )}

      {/* ── Done: frosted-glass overlay (DIRECT child of root) ────────────── */}
      {isDone && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(245,241,232,0.62)',
            backdropFilter: 'blur(2px)',
            WebkitBackdropFilter: 'blur(2px)',
            pointerEvents: 'none',
            willChange: 'transform',
          }}
          data-testid={`step-card-frosted-overlay-${step.id}`}
        />
      )}

      {/* ── Done: green check circle ──────────────────────────────────────── */}
      {isDone && (
        <span
          aria-label="completed"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'var(--color-status-success)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2,
            boxShadow: '0 2px 6px rgba(45,138,91,0.35)',
          }}
          data-testid={`step-card-check-${step.id}`}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2.5 7.5l3 3 6-6" />
          </svg>
        </span>
      )}
    </div>
  );
}
