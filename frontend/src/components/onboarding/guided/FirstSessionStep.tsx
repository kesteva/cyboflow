/**
 * Guided step 13 — "Launch your first session". The tour's last active
 * choice: Planner, Ship, or a plain Quick session, optionally seeded with
 * backlog ideas the guided set-up (or the assistant) already added for this
 * project. Every option launches into a FRESH worktree-backed session (see
 * ensureSessionForLaunch's forceNew), and every exit — a successful launch or
 * "Finish without launching" — is handed back to the parent (guidedFinish.ts
 * owns the shell/navigation side effects; this component owns only the pick +
 * launch UI).
 *
 * Planner/Ship launches go through `launchFirstFlow` (pure async, testable in
 * isolation); Quick sessions go through `useQuickSession` directly — it is a
 * hook (its `isStarting`/`error` state needs component lifecycle), so it
 * cannot live in the same module as the other two. `useQuickSession` takes
 * `projectId` as an explicit option, so this screen always targets the
 * guided-set-up's own project regardless of whatever session/project the rest
 * of the app has selected.
 */
import { useMemo, useState } from 'react';
import { GuidedFooter, GuidedScreen } from './GuidedScreen';
import { launchFirstFlow, MAX_PLANNER_SEED_IDEAS } from './launchFirstSession';
import { SESSION_CHOICES } from './sessionChoices';
import {
  useOnboardingStore,
  type GuidedProject,
  type LaunchedSession,
  type SessionChoice,
} from '../../../stores/onboardingStore';
import { useBacklogStore } from '../../../stores/backlogStore';
import { useConfigStore } from '../../../stores/configStore';
import { useQuickSession } from '../../../hooks/useQuickSession';
import { ONBOARDING_FIRST_SESSION_STEP } from '../../../utils/onboarding';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';

export interface FirstSessionStepProps {
  project: GuidedProject;
  onLaunched: (launched: LaunchedSession) => void;
  onFinishWithoutLaunching: () => void;
}

const PRIMARY_LABEL: Record<SessionChoice, string> = {
  planner: 'Launch planner →',
  ship: 'Launch ship →',
  quick: 'Start quick session →',
};

