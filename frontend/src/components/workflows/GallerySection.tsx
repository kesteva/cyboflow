/**
 * GallerySection — a titled section of the stacked Workflows gallery.
 *
 * Renders a section header (title + a COUNT PILL + an optional subtitle + an
 * optional trailing action slot) over a responsive card grid. Mirrors the
 * `.GB-sec` / `.GB-sechead` blocks of the design reference's `GalleryStacked`,
 * re-created with the repo's semantic tokens.
 *
 * The `count` shown in the pill is the GRID ITEM COUNT EXCLUDING the dashed
 * "+ New" card — callers pass `entries.length`, never `entries.length + 1`. The
 * caller is responsible for appending the New card into `children` after the
 * real cards; the pill must NOT include it.
 */
import type { ReactNode } from 'react';

export interface GallerySectionProps {
  /** Section title (e.g. "Workflows" / "Agents"). */
  title: string;
  /** Item count for the pill — EXCLUDING the dashed New card. */
  count: number;
  /** One-line subtitle beside the title. */
  subtitle?: string;
  /** Optional trailing header action (e.g. a top-level "New" button). */
  action?: ReactNode;
  /** Grid items — the real cards plus (optionally) the trailing New card. */
  children: ReactNode;
  /** Tailwind grid column count utility; defaults to 3-up. */
  gridClassName?: string;
  /** Test id for the section root. */
  'data-testid'?: string;
}

/** GallerySection — see the file header. */
export function GallerySection({
  title,
  count,
  subtitle,
  action,
  children,
  gridClassName = 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  'data-testid': testId,
}: GallerySectionProps): React.JSX.Element {
  return (
    <section className="px-6 pt-6" data-testid={testId}>
      <div className="mb-4 flex items-center gap-3 border-b border-border-primary pb-3">
        <h3 className="flex items-center gap-2 text-[17px] font-bold tracking-[-0.01em] text-text-primary">
          {title}
          <span
            className="rounded-badge border border-border-primary bg-bg-secondary px-1.5 py-px text-[9px] font-bold text-text-tertiary"
            data-testid={testId !== undefined ? `${testId}-count` : undefined}
          >
            {count}
          </span>
        </h3>
        {subtitle !== undefined && (
          <span className="truncate text-[10.5px] tracking-[0.01em] text-text-secondary">
            {subtitle}
          </span>
        )}
        <span className="flex-1" />
        {action}
      </div>
      <div className={`grid gap-3.5 ${gridClassName}`}>{children}</div>
    </section>
  );
}
