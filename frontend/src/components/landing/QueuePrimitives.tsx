/**
 * QueuePrimitives — the small shared building blocks every Human-Review-Queue
 * section is made of: section headers, count pills, the three button weights,
 * the dashed expand/collapse row, tag chips, and the dashed empty well.
 *
 * They exist so the seven section components don't each re-spell the same
 * paddings and token classes. Everything here is presentational and prop-driven;
 * no store reads, no navigation.
 *
 * ## Colors
 *
 * Semantic tokens only. Two exceptions carry a CSS custom property through an
 * inline style because the value is a design primitive with no Tailwind class:
 *   - the Recommended-actions header dot (`--color-human`, the app's
 *     human-checkpoint amber), and
 *   - the Backlog header dot / funnel bars, whose colors come from the board's
 *     own `BoardStage.color_oklch` data (see BacklogSection).
 * Both are token references, not raw hex, so all three themes still resolve.
 */
import React from 'react';

// ---------------------------------------------------------------------------
// Section chrome
// ---------------------------------------------------------------------------

export interface SectionHeaderProps {
  /** Tailwind background class for the 8px dot (e.g. `bg-status-error`). */
  dotClass?: string;
  /** Inline background for the dot when the color is data-driven (stage colors, `--color-human`). */
  dotColor?: string;
  title: string;
  /** Rendered as a pill next to the title. Omit to hide the pill entirely. */
  count?: number;
  /** Muted trailing sentence ("Finished — review, merge, or wrap up"). */
  subtitle?: string;
  /** True when the count should read as "nothing here" (muted rather than secondary). */
  countMuted?: boolean;
}

