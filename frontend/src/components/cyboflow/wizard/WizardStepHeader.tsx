/**
 * WizardStepHeader — the step rail atop the SessionStartWizard.
 *
 * Three steps: ① Project · ② Workflow · ③ Configure. Two layouts driven by
 * `locked`:
 *   - Unlocked: "① Project —— ② Workflow —— ③ Configure" with the current step
 *     bold.
 *   - Locked: "② Workflow —— ③ Configure" (the project is pinned, so no ①).
 *
 * The right-aligned back affordance depends on the current step:
 *   - step 3 → "← Back to workflow" (→ step 2), both modes.
 *   - step 2 unlocked → "← Change project" (→ step 1).
 *   - otherwise → "← Back to queue" (→ goHome).
 *
 * Pure presentational: the parent owns the step state and the navigation
 * callbacks. UI labels are UPPERCASE wide-tracked (the `.eyebrow` utility).
 */

export type WizardStep = 1 | 2 | 3;

interface WizardStepHeaderProps {
  /** When true, the wizard is pinned to a project — no project step. */
  locked: boolean;
  /** Current step. */
  step: WizardStep;
  /** Back to the home queue (both modes; step 1 unlocked / step 2 locked). */
  onBackToQueue: () => void;
  /** Back to the project step (unlocked mode, step 2 only). */
  onChangeProject: () => void;
  /** Back to the workflow step (both modes, step 3 only). */
  onBackToWorkflow: () => void;
}

const STEP_LABELS: ReadonlyArray<{ step: WizardStep; glyph: string; label: string }> = [
  { step: 1, glyph: '①', label: 'Project' },
  { step: 2, glyph: '②', label: 'Workflow' },
  { step: 3, glyph: '③', label: 'Configure' },
];

export function WizardStepHeader({
  locked,
  step,
  onBackToQueue,
  onChangeProject,
  onBackToWorkflow,
}: WizardStepHeaderProps): React.JSX.Element {
  // Locked mode pins the project, so drop the ① Project step from the rail.
  const steps = locked ? STEP_LABELS.filter((s) => s.step !== 1) : STEP_LABELS;

  let back: { label: string; onClick: () => void; testId: string };
  if (step === 3) {
    back = { label: '← Back to workflow', onClick: onBackToWorkflow, testId: 'wizard-back-to-workflow' };
  } else if (!locked && step === 2) {
    back = { label: '← Change project', onClick: onChangeProject, testId: 'wizard-change-project' };
  } else {
    back = { label: '← Back to queue', onClick: onBackToQueue, testId: 'wizard-back-to-queue' };
  }

  return (
    <div className="flex items-center justify-between border-b border-border-primary pb-3">
      <div className="flex items-center gap-2 eyebrow" data-testid="wizard-step-rail">
        {steps.map(({ step: s, glyph, label }, idx) => (
          <span key={s} className="flex items-center gap-2">
            {idx > 0 && (
              <span className="text-text-muted" aria-hidden="true">
                ——
              </span>
            )}
            <span
              className={step === s ? 'text-text-primary' : 'text-text-tertiary'}
              style={step === s ? { fontWeight: 700 } : { fontWeight: 400 }}
            >
              {glyph} {label}
            </span>
          </span>
        ))}
      </div>

      <button
        type="button"
        onClick={back.onClick}
        data-testid={back.testId}
        className="eyebrow text-text-secondary hover:text-interactive"
      >
        {back.label}
      </button>
    </div>
  );
}
