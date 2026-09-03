/**
 * GuidedMarker — the numbered terracotta chip the in-shell guided screens pin
 * onto a shell element (a Sidebar row, the Human-review rail item) to pair it
 * with the same-numbered {@link GuidedCallout} in the centre column. Renders
 * nothing unless the tour is active on `step`, so host components can mount it
 * unconditionally and forget about it.
 *
 * `useGuidedMarkActive` is the bare predicate for hosts that also want to ring
 * the element (an outline in the interactive colour).
 */
import { useOnboardingStore } from '../../../stores/onboardingStore';

export function useGuidedMarkActive(step: number): boolean {
  return useOnboardingStore((s) => s.hydrated && s.status === 'active' && s.step === step);
}

/** Inline style for the ringed shell element while its marker is showing. */
export const GUIDED_RING_STYLE: React.CSSProperties = {
  outline: '1.4px solid var(--color-interactive-primary)',
  outlineOffset: '2px',
};

export interface GuidedMarkerProps {
  /** Tour step the marker belongs to (renders only while the tour is on it). */
  step: number;
  n: number;
  testId?: string;
}

export function GuidedMarker({ step, n, testId }: GuidedMarkerProps): React.JSX.Element | null {
  const active = useGuidedMarkActive(step);
  if (!active) return null;
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className="ml-1.5 flex h-[17px] w-[17px] flex-shrink-0 items-center justify-center bg-interactive text-[9px] font-bold text-[var(--paper)]"
    >
      {n}
    </span>
  );
}
