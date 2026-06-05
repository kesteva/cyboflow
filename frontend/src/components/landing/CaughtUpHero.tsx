/**
 * CaughtUpHero — the "caught up · all idle" home hero (home state 3).
 *
 * Rendered when projects exist, nothing is waiting in the review queue, and no
 * run is active. A centered warm-paper card with a green hazard-stripe tab,
 * a check glyph, activity pills (working / idle counts), the idle-project start
 * list, and the end CTA.
 *
 * Self-contained: reads the aggregated runs + projects directly from
 * {@link landingStore}; no props.
 */
import { useMemo } from 'react';
import { Check } from 'lucide-react';
import { useAggregatedRuns, useLandingProjects } from '../../stores/landingStore';
import { classifyRun } from '../../utils/homeClassify';
import { IdleStartList } from './IdleStartList';
import { EndCta } from './EndCta';

export function CaughtUpHero(): React.JSX.Element {
  const runs = useAggregatedRuns();
  const projects = useLandingProjects();

  // Working = aggregated runs currently classified as active.
  const workingCount = useMemo(
    () => runs.filter((run) => classifyRun(run.status) === 'active').length,
    [runs],
  );

  // Idle = projects with no active/blocked run. A project is "busy" if any of
  // its runs is active OR blocked; everything else counts as idle.
  const idleCount = useMemo(() => {
    const busyProjectIds = new Set<number>();
    for (const run of runs) {
      const activity = classifyRun(run.status);
      if (activity === 'active' || activity === 'blocked') {
        busyProjectIds.add(run.project_id);
      }
    }
    return projects.filter((project) => !busyProjectIds.has(project.id)).length;
  }, [runs, projects]);

  return (
    <div className="mx-auto w-full max-w-[560px] border border-border-primary bg-surface-primary">
      {/* Green hazard-stripe tab */}
      <div
        className="h-2 w-full"
        style={{
          backgroundImage:
            'repeating-linear-gradient(135deg, #2d8a5b 0 8px, #26764e 8px 16px)',
        }}
      />

      <div className="flex flex-col items-center px-8 py-8 text-center">
        {/* Green-bordered check glyph */}
        <div className="flex h-[50px] w-[50px] items-center justify-center border border-status-success">
          <Check className="h-6 w-6 text-status-success" strokeWidth={2.5} />
        </div>

        <p className="eyebrow mt-5 text-text-tertiary">REVIEW QUEUE EMPTY</p>

        <h2 className="mt-2 text-[22px] font-bold leading-tight text-text-primary">
          You&apos;re all caught up
        </h2>

        <p className="mt-2 max-w-[420px] text-sm text-text-secondary">
          Nothing is waiting on you, and every agent is idle. Start a session to
          put one to work.
        </p>

        {/* Activity pills */}
        <div className="mt-5 flex items-center justify-center gap-3">
          <span className="eyebrow inline-flex items-center gap-1.5 border border-border-primary px-2.5 py-1 text-text-secondary">
            <span className="h-1.5 w-1.5 rounded-full bg-interactive animate-pulse motion-reduce:animate-none" />
            {workingCount} WORKING
          </span>
          <span className="eyebrow inline-flex items-center gap-1.5 border border-border-primary px-2.5 py-1 text-text-tertiary">
            <span className="h-1.5 w-1.5 rounded-full bg-text-muted" />
            {idleCount} IDLE
          </span>
        </div>

        {/* Dashed divider */}
        <div className="my-6 w-full border-t border-dashed border-border-primary" />

        <div className="w-full">
          <IdleStartList />
        </div>

        <div className="mt-6 w-full">
          <EndCta heading="Cleared the queue?" />
        </div>
      </div>
    </div>
  );
}
