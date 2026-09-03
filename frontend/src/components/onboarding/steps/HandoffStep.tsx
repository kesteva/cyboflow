/**
 * Step 6 — "You're set up". The last modal card, and the fork between the two
 * halves of the tour: walk into the full-window guided set-up (steps 7-8, where
 * a project actually gets added), or finish here and land on the app with no
 * project.
 *
 * Purely presentational/controlled like its neighbours — the choice lives in the
 * store (`handoffChoice`) and the gate's footer primary reads it to decide
 * whether it says "Continue →" or "Finish →". Both call next(); the store owns
 * the terminal transition (see onboardingStore.next).
 */
interface HandoffStepProps {
  value: 'continue' | 'skip';
  onChange: (choice: 'continue' | 'skip') => void;
}

interface Choice {
  id: 'continue' | 'skip';
  title: string;
  /** Terracotta duration chip; only the "continue" card carries one. */
  tag?: string;
  body: string;
}

const CHOICES: ReadonlyArray<Choice> = [
  {
    id: 'continue',
    title: 'Continue with onboarding',
    tag: '~2 MIN',
    body: 'Get your first project set-up and launch your first workflow.',
  },
  {
    id: 'skip',
    title: 'Skip the set-up',
    body: 'Straight to the app. Add projects and launch sessions yourself.',
  },
];

export function HandoffStep({ value, onChange }: HandoffStepProps): React.JSX.Element {
  return (
    <div className="px-6 pb-4 pt-5">
      <div className="mb-3.5 text-[12px] leading-[1.6] text-text-primary">
        Continue with onboarding, or skip the set-up?
      </div>

      <div role="radiogroup" aria-label="How to start" className="flex flex-col gap-2">
        {CHOICES.map((choice) => {
          const selected = value === choice.id;
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(choice.id)}
              className={`flex items-start gap-3 bg-surface-primary px-[15px] py-3.5 text-left transition-colors ${
                selected
                  ? 'border-[1.4px] border-border-emphasized'
                  : 'border border-border-primary hover:border-border-emphasized'
              }`}
            >
              <span
                aria-hidden="true"
                className={`mt-px flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full border-[1.4px] ${
                  selected ? 'border-interactive' : 'border-border-primary'
                }`}
              >
                {selected && <span className="h-[8px] w-[8px] rounded-full bg-interactive" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-[12px] font-bold text-text-primary">{choice.title}</span>
                  {choice.tag && (
                    <span className="bg-interactive px-1.5 py-0.5 text-[8px] font-bold tracking-[.1em] text-text-on-interactive">
                      {choice.tag}
                    </span>
                  )}
                </span>
                <span className="mt-[3px] block text-[10px] leading-[1.55] text-text-secondary">
                  {choice.body}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
