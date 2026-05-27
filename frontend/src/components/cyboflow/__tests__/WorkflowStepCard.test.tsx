/**
 * WorkflowStepCard component tests (TASK-769).
 *
 * Behaviors verified:
 *   1. Pending variant: muted bg, head ~55% opacity, muted dot.
 *   2. Running variant: outline using status-error token, running dot.
 *   3. Done variant: frosted-glass overlay + 30px green check visible.
 *   4. Human variant: person-glyph badge (aria-label="human step") + amber border + striped head.
 *   5. Optional variant: "OPTIONAL" chip visible in head bar.
 *   6. Head bar: phase color background + uppercase phase abbreviation + 2-digit step index.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { WorkflowStepCard } from '../WorkflowStepCard';
import type { WorkflowStep, WorkflowPhase } from '../../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_PHASE: WorkflowPhase = {
  id: 'execute',
  label: 'Execute',
  color: '#c96442',
  steps: [],
};

const MOCK_STEP: WorkflowStep = {
  id: 'implement',
  name: 'Implement task',
  agent: 'executor-agent',
  mcps: ['filesystem', 'bash'],
  retries: 3,
};

const MOCK_STEP_HUMAN: WorkflowStep = {
  id: 'human-review',
  name: 'Human review',
  agent: 'human',
  mcps: [],
  retries: 0,
  human: true,
};

const MOCK_STEP_OPTIONAL: WorkflowStep = {
  id: 'visual-verify',
  name: 'Visual verification',
  agent: 'visual-verifier',
  mcps: ['maestro'],
  retries: 1,
  optional: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowStepCard', () => {
  it('pending variant: head bar has reduced opacity and dot uses muted color', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP}
        phase={MOCK_PHASE}
        stepIndex={3}
        status="pending"
      />,
    );

    const head = screen.getByTestId('step-card-head-implement');
    // Head bar should have opacity ~55% when pending
    expect(head).toHaveStyle({ opacity: '0.55' });

    // Dot should use muted color #c8bea3 (not success or error)
    const dot = screen.getByTestId('step-card-dot-implement');
    expect(dot).toHaveStyle({ background: '#c8bea3' });
  });

  it('running variant: outline uses status-error CSS var', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP}
        phase={MOCK_PHASE}
        stepIndex={3}
        status="running"
      />,
    );

    const card = screen.getByTestId('step-card-implement');
    // Running outline: 2px solid status-error (cyboflow token for rust-red running state)
    expect(card).toHaveStyle({
      outlineStyle: 'solid',
      outlineWidth: '2px',
      // CSS var is resolved at runtime; test the presence of the var reference
      outlineColor: 'var(--color-status-error)',
    });
  });

  it('done variant: frosted-glass overlay present + green check circle present', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP}
        phase={MOCK_PHASE}
        stepIndex={3}
        status="done"
      />,
    );

    // Frosted overlay is a DIRECT child of card root
    const overlay = screen.getByTestId('step-card-frosted-overlay-implement');
    expect(overlay).toBeInTheDocument();
    // backdropFilter inline style — checked via raw style string since jsdom
    // does not compute vendor-prefixed CSS properties from inline style props.
    const overlayStyle = overlay.getAttribute('style') ?? '';
    expect(overlayStyle).toContain('backdrop-filter: blur(2px)');
    // -webkit-backdrop-filter is present in source (WebkitBackdropFilter prop);
    // jsdom serializes camelCase vendor prefix without the leading dash, so we
    // assert the source code convention via the component source rather than the
    // serialized attribute.  Confirm the standard backdrop-filter is set:
    expect(overlayStyle).toContain('pointer-events: none');

    // 30px green check circle
    const check = screen.getByTestId('step-card-check-implement');
    expect(check).toBeInTheDocument();
    expect(check).toHaveStyle({
      width: '30px',
      height: '30px',
      borderRadius: '50%',
    });
    expect(check).toHaveAttribute('aria-label', 'completed');
  });

  it('human variant: badge present with aria-label, amber border, striped head', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP_HUMAN}
        phase={MOCK_PHASE}
        stepIndex={5}
        status="running"
      />,
    );

    // Badge with aria-label "human step" positioned at top:-9px right:-9px
    const badge = screen.getByTestId('step-card-human-badge-human-review');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('aria-label', 'human step');
    expect(badge).toHaveStyle({
      position: 'absolute',
      top: '-9px',
      right: '-9px',
      width: '22px',
      height: '22px',
    });

    // Card root has amber border via status-warning CSS token — checked via
    // raw style attribute since jsdom does not resolve CSS custom properties.
    const card = screen.getByTestId('step-card-human-review');
    const cardStyle = card.getAttribute('style') ?? '';
    expect(cardStyle).toContain('var(--color-status-warning)');

    // Head bar has repeating-linear-gradient (striped pattern)
    const head = screen.getByTestId('step-card-head-human-review');
    expect(head.getAttribute('style')).toContain('repeating-linear-gradient');
  });

  it('optional variant: OPTIONAL chip visible in head bar', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP_OPTIONAL}
        phase={MOCK_PHASE}
        stepIndex={5}
        status="pending"
      />,
    );

    const chip = screen.getByTestId('step-card-optional-chip-visual-verify');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent('OPTIONAL');
  });

  it('head bar: shows uppercase phase abbreviation and 2-digit step index', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP}
        phase={MOCK_PHASE}
        stepIndex={7}
        status="pending"
      />,
    );

    const head = screen.getByTestId('step-card-head-implement');
    // Phase abbreviation: first 3 chars of "Execute" → "EXE"
    expect(head.textContent).toContain('EXE');
    // Step index zero-padded to 2 digits
    expect(head.textContent).toContain('07');
  });
});