export function FirstSessionStep({
  project,
  onLaunched,
  onFinishWithoutLaunching,
}: FirstSessionStepProps): React.JSX.Element {
  const sessionChoice = useOnboardingStore((s) => s.sessionChoice);
  const setSessionChoice = useOnboardingStore((s) => s.setSessionChoice);
  const permissionMode = useConfigStore((s) => s.config?.defaultAgentPermissionMode) ?? 'default';

  const allTasks = useBacklogStore((s) => s.tasks);
  const ideas = useMemo<BacklogTaskItem[]>(
    () =>
      allTasks
        .filter((t) => t.type === 'idea' && t.project_id === project.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [allTasks, project.id],
  );

  // Planner: multi-select, all checked by default (capped at MAX_PLANNER_SEED_IDEAS).
  // Ship: single-select, the newest idea preselected.
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    ideas.slice(0, MAX_PLANNER_SEED_IDEAS).map((i) => i.id),
  );
  const [shipIdeaId, setShipIdeaId] = useState<string | null>(ideas[0]?.id ?? null);

  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { startWithDefaults } = useQuickSession({
    projectId: project.id,
    onSuccess: (sessionId) => onLaunched({ kind: 'quick', sessionId, runId: null }),
  });

  const togglePlannerIdea = (id: string): void => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_PLANNER_SEED_IDEAS) return prev; // further clicks ignored
      return [...prev, id];
    });
  };

  const handlePrimary = async (): Promise<void> => {
    if (sessionChoice === 'quick') {
      await startWithDefaults('quick');
      return;
    }
    setError(null);
    setLaunching(true);
    try {
      const ideaIds = sessionChoice === 'ship' ? (shipIdeaId !== null ? [shipIdeaId] : []) : selectedIds;
      const launched = await launchFirstFlow({
        kind: sessionChoice,
        projectId: project.id,
        ideaIds,
        permissionMode,
      });
      onLaunched(launched);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to launch session');
    } finally {
      setLaunching(false);
    }
  };

  const shipDisabled = sessionChoice === 'ship' && ideas.length === 0;

  return (
    <GuidedScreen
      step={ONBOARDING_FIRST_SESSION_STEP}
      title="Launch your first session"
      intro={
        <>
          Now that you’ve added your first ideas, let’s launch your first session. Every option
          below runs in its own worktree of{' '}
          <strong className="font-semibold text-text-primary">{project.name}</strong>. When it
          needs you, it will land here in the Human review queue.
        </>
      }
      footer={
        <GuidedFooter
          skipLabel="Finish without launching"
          onSkip={onFinishWithoutLaunching}
          skipTestId="onboarding-guided-skip"
          primaryLabel={launching ? 'Launching…' : PRIMARY_LABEL[sessionChoice]}
          onPrimary={() => void handlePrimary()}
          primaryDisabled={launching || shipDisabled}
          primaryTestId="onboarding-first-session-launch"
        />
      }
    >
      <div role="radiogroup" aria-label="First session" className="flex w-full flex-col gap-2 text-left">
        {SESSION_CHOICES.map((choice) => {
          const selected = sessionChoice === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setSessionChoice(choice.value)}
              className={`flex items-start gap-[11px] bg-surface-primary px-[15px] py-[13px] text-left transition-colors ${
                selected
                  ? 'border-[1.4px] border-border-emphasized'
                  : 'border border-border-primary hover:border-border-emphasized'
              }`}
            >
              <span
                aria-hidden="true"
                className="flex h-[17px] w-[17px] flex-shrink-0 items-center justify-center bg-[var(--paper-3)] text-[9px] font-bold text-text-secondary"
              >
                {choice.key}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="block text-[12px] font-bold text-text-primary">{choice.title}</span>
                  <span className="text-[9px] uppercase tracking-[.14em] text-text-tertiary">
                    {choice.tag}
                  </span>
                </span>
                <span className="mt-[3px] block text-[10px] leading-[1.55] text-text-tertiary">
                  {choice.body}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {sessionChoice !== 'quick' && (
        <div className="mt-3 flex flex-col gap-2">
          <span className="text-[9px] font-bold tracking-[.14em] text-text-tertiary">
            {sessionChoice === 'planner'
              ? `SEED THE PLANNER WITH — UP TO ${MAX_PLANNER_SEED_IDEAS}`
              : 'SHIP THIS IDEA'}
          </span>

          {ideas.length === 0 ? (
            <p className="text-[10px] leading-[1.55] text-text-tertiary">
              {sessionChoice === 'planner'
                ? 'No ideas yet — the planner will start from a blank backlog and ask what you want to build.'
                : 'Ship needs an idea to build. Add one from the assistant first, or pick another session.'}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {ideas.map((idea) => {
                const checked =
                  sessionChoice === 'planner' ? selectedIds.includes(idea.id) : shipIdeaId === idea.id;
                return (
                  <button
                    key={idea.id}
                    type="button"
                    role={sessionChoice === 'planner' ? 'checkbox' : 'radio'}
                    aria-checked={checked}
                    onClick={() =>
                      sessionChoice === 'planner' ? togglePlannerIdea(idea.id) : setShipIdeaId(idea.id)
                    }
                    className={`flex items-center justify-between gap-2 border px-[11px] py-[8px] text-left transition-colors ${
                      checked
                        ? 'border-border-emphasized bg-surface-primary'
                        : 'border-border-primary bg-surface-primary hover:border-border-emphasized'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-[7px]">
                      <span
                        aria-hidden="true"
                        className={`flex h-[13px] w-[13px] flex-shrink-0 items-center justify-center text-[8px] font-bold ${
                          checked
                            ? 'bg-interactive text-[var(--paper)]'
                            : 'border border-border-primary text-transparent'
                        }`}
                      >
                        ✓
                      </span>
                      <span className="truncate text-[11px] text-text-primary">{idea.title}</span>
                    </span>
                    <span className="flex-shrink-0 text-[10px] text-text-tertiary">
                      {idea.ref} · {idea.priority}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {error !== null && (
        <p role="alert" className="mt-3 text-[11px] text-status-error">
          {error}
        </p>
      )}
    </GuidedScreen>
  );
}
