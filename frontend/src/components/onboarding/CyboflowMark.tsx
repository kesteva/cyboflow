/**
 * The Cyboflow mark as an inline SVG drawn in `currentColor` — outlined
 * square, terminal chevron, cursor dash — for the terracotta onboarding
 * surfaces. The shipped `cyboflow-logo.svg` is a WHITE-filled square with a
 * terracotta chevron; recolouring it for a dark ground with a CSS filter
 * (`brightness(0) invert(1)`) turns the strokes white too, so the chevron
 * disappears into the fill and the mark reads as a blank square. Drawing it
 * inline sidesteps that: the colour comes from the surrounding `color`, and
 * the square is an outline rather than a fill.
 */
export function CyboflowMark({
  size,
  className,
}: {
  size: number;
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <rect x="3" y="3" width="42" height="42" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path
        d="M16 16 L28 24 L16 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <rect x="30" y="30" width="6" height="2.2" fill="currentColor" />
    </svg>
  );
}
