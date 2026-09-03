/**
 * Onboarding copy-of-record — the strings and small data arrays shared by the
 * modal card chrome and the step bodies. Transcribed from the "Onboarding
 * Restructure" design canvas (`*.dc.html` artboards), which is the copy-of-record
 * wherever it drifts from prose elsewhere in the repo.
 *
 * Only genuinely SHARED copy lives here — a title the card chrome renders for a
 * step it knows nothing else about. Body copy belongs next to the step that
 * renders it (steps/*.tsx), and the guided set-up screens (7-14) own their own
 * headings entirely; their entries below exist only so the dialog's aria-label
 * and the telemetry slug have something index-aligned to read.
 *
 * One deliberate deviation from the design: step 1 drops the "Max plan" tier
 * claim (main/ cannot introspect billing — see shared/types/onboarding.ts).
 */

/** Header/dialog title per step (index === step). Step 0 uses the hero, not this. */
export const ONBOARDING_TITLES: ReadonlyArray<string> = [
  'Welcome to Cyboflow',
  'Connect an agent',
  'Pick your default agent',
  'Pick a model',
  'Set your permission mode',
  'Choose what to share',
  "You're set up",
  'Add a project',
  'Add a project',
  'Your project lives here',
  'Build a backlog of ideas',
  "Here's how I'd capture that",
  'Meet the Cyboflow assistant',
  'Launch your first session',
  'Launching your session now',
];

/** Step-0 hero bullets (swatch color is a phase-identity hex with no token). */
export const WELCOME_BULLETS: ReadonlyArray<{ swatch: string; title: string; body: string }> = [
  {
    swatch: '#c96442', // terracotta phase swatch
    title: 'Parallel by default',
    body: 'Every session runs in its own isolated git worktree — run several at once, nothing collides.',
  },
  {
    swatch: '#3b6dd6', // plan-phase blue (no semantic token)
    title: 'Flows, not one-shot prompts',
    body: 'Built-in flows carry work through plan → execute → verify → review.',
  },
  {
    swatch: '#2d8a5b', // green-accent phase swatch
    title: 'Get pulled in only when it matters',
    body: 'Monitor everything from a central queue so you can stay in the loop, but only for the places your judgement is truly needed.',
  },
];
