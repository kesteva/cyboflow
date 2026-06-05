/**
 * WizardStepHeader — the step rail atop the SessionStartWizard.
 *
 * Two layouts driven by `locked`:
 *   - Unlocked: "① Project —— ② Workflow" with the current step bold, plus a
 *     right-aligned back affordance. On step 1 the affordance is
 *     "← Back to queue" (→ goHome); on step 2 it is "← Change project"
 *     (→ back to step 1).
 *   - Locked: just "▸ Choose workflow" + "← Back to queue" (→ goHome). No
 *     project step and no "Change project" affordance — the project is pinned.
 *
 * Pure presentational: the parent owns the step state and the navigation
 * callbacks. UI labels are UPPERCASE wide-tracked (the `.eyebrow` utility).
 */

interface WizardStepHeaderProps {
  /** When true, the wizard is pinned to a project — no project step. */
  locked: boolean;
  /** Current step (only meaningful when `locked` is false). */
  step: 1 | 2;
  /** Back to the home queue (both modes, step 1 in unlocked mode). */
  onBackToQueue: () => void;
  /** Back to the project step (unlocked mode, step 2 only). */
  onChangeProject: () => void;
}

export function WizardStepHeader({
  locked,
  step,
  onBackToQueue,
  onChangeProject,
}: WizardStepHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-border-primary pb-3">
      {locked ? (
        <span className="eyebrow text-text-primary" data-testid="wizard-step-locked">
          ▸ Choose workflow
        </span>
      ) : (
        <div className="flex items-center gap-2 eyebrow" data-testid="wizard-step-rail">
          <span
            className={
              step === 1
                ? 'text-text-primary'
                : 'text-text-tertiary'
            }
            style={step === 1 ? { fontWeight: 700 } : { fontWeight: 400 }}
          >
            ① Project
          </span>
          <span className="text-text-muted" aria-hidden="true">
            ——
          </span>
          <span
            className={
              step === 2
                ? 'text-text-primary'
                : 'text-text-tertiary'
            }
            style={step === 2 ? { fontWeight: 700 } : { fontWeight: 400 }}
          >
            ② Workflow
          </span>
        </div>
      )}

      {!locked && step === 2 ? (
        <button
          type="button"
          onClick={onChangeProject}
          data-testid="wizard-change-project"
          className="eyebrow text-text-secondary hover:text-interactive"
        >
          ← Change project
        </button>
      ) : (
        <button
          type="button"
          onClick={onBackToQueue}
          data-testid="wizard-back-to-queue"
          className="eyebrow text-text-secondary hover:text-interactive"
        >
          ← Back to queue
        </button>
      )}
    </div>
  );
}
