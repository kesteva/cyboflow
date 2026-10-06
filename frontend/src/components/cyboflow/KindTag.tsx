/**
 * KindTag — the shared kind badge for the System view. Kind (worktree vs
 * process) is encoded by hue AND shape so it survives both themes and colour-
 * vision deficiency: worktree = folder glyph, info hue, square tile (a place on
 * disk); process = chip glyph, compound/violet hue, round tile (a running
 * thing). Every call site uses this one component so hue + shape stay locked
 * together (design IDEA-037, "Kind vs state").
 *
 * `variant="badge"` (default) is the labelled pill; `variant="tile"` is the
 * icon-only leading tile used at the head of a card.
 */
import { Folder, Cpu } from 'lucide-react';

export type SystemKind = 'worktree' | 'process';

export interface KindTagProps {
  kind: SystemKind;
  variant?: 'badge' | 'tile';
  className?: string;
}

const KIND_META: Record<SystemKind, { label: string; title: string; hue: string; tileShape: string }> = {
  worktree: {
    label: 'Worktree',
    title: 'Worktree — a directory on disk',
    hue: 'border-status-info/45 bg-status-info/10 text-status-info',
    tileShape: 'rounded-card',
  },
  process: {
    label: 'Process',
    title: 'Process — a running PID',
    hue:
      'border-[color-mix(in_srgb,var(--color-phase-compound)_50%,transparent)] ' +
      'bg-[color-mix(in_srgb,var(--color-phase-compound)_12%,transparent)] ' +
      'text-[var(--color-phase-compound)]',
    tileShape: 'rounded-full',
  },
};

export function KindTag({ kind, variant = 'badge', className = '' }: KindTagProps) {
  const meta = KIND_META[kind];
  const Icon = kind === 'worktree' ? Folder : Cpu;

  if (variant === 'tile') {
    return (
      <span
        title={meta.title}
        data-kind={kind}
        data-testid={`kind-tile-${kind}`}
        className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center border ${meta.tileShape} ${meta.hue} ${className}`}
      >
        <Icon className="h-[17px] w-[17px]" aria-hidden="true" />
      </span>
    );
  }

  return (
    <span
      data-kind={kind}
      data-testid={`kind-badge-${kind}`}
      className={`eyebrow inline-flex items-center rounded-button border px-1.5 py-0.5 text-[10px] font-medium ${meta.hue} ${className}`}
    >
      {meta.label}
    </span>
  );
}
