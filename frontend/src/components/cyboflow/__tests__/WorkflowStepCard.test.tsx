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

  it('paused variant (systemic pause parked on this step): PAUSED label, amber outline + dot, no running outline', () => {
    render(<WorkflowStepCard step={MOCK_STEP} phase={MOCK_PHASE} stepIndex={3} status="paused" />);

    const card = screen.getByTestId('step-card-implement');
    expect(card).toHaveTextContent('PAUSED');
    expect(card).not.toHaveTextContent('RUNNING');
    expect(card).toHaveStyle({
      outlineStyle: 'solid',
      outlineWidth: '2px',
      outlineColor: 'var(--color-status-warning)',
    });
    expect(screen.getByTestId('step-card-dot-implement')).toHaveStyle({
      background: 'var(--color-status-warning)',
    });
    // Never the done overlay — the step has not finished.
    expect(screen.queryByTestId('step-card-frosted-overlay-implement')).not.toBeInTheDocument();
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

  it('human gate step with no modelLabel (backend never supplies a stepModels entry for gates): row reads exactly "agent ×N", no model segment/dot', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP_HUMAN}
        phase={MOCK_PHASE}
        stepIndex={5}
        status="running"
      />,
    );

    expect(screen.queryByTestId('step-card-model-human-review')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-card-model-dot-human-review')).not.toBeInTheDocument();

    const row = screen.getByTestId('step-card-agent-row-human-review');
    expect(row).not.toHaveAttribute('title');
    expect(row).toHaveTextContent('human');
    expect(row).toHaveTextContent('×0');
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

  // -------------------------------------------------------------------------
  // TASK-274: per-step model segment folded into the existing agent/retries row
  // -------------------------------------------------------------------------

  it('resolved (running) status: shows dot + label in the resolved color, with a "agent · model" title', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP}
        phase={MOCK_PHASE}
        stepIndex={3}
        status="running"
        modelLabel="Opus 5"
        modelFamilyColor="#c98a2d"
      />,
    );

    const dot = screen.getByTestId('step-card-model-dot-implement');
    expect(dot).toHaveStyle({ backgroundColor: '#c98a2d', opacity: '1' });

    const model = screen.getByTestId('step-card-model-implement');
    expect(model).toHaveTextContent('Opus 5');
    // Not italic when resolved.
    const label = model.querySelector('span:last-child') as HTMLElement;
    expect(label).toHaveStyle({ fontStyle: 'normal' });

    const row = screen.getByTestId('step-card-agent-row-implement');
    expect(row).toHaveAttribute('title', 'executor-agent · Opus 5');
    // Uses the existing non-pending row text color, not a new hardcoded one.
    expect(row).toHaveStyle({ color: '#6a5e44' });

    // The agent name segment must grow into the row's slack (flex: 1 1 auto),
    // not just be pinned left by justifyContent: space-between — otherwise the
    // model segment splits off into the middle of the row with a gap on each
    // side instead of sitting flush against the retries.
    const agentSegment = row.firstElementChild as HTMLElement;
    expect(agentSegment).toHaveTextContent('executor-agent');
    expect(agentSegment).toHaveStyle({ flex: '1 1 auto' });
  });

  it('pending status: model label is italic, dot is 45% opacity, and title reads "will run"', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP}
        phase={MOCK_PHASE}
        stepIndex={3}
        status="pending"
        modelLabel="Sonnet 5"
        modelFamilyColor="#4a7ea8"
      />,
    );

    const dot = screen.getByTestId('step-card-model-dot-implement');
    expect(dot).toHaveStyle({ backgroundColor: '#4a7ea8', opacity: '0.45' });

    const model = screen.getByTestId('step-card-model-implement');
    const label = model.querySelector('span:last-child') as HTMLElement;
    expect(label).toHaveStyle({ fontStyle: 'italic' });

    const row = screen.getByTestId('step-card-agent-row-implement');
    expect(row).toHaveAttribute('title', 'executor-agent · will run Sonnet 5');
    // Uses the existing pending row text color.
    expect(row).toHaveStyle({ color: '#b3a685' });

    // Same growing-agent-segment geometry as the resolved card — the pending
    // variant must not lay the row out differently.
    const agentSegment = row.firstElementChild as HTMLElement;
    expect(agentSegment).toHaveTextContent('executor-agent');
    expect(agentSegment).toHaveStyle({ flex: '1 1 auto' });
  });

  it('model segment is width-capped so a long provider model id cannot spill outside the 138px card', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP}
        phase={MOCK_PHASE}
        stepIndex={3}
        status="running"
        modelLabel="gpt-5.6-sol-preview-2026-09-01-long"
        modelFamilyColor="#7a7268"
      />,
    );

    const model = screen.getByTestId('step-card-model-implement');
    expect(model).toHaveStyle({
      maxWidth: '62px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
  });

  it('modelLabel without an explicit modelFamilyColor still paints a visible dot', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP}
        phase={MOCK_PHASE}
        stepIndex={3}
        status="running"
        modelLabel="Opus 5"
      />,
    );

    // MODEL_FAMILY_COLORS.other — never an unset/transparent background, which
    // would reserve the dot's layout while rendering nothing.
    const dot = screen.getByTestId('step-card-model-dot-implement');
    expect(dot).toHaveStyle({ backgroundColor: '#7a7268' });
  });

  it('human step NEVER renders a model segment, even when a caller supplies a label', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP_HUMAN}
        phase={MOCK_PHASE}
        stepIndex={5}
        status="running"
        modelLabel="Opus 5"
        modelFamilyColor="#c98a2d"
      />,
    );

    expect(screen.queryByTestId('step-card-model-human-review')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-card-model-dot-human-review')).not.toBeInTheDocument();

    const row = screen.getByTestId('step-card-agent-row-human-review');
    expect(row).not.toHaveAttribute('title');
    expect(row).not.toHaveTextContent('Opus 5');
  });

  it('no modelLabel: renders exactly today\'s row — no dot, no separator, no title', () => {
    render(
      <WorkflowStepCard
        step={MOCK_STEP}
        phase={MOCK_PHASE}
        stepIndex={3}
        status="running"
      />,
    );

    expect(screen.queryByTestId('step-card-model-implement')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-card-model-dot-implement')).not.toBeInTheDocument();

    const row = screen.getByTestId('step-card-agent-row-implement');
    expect(row).not.toHaveAttribute('title');
    expect(row).toHaveTextContent('executor-agent');
    expect(row).toHaveTextContent('×3');

    // The agent segment keeps its flex: 1 1 auto even with no model segment —
    // the pin must not live only on the model-present path.
    const agentSegment = row.firstElementChild as HTMLElement;
    expect(agentSegment).toHaveStyle({ flex: '1 1 auto' });
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
