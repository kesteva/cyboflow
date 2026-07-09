import { useState } from 'react';
import { GitMerge, ExternalLink, Trash2 } from 'lucide-react';
import { useLifecycleTarget } from '../../hooks/useLifecycleTarget';
import { trpc } from '../../trpc/client';
import { findGuardedExperimentForSession } from '../../utils/armDismissGuard';
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
}

export function SessionLifecycleActionBar({ onMerge, onCreatePR, onDismiss }: SessionLifecycleActionBarProps) {
  const target = useLifecycleTarget();
  // Experiment-aware dismiss guard (S2). Held here so the interception lives on
  // the Dismiss trigger itself; null = no guard shown.
  const [armGuard, setArmGuard] = useState<ArmGuardState | null>(null);
  const [checkingArm, setCheckingArm] = useState(false);
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

  // Intercept Dismiss when the session is one arm of a LIVE A/B experiment.
  // Tearing down a single arm strands the experiment in 'grading' with an
  // unresolvable blocking review item — so we prompt instead. On ANY read
  // failure (or a session with no project) we fall through to the normal dismiss
  // flow: dismissal must never be BLOCKED by a failed guard read.
  const handleDismissClick = () => {
    const projectId = session.projectId;
    if (projectId === undefined) {
      onDismiss?.();
      return;
    }
    // Initiate the read inside a synchronous try/catch: an unavailable/unwired
    // experiments route throws right here (not as a rejection), and that must
    // fall through to the normal dismiss SYNCHRONOUSLY, same as a rejected read.
    let queryPromise: Promise<ExperimentRow[]>;
    try {
      queryPromise = trpc.cyboflow.experiments.listForProject.query({ projectId });
    } catch {
      onDismiss?.();
      return;
    }
    setCheckingArm(true);
    void queryPromise
      .then(async (experiments) => {
        const match = findGuardedExperimentForSession(session.id, experiments);
        if (!match) {
          onDismiss?.();
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
        });
      })
      .catch(() => {
        // Never block dismissal on a failed read — proceed with the normal flow.
        onDismiss?.();
      })
      .finally(() => setCheckingArm(false));
  };

  return (
    <>
    <div className="flex items-center gap-1.5" data-testid="session-lifecycle-action-bar">
      <div className="mx-2 h-4 w-px bg-border-primary" />

      {!inPlace && (
        <button
          data-testid="session-action-merge"
          disabled={acceptDisabled}
          onClick={onMerge}
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
          disabled={acceptDisabled}
          onClick={onCreatePR}
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
        onDismissArm={() => {
          // Proceed with the existing dismiss path unchanged (dismiss THIS arm).
          setArmGuard(null);
          onDismiss?.();
        }}
      />
    )}
    </>
  );
}
