/**
 * Per-level BUDGETS for the agents whose output size and rigour should follow the
 * project's declared solution thoroughness.
 *
 * The level itself (`SolutionThoroughness`, `shared/types/thoroughness.ts`) is
 * captured at the Launch interview and stamped on the project. This module is the
 * other half: what that level actually MEANS to each agent, as prose the step
 * prompt renders. Kept in its own module rather than beside the level union so the
 * declaration (a shared type read by the DB, the wizard and the renderer) stays
 * free of agent-facing prompt text, which changes for entirely different reasons.
 *
 * WHY IT EXISTS. A level nobody reads is a level that changes nothing. Without
 * these budgets a `prototype` project still gets a 120-line architecture document,
 * tasks with rollback criteria, and a review that blocks on a missing auth check —
 * the exact over-building the level was chosen to avoid — while a `production`
 * project gets the same default rigour as a throwaway. The budgets are written as
 * CONTRACTS the agent obeys over its own defaults, because that is the only
 * framing that beats a detailed agent prompt saying otherwise.
 *
 * Keyed by the agent key a step's `agent` field carries, so `composeStepPrompt`
 * renders only the lines for the agent actually running. An agent with no entry
 * at a level renders nothing — silence is correct for an agent the level does not
 * change.
 */
import type { SolutionThoroughness } from './thoroughness';

/** The agent keys whose contract varies by thoroughness. */
export type ThoroughnessBudgetAgent =
  | 'architecture'
  | 'tasks'
  | 'adversarial-review'
  | 'implement'
  | 'code-review';

/** One level's per-agent budget lines. An absent agent gets no section. */
export type ThoroughnessBudget = Partial<Record<ThoroughnessBudgetAgent, string>>;

/**
 * The budget contracts, by level. Prose, not numbers-in-a-config: each line has to
 * survive being read once by an agent that has never seen this file, so it states
 * the ceiling AND the thing to stop doing.
 */
export const THOROUGHNESS_BUDGETS: Record<SolutionThoroughness, ThoroughnessBudget> = {
  prototype: {
    architecture:
      'Keep the architecture to at most 40 lines. Name the stack, the two or three components, and where data lives — nothing else. Do NOT write an alternatives-considered section, a scaling section, a security section, or a migration path: at this level the design is meant to be thrown away, and a decision record for a throwaway is pure cost.',
    tasks:
      'Write HAPPY-PATH acceptance criteria only. Do not mint tasks for edge cases, error states, retries, or hardening, and do not add criteria about them — note them in the task body instead so they are not lost. Aim for at most 8 tasks per idea; if the decomposition wants more, the scope is too big for a prototype and should be cut, not split.',
    'adversarial-review':
      'OVER-ENGINEERING is the blocking defect at this level: an abstraction with one caller, a config knob nobody asked for, a persistence layer for data that fits in memory — file those under `### Blocking`. Security and robustness gaps are `### Findings` (advisory) unless the prototype handles real user credentials or real money. A prototype exists to answer one question; flag anything that does not serve that question.',
    implement:
      'Build the shortest thing that works. No abstractions for a single caller, no options nobody asked for, no comments narrating future work ("later we could…"), no defensive handling for conditions this prototype cannot reach. If you are tempted to generalize, do not — note it for the reviewer instead.',
    'code-review':
      'Block on over-engineering — an abstraction with one caller, premature generality, speculative configuration. Do NOT block on missing error handling, missing tests for edge cases, or hardening gaps: at this level those are deliberate, and raising them as blocking defects sends the implementer to build exactly what the level exists to avoid. Raise them as advisory findings if they are worth remembering.',
  },
  v1: {
    architecture:
      'Size the architecture for a human decision: roughly 60–120 lines, with the alternatives considered and a clear recommendation.',
    tasks:
      "Acceptance criteria cover the happy path plus the failure modes a single user will actually hit. Edge cases that only a multi-user or high-volume deployment reaches belong in the task body as notes, not as criteria.",
    'adversarial-review':
      'Weigh both directions: an unhandled failure a real user will hit is blocking, and so is an abstraction built for a scale this software will not see. Security gaps are blocking where real user data is involved, advisory otherwise.',
    implement:
      'Handle the failures one real user will hit. Leave multi-user, high-volume, and adversarial-input hardening out unless a criterion asks for it, and say so in your result.',
    'code-review':
      'Block on correctness defects and on failures a single real user will hit. Hardening for scale this software does not yet have is an advisory finding, not a blocking one.',
  },
  production: {
    architecture:
      'Size the architecture for a human decision (roughly 60–120 lines) and additionally make explicit: the failure modes and how the system behaves in each, data durability and what happens on loss, and the migration path from what exists today. Other people depend on this — a design that does not say how it fails has not been designed.',
    tasks:
      'Acceptance criteria MUST cover error handling, the edge cases the component will genuinely meet, and how the change is rolled back if it goes wrong in production. A criterion that only describes the happy path is incomplete at this level.',
    'adversarial-review':
      'Security and robustness gaps are ALWAYS `### Blocking` at this level — authentication, authorization, input validation, data loss, unbounded growth, and anything that fails silently. Under-engineering is the defect to hunt here, not over-engineering.',
    implement:
      'Handle errors explicitly, validate inputs at the boundary, and make failures observable rather than silent. Do not leave a path that loses data or fails without a trace.',
    'code-review':
      'Security and robustness gaps are ALWAYS blocking at this level: authentication, authorization, input validation, data loss, unbounded growth, silent failure. Apply that bar even when the task did not name them.',
  },
};