/** The dot + title + count-pill + subtitle band that opens every queue section. */
export function SectionHeader({
  dotClass,
  dotColor,
  title,
  count,
  subtitle,
  countMuted = false,
}: SectionHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${dotClass ?? ''}`}
        style={dotColor !== undefined ? { background: dotColor } : undefined}
      />
      <span className="text-[13px] font-bold text-text-primary">{title}</span>
      {count !== undefined && <CountPill value={count} muted={countMuted} />}
      {subtitle !== undefined && (
        <span className="truncate text-[11px] text-text-tertiary">{subtitle}</span>
      )}
    </div>
  );
}

/** Rounded count pill on the sunken paper fill. */
export function CountPill({ value, muted = false }: { value: number; muted?: boolean }): React.JSX.Element {
  return (
    <span
      className={`shrink-0 rounded-full bg-surface-sunken px-2 text-[10px] leading-4 tabular-nums ${
        muted ? 'text-text-tertiary' : 'text-text-secondary'
      }`}
    >
      {value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Buttons — three weights, matching the design's CTA hierarchy
// ---------------------------------------------------------------------------

type ButtonProps = {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  'data-testid'?: string;
};

/** Accent-filled CTA — the forward action on a card or row. */
export function PrimaryButton({
  children,
  onClick,
  disabled = false,
  title,
  className = '',
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={rest['data-testid']}
      className={`shrink-0 border border-interactive-hover bg-interactive px-3 py-[3px] text-[11px] font-semibold text-text-on-interactive shadow-tactile transition-colors hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

/** Bordered-white CTA — the secondary action next to (or instead of) a primary. */
export function SecondaryButton({
  children,
  onClick,
  disabled = false,
  title,
  className = '',
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={rest['data-testid']}
      className={`shrink-0 border border-border-primary bg-surface-primary px-3 py-[3px] text-[11px] font-semibold text-text-primary transition-colors hover:border-border-hover disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

/** Unboxed muted text action — "Dismiss", "Clear", "Details ▸". */
export function GhostButton({
  children,
  onClick,
  disabled = false,
  title,
  className = '',
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={rest['data-testid']}
      className={`shrink-0 text-[10px] text-text-tertiary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * The prominent uppercase CTA used inside empty-state wells ("START A SESSION",
 * "BROWSE FOR A FOLDER") — heavier padding and letter-spacing than the inline
 * card buttons above.
 */
export function ProminentButton({
  children,
  onClick,
  disabled = false,
  variant = 'accent',
  ...rest
}: ButtonProps & { variant?: 'accent' | 'bordered' }): React.JSX.Element {
  const skin =
    variant === 'accent'
      ? 'border-interactive-hover bg-interactive text-text-on-interactive shadow-tactile hover:bg-interactive-hover'
      : 'border-border-primary bg-surface-primary text-text-primary hover:border-border-hover';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={rest['data-testid']}
      className={`mt-2 border px-[18px] py-[7px] text-[11px] font-bold uppercase tracking-[0.08em] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${skin}`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Rows, chips, wells
// ---------------------------------------------------------------------------

/** Full-width dashed row used for "View N more ▾" / "Collapse to 3 ▴" toggles. */
export function DashedToggle({
  children,
  onClick,
  compact = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  /** Tighter padding + smaller type, for the backlog columns. */
  compact?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full border border-dashed border-border-primary text-center text-text-secondary transition-colors hover:border-border-hover ${
        compact ? 'py-1 text-[10px]' : 'py-[5px] text-[11px]'
      }`}
    >
      {children}
    </button>
  );
}

/** Small squared-off tag — project name, priority, scope. */
export function Chip({
  children,
  tone = 'neutral',
  title,
  noTruncate = false,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'error';
  title?: string;
  /** Wrap long text instead of truncating it (capability chips must show their whole label). */
  noTruncate?: boolean;
}): React.JSX.Element {
  const skin =
    tone === 'success'
      ? 'border-status-success/40 bg-status-success/10 text-status-success'
      : tone === 'warning'
        ? 'border-status-warning/50 bg-status-warning/10 text-status-warning'
        : tone === 'error'
          ? 'border-status-error/40 bg-status-error/10 text-status-error'
          : 'border-border-primary bg-surface-tertiary text-text-tertiary';
  return (
    <span
      title={title}
      className={`shrink-0 border px-[5px] text-[9px] font-bold leading-[15px] ${
        noTruncate ? 'max-w-full whitespace-normal break-words' : 'truncate'
      } ${skin}`}
    >
      {children}
    </span>
  );
}

/** Rounded outline pill — "3 in flow", "2 awaiting review", "Running". */
export function OutlinePill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'warning';
}): React.JSX.Element {
  const skin =
    tone === 'accent'
      ? 'border-interactive bg-interactive/10 text-interactive'
      : tone === 'warning'
        ? 'border-status-warning bg-status-warning/10 text-status-warning'
        : 'border-border-primary text-text-secondary';
  return (
    <span className={`shrink-0 rounded-full border px-2 text-[10px] leading-4 ${skin}`}>
      {children}
    </span>
  );
}

/**
 * Dashed centered well used by every empty/bootstrap state: an icon, a bold
 * headline, a muted sentence, and an optional prominent CTA.
 */
export function EmptyWell({
  icon,
  title,
  body,
  action,
  tone = 'neutral',
  className = '',
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
  /** `success` paints the headline green (the "All caught up" well). */
  tone?: 'neutral' | 'success';
  className?: string;
  testId?: string;
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className={`flex flex-col items-center gap-1.5 border border-dashed border-border-primary bg-surface-raised px-[18px] py-[30px] text-center ${className}`}
    >
      {icon}
      <div
        className={`text-[14px] font-bold ${tone === 'success' ? 'text-status-success' : 'text-text-primary'}`}
      >
        {title}
      </div>
      {body !== undefined && (
        <div className="max-w-[420px] text-[11px] leading-relaxed text-text-tertiary">{body}</div>
      )}
      {action}
    </div>
  );
}

/** Thin dashed one-liner standing in for an empty section ("No agents running."). */
export function EmptyStrip({ children, testId }: { children: React.ReactNode; testId?: string }): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className="border border-dashed border-border-primary bg-surface-raised px-[18px] py-3.5 text-center text-[11px] text-text-tertiary"
    >
      {children}
    </div>
  );
}
