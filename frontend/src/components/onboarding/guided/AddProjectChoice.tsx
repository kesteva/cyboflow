import cyboflowLogo from '../../../assets/cyboflow-logo.svg';

/** Step-7 radio value — mirrors onboardingStore's `projectChoice`. */
export type ProjectChoice = 'existing' | 'new' | 'unsure';

interface ChoiceRow {
  value: ProjectChoice;
  /** Numbered chip, purely positional (the rows are a radio group, not a list). */
  key: string;
  title: string;
  body: string;
}

const CHOICES: readonly ChoiceRow[] = [
  {
    value: 'existing',
    key: '1',
    title: 'Existing project',
    body: 'Point Cyboflow at a folder on this machine.',
  },
  {
    value: 'new',
    key: '2',
    title: 'New project',
    body: 'Creates the folder, initializes git, makes the first commit.',
  },
  {
    value: 'unsure',
    key: '3',
    title: 'Not sure yet',
    body: 'Keep going without one — add a project any time from the home screen or the sidebar.',
  },
];

interface AddProjectChoiceProps {
  value: ProjectChoice;
  onChange: (choice: ProjectChoice) => void;
  onNext: () => void;
  onSkip: () => void;
}

/**
 * Guided step 1 of 8 (tour step 7) — which kind of project to start from.
 *
 * 'existing' and 'new' pick which screen step 8 renders; 'unsure' is a branch
 * the STORE owns (next() skips step 8 and continues into the shell with no
 * project), so this screen's primary is an unconditional next() in all three
 * cases.
 */
export function AddProjectChoice({
  value,
  onChange,
  onNext,
  onSkip,
}: AddProjectChoiceProps): React.JSX.Element {
  return (
    <div className="flex flex-col items-center text-center">
      <img src={cyboflowLogo} alt="" aria-hidden="true" className="mb-5 h-10 w-10" />

      <h1 className="text-[24px] font-extrabold tracking-[-.01em] text-text-primary">
        Add a project
      </h1>
      <p className="mb-6 mt-2 text-[12px] leading-[1.6] text-text-secondary">
        Cyboflow agents are organized around projects which are git tracked directories on your
        computer. Choose an existing one or a new one to get started.
      </p>

      <div role="radiogroup" aria-label="Add a project" className="flex w-full flex-col gap-2 text-left">
        {CHOICES.map((choice) => {
          const selected = value === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(choice.value)}
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
                <span className="block text-[12px] font-bold text-text-primary">{choice.title}</span>
                <span className="mt-[3px] block text-[10px] leading-[1.55] text-text-tertiary">
                  {choice.body}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-[22px] flex w-full items-center">
        <button
          type="button"
          data-testid="onboarding-guided-skip"
          onClick={onSkip}
          className="border-none bg-transparent py-2 pl-0 pr-2 text-[10px] font-semibold uppercase tracking-[.1em] text-text-tertiary transition-colors hover:text-text-primary"
        >
          Skip the set-up
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onNext}
          className="border border-border-emphasized bg-[var(--ink)] px-4 py-[9px] text-[10px] font-bold uppercase tracking-[.12em] text-[var(--paper)] transition-colors hover:border-interactive hover:bg-interactive"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
