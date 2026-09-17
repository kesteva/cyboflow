/**
 * TuningLevelSelector — isolated component tests (no wizard/tRPC scaffolding).
 *
 * Verifies:
 *   (a) the selected segment is the only marker of the saved default (no tag,
 *       no override caption — a divergent pick surfaces through the parent's
 *       shared "Save as default" CTA instead);
 *   (b) picking a segment reports it via onChange;
 *   (c) Custom is disabled with a hint while the slot is empty, selectable once filled;
 *   (d) — removed: migration 126 scoped variants to a level, so a pinned variant
 *       no longer contradicts a level pick and the control has no disabled state.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TuningLevelSelector } from '../TuningLevelSelector';

describe('TuningLevelSelector', () => {
  it('(a) selects the saved level and shows no override caption when value === savedLevel', () => {
    render(
      <TuningLevelSelector
        value="standard"
        customSlotAvailable={false}
        onChange={vi.fn()}
      />,
    );
    // The selection alone marks the saved default — no extra tag text.
    expect(screen.getByTestId('wizard-tuning-level-standard')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.queryByText(/saved default/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('wizard-tuning-level-override-note')).not.toBeInTheDocument();
  });

  it('(b) clicking a segment reports it and renders NO override caption', () => {
    const onChange = vi.fn();
    render(
      <TuningLevelSelector
        value="standard"
        customSlotAvailable={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-tuning-level-thorough'));
    expect(onChange).toHaveBeenCalledWith('thorough');

    // Re-render as the parent would after applying the pick: the divergence
    // surfaces through the parent's "Save as default" CTA, never a caption here.
    render(
      <TuningLevelSelector
        value="thorough"
        customSlotAvailable={false}
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId('wizard-tuning-level-override-note')).not.toBeInTheDocument();
  });

  it('(c) Custom is disabled with a hint while the slot is empty, and clickable once filled', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TuningLevelSelector
        value="standard"
        customSlotAvailable={false}
        onChange={onChange}
      />,
    );
    const customBtn = screen.getByTestId('wizard-tuning-level-custom');
    expect(customBtn).toBeDisabled();
    fireEvent.click(customBtn);
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <TuningLevelSelector
        value="standard"
        customSlotAvailable
        onChange={onChange}
      />,
    );
    const enabledCustomBtn = screen.getByTestId('wizard-tuning-level-custom');
    expect(enabledCustomBtn).not.toBeDisabled();
    fireEvent.click(enabledCustomBtn);
    expect(onChange).toHaveBeenCalledWith('custom');
  });

  it('(e) renders no estimate lines and no caption when estimateLabels is omitted', () => {
    render(
      <TuningLevelSelector
        value="standard"
        customSlotAvailable={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('wizard-tuning-estimate-caption')).not.toBeInTheDocument();
  });

  it('(f) renders a per-segment estimate line for whichever level(s) supply one, plus the excl.-eval caption', () => {
    render(
      <TuningLevelSelector
        value="standard"
        customSlotAvailable={false}
        onChange={vi.fn()}
        estimateLabels={{ efficient: '~150k', standard: '~300k' }}
      />,
    );
    expect(screen.getByTestId('wizard-tuning-level-efficient')).toHaveTextContent('~150k');
    expect(screen.getByTestId('wizard-tuning-level-standard')).toHaveTextContent('~300k');
    expect(screen.getByTestId('wizard-tuning-level-thorough')).not.toHaveTextContent('~');
    expect(screen.getByTestId('wizard-tuning-estimate-caption')).toHaveTextContent(/excl\. eval/i);
  });

  it('(g) renders no caption for an empty estimateLabels object', () => {
    render(
      <TuningLevelSelector
        value="standard"
        customSlotAvailable={false}
        onChange={vi.fn()}
        estimateLabels={{}}
      />,
    );
    expect(screen.queryByTestId('wizard-tuning-estimate-caption')).not.toBeInTheDocument();
  });

  it('(i) renders no stamp hint by default', () => {
    render(<TuningLevelSelector value="standard" customSlotAvailable={false} onChange={vi.fn()} />);
    expect(screen.queryByTestId('wizard-tuning-level-stamp-hint')).not.toBeInTheDocument();
  });

  it('(j) renders the stamp hint verbatim when supplied', () => {
    render(
      <TuningLevelSelector
        value="standard"
        customSlotAvailable={false}
        onChange={vi.fn()}
        stampHint="Defaulted from project thoroughness: v1 → standard"
      />,
    );
    expect(screen.getByTestId('wizard-tuning-level-stamp-hint')).toHaveTextContent(
      'Defaulted from project thoroughness: v1 → standard',
    );
  });

  it('(h) renders a per-level helper sentence that tracks the selected level', () => {
    const { rerender } = render(
      <TuningLevelSelector
        value="standard"
        customSlotAvailable={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('wizard-tuning-level-desc')).toHaveTextContent(/aligned defaults/i);

    rerender(
      <TuningLevelSelector
        value="efficient"
        customSlotAvailable={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('wizard-tuning-level-desc')).toHaveTextContent(/cheaper models/i);

    rerender(
      <TuningLevelSelector
        value="thorough"
        customSlotAvailable={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('wizard-tuning-level-desc')).toHaveTextContent(/strongest models/i);
  });
});
