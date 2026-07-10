import { createPortal } from 'react-dom';

/**
 * Portal host for the onboarding surfaces. Mirrors ui/Modal's document.body
 * portal so the overlay escapes ancestor stacking/overflow contexts, and sits at
 * the popover tier (above app modals). The container is pointer-events-none: the
 * modal card and each coach scrim rect opt back in with pointer-events-auto,
 * which lets a coachmark's transparent hole pass clicks through to the real
 * target beneath.
 */
export function OnboardingOverlay({ children }: { children: React.ReactNode }): React.JSX.Element {
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-popover">{children}</div>,
    document.body,
  );
}
