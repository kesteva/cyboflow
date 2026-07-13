import { useRef, useState } from 'react';
import { GitMerge, ExternalLink, Trash2 } from 'lucide-react';
import { useLifecycleTarget } from '../../hooks/useLifecycleTarget';
import { trpc } from '../../trpc/client';
import { findGuardedExperimentForSession } from '../../utils/armDismissGuard';
import type { GuardedAction } from '../../utils/armDismissGuard';
import { experimentDisplayName } from '../../utils/experimentDisplay';
import { ArmDismissGuardDialog } from './ArmDismissGuardDialog';
import type { ExperimentArm, ExperimentRow, ExperimentStatus } from '../../../../shared/types/experiments';

interface SessionLifecycleActionBarProps {
  onMerge?: () => void;
  onCreatePR?: () => void;
  onDismiss?: () => void;
}

interface ArmGuardState {
  experimentId: string;
  arm: ExperimentArm;
  status: ExperimentStatus;
  experimentName?: string;
  /** Which lifecycle action triggered the guard — drives the dialog's copy/label. */
  action: GuardedAction;
  /** The original action's continuation, invoked once the user confirms. */
  proceed: () => void;
}

export function SessionLifecycleActionBar({ onMerge, onCreatePR, onDismiss }: SessionLifecycleActionBarProps) {
  const target = useLifecycleTarget();
  // Experiment-aware dismiss guard (S2). Held here so the interception lives on
  // the Dismiss trigger itself; null = no guard shown.
  const [armGuard, setArmGuard] = useState<ArmGuardState | null>(null);
  const [checkingArm, setCheckingArm] = useState(false);
  // Latest selected-session id, read INSIDE the async guard's continuation so a
  // selection change during the (async) arm-check window aborts the action
  // rather than firing it against whatever session is selected when the read
  // resolves. The close-out dialogs (SessionMergeDialog etc.) bind to the
  // CURRENT lifecycle target, so proceeding after a drift would act on the wrong
  // session — see runGuardedAction.
  const targetSessionIdRef = useRef<string | undefined>(target?.session.id);
  targetSessionIdRef.current = target?.session.id;
  if (!target) return null;

  // Merge / Create-PR accept the session's artifact. They are offered only once
  // the work is finished and awaiting the user's decision — a session still
  // `running` is in flight, so accept is disabled while running. (The run-scoped
  // close-out was removed in Phase 4a; the target is always a session now.)
  const acceptDisabled = target.session.status === 'running';

  // In-place sessions work directly in the project checkout — there is no
  // worktree to merge or open a PR from, so those accept actions are hidden.
  // Dismiss stays (it just closes the session), with copy that reflects the
  // checkout is left untouched.
  const inPlace = target.session.inPlace === true;

  const session = target.session;

  // Intercept Dismiss/Merge/Create-PR when the session is one arm of a LIVE A/B
  // experiment. Tearing down (or accepting) a single arm strands the experiment
  // undecided — merged/dismissed arm sessions drop out of the rail group (see
  // railExperimentGrouping.ts), losing the decide CTAs (promote/rerun/switch-to
  // -randomized) reachable only from the comparison view. So we prompt instead.
  // On ANY read failure (or a session with no project) we fall through to the
  // normal action: the action must never be BLOCKED by a failed guard read.
  const runGuardedAction = (action: GuardedAction, rawProceed: () => void) => {
    const projectId = session.projectId;
    // The close-out dialog opened by rawProceed reads the CURRENT lifecycle
    // target, not this click's session. The synchronous no-guard path below
    // fires before any selection change is possible, so it uses rawProceed
    // directly. Every DEFERRED path (after the async arm-check, or after the
    // guard dialog is confirmed) instead goes through this drift guard: if the
    // selection changed while we waited, abort silently — acting would merge/PR/
    // dismiss the wrong session. The user simply re-clicks on the intended one.
    const clickedSessionId = session.id;
    const proceed = () => {
      if (targetSessionIdRef.current === clickedSessionId) rawProceed();
    };
    if (projectId === undefined) {
      rawProceed();
      return;
    }
    // Initiate the read inside a synchronous try/catch: an unavailable/unwired
    // experiments route throws right here (not as a rejection), and that must
    // fall through to the normal action SYNCHRONOUSLY, same as a rejected read.
    let queryPromise: Promise<ExperimentRow[]>;
    try {
      queryPromise = trpc.cyboflow.experiments.listForProject.query({ projectId });
    } catch {
      // Synchronous failure — same tick as the click, no drift possible; fire the
      // raw action unconditionally (the "never block on a failed read" contract).
      rawProceed();
      return;
    }
    setCheckingArm(true);
    void queryPromise
      .then(async (experiments) => {
        const match = findGuardedExperimentForSession(session.id, experiments);
        if (!match) {
          proceed();
          return;
        }
        // Best-effort enrichment: resolve the experiment's display name from the
        // dashboard summaries (arm labels live there, not on ExperimentRow). Any
        // failure just drops the name — the guard works without it.
        let experimentName: string | undefined;
        try {
          const summaries = await trpc.cyboflow.experiments.listForDashboard.query({ projectId });
          const summary = summaries.find((s) => s.experimentId === match.experiment.id);
          if (summary) {
            experimentName = experimentDisplayName(
              summary.workflowId,
              { variantId: summary.variantAId, label: summary.armALabel },
              { variantId: summary.variantBId, label: summary.armBLabel },
            );
          }
        } catch {
          // Enrichment only; ignore.
        }
        setArmGuard({
          experimentId: match.experiment.id,
          arm: match.arm,
          status: match.experiment.status,
          experimentName,
          action,
          proceed,
        });
      })
      .catch(() => {
        // Never block the action on a failed read — proceed with the normal flow.
        proceed();
      })
      .finally(() => setCheckingArm(false));
  };

  const handleMergeClick = () => runGuardedAction('merge', () => onMerge?.());
  const handleCreatePRClick = () => runGuardedAction('create-pr', () => onCreatePR?.());
  const handleDismissClick = () => runGuardedAction('dismiss', () => onDismiss?.());

  return (
    <>
    <div className="flex items-center gap-1.5" data-testid="session-lifecycle-action-bar">
      <div className="mx-2 h-4 w-px bg-border-primary" />

      {!inPlace && (
        <button
          data-testid="session-action-merge"
          disabled={acceptDisabled || checkingArm}
          onClick={handleMergeClick}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          title={acceptDisabled ? 'Wait for the work to finish before merging' : 'Merge changes into base branch'}
        >
          <GitMerge size={14} />
          Merge
        </button>
      )}

      {!inPlace && (
        <button
          data-testid="session-action-create-pr"
          disabled={acceptDisabled || checkingArm}
          onClick={handleCreatePRClick}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          title={acceptDisabled ? 'Wait for the work to finish before creating a PR' : 'Create a pull request'}
        >
          <ExternalLink size={14} />
          Create PR
        </button>
      )}

      <button
        data-testid="session-action-dismiss"
        onClick={handleDismissClick}
        disabled={checkingArm}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-status-error disabled:cursor-not-allowed disabled:opacity-50"
        title={inPlace ? 'Close this session. Your project checkout is untouched.' : 'Dismiss this session and remove its worktree'}
      >
        <Trash2 size={14} />
        Dismiss
      </button>
    </div>

    {armGuard && (
      <ArmDismissGuardDialog
        isOpen
        onClose={() => setArmGuard(null)}
        experimentId={armGuard.experimentId}
        arm={armGuard.arm}
        status={armGuard.status}
        experimentName={armGuard.experimentName}
        action={armGuard.action}
        onConfirm={() => {
          // Proceed with the original action's continuation unchanged (act on
          // THIS arm only, leaving the other arm + experiment intact).
          const proceed = armGuard.proceed;
          setArmGuard(null);
          proceed();
        }}
      />
    )}
    </>
  );
}
