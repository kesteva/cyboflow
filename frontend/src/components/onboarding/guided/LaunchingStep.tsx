/**
 * Guided step 14 — "Launching your session now", the tour's terminal screen.
 * Every exit (Done / Open the session) reaches onboardingStore.finish() and
 * points the user back at Human review — the GuidedMarker on the Sidebar's
 * Human-review rail item (see Sidebar.tsx) pairs with the callout below.
 *
 * Status is read live off the same reactive stores the rail itself uses
 * (activeRunsStore for planner/ship, sessionStore for quick) — no polling of
 * its own.
 */
import { GuidedCallout, GuidedFooter, GuidedScreen } from './GuidedScreen';
import { GUIDED_TARGETS } from './GuidedLeader';
import { ONBOARDING_LAUNCHING_STEP } from '../../../utils/onboarding';
import type { LaunchedSession } from '../../../stores/onboardingStore';
import { useActiveRunsStore } from '../../../stores/activeRunsStore';
import { useSessionStore } from '../../../stores/sessionStore';

export interface LaunchingStepProps {
  projectId: number;
  projectName: string;
  launched: LaunchedSession;
  onStay: () => void;
  onOpenSession: () => void;
}

const KIND_LABEL: Record<LaunchedSession['kind'], string> = {
  planner: 'Planner',
  ship: 'Ship',
  quick: 'Quick session',
};

const STATUS_ROWS: Record<LaunchedSession['kind'], readonly string[]> = {
  planner: [
    '✓ Worktree created',
    'Agent starting…',
    'First stop: a plan to approve — lands in Human review',
  ],
  ship: [
    '✓ Worktree created',
    'Agent starting…',
    'First stop: a plan to approve — lands in Human review',
  ],
  quick: ['✓ Worktree created', 'Agent starting…', 'Chat or type commands — it’s yours'],
};

/** Live status for the launched run/session — falls back to 'starting'. */
function useLaunchedStatus(projectId: number, launched: LaunchedSession): string {
  const runsForProject = useActiveRunsStore((s) => s.runsByProject[projectId]);
  const sessionStatus = useSessionStore(
    (s) => s.sessions.find((sess) => sess.id === launched.sessionId)?.status,
  );

  if (launched.kind === 'quick') {
    return sessionStatus ?? 'starting';
  }
  const row = runsForProject?.find((r) => r.id === launched.runId);
  return row?.status ?? 'starting';
}

export function LaunchingStep({
  projectId,
  projectName,
  launched,
  onStay,
  onOpenSession,
}: LaunchingStepProps): React.JSX.Element {
  const status = useLaunchedStatus(projectId, launched);
  const rows = STATUS_ROWS[launched.kind];

  return (
    <GuidedScreen
      step={ONBOARDING_LAUNCHING_STEP}
      centered
      title="Launching your session now"
      intro={
        <>
          Once it’s going, come back here to see an overview of all your running agents. This is{' '}
          <strong className="font-semibold text-text-primary">Human review</strong> — every
          session lands here when it needs you: a plan to approve, a finding to triage, finished
          work to merge.
        </>
      }
      footer={
        <GuidedFooter
          secondaryLabel="Done — stay here"
          onSecondary={onStay}
          secondaryTestId="onboarding-launching-stay"
          primaryLabel="Open the session →"
          onPrimary={onOpenSession}
          primaryTestId="onboarding-launching-open"
        />
      }
    >
      <div className="flex flex-col gap-2">
        <GuidedCallout
          n={1}
          leaderTo={GUIDED_TARGETS.humanReview}
          title="Human review is your home screen"
          body="Everything waiting on you, what’s running, and what to start next — across every project."
        />

        <div className="mt-2 border border-border-primary bg-surface-primary px-[15px] py-[13px]">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold text-text-primary">
              {KIND_LABEL[launched.kind]} · {projectName}
            </span>
            <span className="text-[9px] font-bold uppercase tracking-[.14em] text-interactive">
              {status}
            </span>
          </div>
          <div className="mt-2 flex flex-col gap-1">
            {rows.map((row) => (
              <span key={row} className="text-[10px] text-text-tertiary">
                {row}
              </span>
            ))}
          </div>
        </div>
      </div>
    </GuidedScreen>
  );
}
