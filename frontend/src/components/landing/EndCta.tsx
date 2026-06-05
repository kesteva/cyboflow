/**
 * EndCta — the prominent "kick off more" block that closes the landing home.
 *
 * A bold dashed call-to-action that drops the user into the new-flow wizard
 * unlocked (no pinned project, no quick escape hatch) to start fresh work on
 * any project.
 */
import { Plus } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';

export interface EndCtaProps {
  /** Heading line. Defaults to "Want to kick off more?". */
  heading?: string;
}

/** EndCta — the closing call-to-action. See {@link EndCtaProps}. */
export function EndCta({ heading = 'Want to kick off more?' }: EndCtaProps) {
  return (
    <div className="px-7 py-6 font-mono">
      <div className="flex flex-col items-center gap-3 border-2 border-dashed border-border-primary bg-surface-secondary px-7 py-9 text-center">
        <h2 className="text-base font-bold tracking-tight text-text-primary">{heading}</h2>
        <p className="max-w-[420px] text-sm leading-relaxed text-text-secondary">
          Spin up a fresh agent on any project to start new work.
        </p>
        <button
          type="button"
          onClick={() => useNavigationStore.getState().goToWizard({})}
          className="mt-2 inline-flex items-center gap-2 bg-interactive px-5 py-3 text-sm font-bold uppercase tracking-wide text-text-on-interactive transition-colors hover:bg-interactive-hover"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          Start a new session
        </button>
      </div>
    </div>
  );
}
