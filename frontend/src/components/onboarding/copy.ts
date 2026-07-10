/**
 * Onboarding copy-of-record — strings & small data arrays shared by the modal
 * card, coachmark, and step bodies. Copy is transcribed from the design packet's
 * `Onboarding Carousel.dc.html` (the copy-of-record where it drifts from the
 * README), with the two deliberate deviations noted at their call sites:
 *   - step 1 drops the "Max plan" tier claim (main/ cannot introspect billing;
 *     see shared/types/onboarding.ts).
 *   - step 7 adds the Verify Queue row (six rows, not the prototype's five).
 */

/** Header/popover title per step (index === step). Step 0 uses the hero, not this. */
export const ONBOARDING_TITLES: ReadonlyArray<string> = [
  'Welcome to Cyboflow',
  'Connect Claude Code',
  'Set your permission mode',
  'Add a project',
  'Start your first session',
  'Run your first flow',
  'Watch it in Human review',
  'Find your way around',
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
