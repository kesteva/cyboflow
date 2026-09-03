/**
 * GuidedLeader — the dashed curved arrow from a callout chip to a shell
 * element. jsdom has no layout, so both boxes are stubbed via
 * getBoundingClientRect and the rAF measuring loop is driven by fake timers.
 */
import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuidedCallout } from './GuidedScreen';
import { GUIDED_TARGETS } from './GuidedLeader';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height,
    right: left + width, bottom: top + height, x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
    (cb) => window.setTimeout(() => cb(0), 16),
  );
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GuidedLeader', () => {
  it('draws the design curve from the chip to the target once both have geometry', () => {
    render(
      <>
        <button type="button" data-guided-target={GUIDED_TARGETS.addProject} data-testid="target" />
        <GuidedCallout n={1} title="t" body="b" testId="callout" leaderTo={GUIDED_TARGETS.addProject} />
      </>,
    );
    // Nothing until measured.
    expect(screen.queryByTestId('callout-leader')).toBeNull();

    const chip = screen.getByTestId('callout').firstElementChild as HTMLElement;
    vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue(rect(410, 364, 17, 17));
    vi.spyOn(screen.getByTestId('target'), 'getBoundingClientRect').mockReturnValue(rect(180, 610, 120, 40));

    act(() => {
      vi.advanceTimersByTime(20);
    });

    const svg = screen.getByTestId('callout-leader');
    expect(svg.tagName.toLowerCase()).toBe('svg');
    // Source = 4px left of the chip's left edge at its vertical middle (406, 372.5);
    // target = 6px right of the button's right edge at its middle (306, 630).
    expect(svg.querySelector('path[stroke-dasharray]')?.getAttribute('d')).toBe(
      'M 406 372.5 C 356 372.5, 351 630, 306 630',
    );
    expect(svg.querySelector('marker path')).not.toBeNull();
  });

  it('renders nothing when the target is absent', () => {
    render(<GuidedCallout n={1} title="t" body="b" testId="callout" leaderTo={GUIDED_TARGETS.humanReview} />);
    const chip = screen.getByTestId('callout').firstElementChild as HTMLElement;
    vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue(rect(410, 364, 17, 17));
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(screen.queryByTestId('callout-leader')).toBeNull();
  });
});
