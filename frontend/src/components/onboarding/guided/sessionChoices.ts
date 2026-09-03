/**
 * The three first-session options guided step 13 offers, shared by
 * FirstSessionStep (the live picker, project present) and
 * SessionTypesPreviewStep (the read-only preview on the no-project branch) so
 * the two screens never drift on copy.
 */
import type { SessionChoice } from '../../../stores/onboardingStore';

export interface SessionChoiceRow {
  value: SessionChoice;
  key: string;
  tag: string;
  title: string;
  body: string;
}

export const SESSION_CHOICES: readonly SessionChoiceRow[] = [
  {
    value: 'planner',
    key: '1',
    tag: 'Planner flow',
    title: 'Planning session',
    body: 'Turns your backlog of ideas into specific tasks — a spec, acceptance criteria and a plan you approve before anything is built.',
  },
  {
    value: 'ship',
    key: '2',
    tag: 'Ship flow',
    title: 'Ship session',
    body: 'Plans and builds one of your ideas from the backlog end to end, with review gates along the way.',
  },
  {
    value: 'quick',
    key: '3',
    tag: 'Chat · CLI',
    title: 'Quick session',
    body: 'A regular chat or CLI session, just like the one you’re already used to. One agent, one worktree, no flow.',
  },
];
