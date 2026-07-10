/**
 * First-run onboarding — renderer-side shared constants.
 *
 * Neutral module (importable by stores, components, and integration touch
 * points alike) so the onboarding overlay, the Sidebar resume button, and the
 * real-action dispatch sites never drift on key/event/anchor names.
 */

/**
 * Single user_preferences key holding the persisted tour snapshot as JSON
 * (see PersistedOnboarding in stores/onboardingStore.ts). Read/write via the
 * raw `preferences:get` / `preferences:set` IPC channels — the established
 * pattern for one-shot UI flags (docs/CODE-PATTERNS.md "IPC preference-backed
 * component visibility").
 */
export const ONBOARDING_PREF_KEY = 'cyboflow_onboarding_state_v1';

/**
 * Window CustomEvents that advance the tour's coach steps. `projectCreated`
 * is the app's PRE-EXISTING event (dispatched by CreateProjectDialog and any
 * onboarding-embedded create path); the other two are dispatched at the
 * real-action success sites (quick-session creation, runs.start success).
 */
export const ONBOARDING_EVENTS = {
  projectCreated: 'project-created',
  quickSessionCreated: 'cyboflow:quick-session-created',
  workflowRunStarted: 'cyboflow:workflow-run-started',
} as const;

/**
 * Coachmark anchor ids, rendered as `data-onboarding="<id>"` on the real
 * target elements. The Coachmark component resolves targets exclusively via
 * this attribute — never by class name or test id.
 */
export const ONBOARDING_ANCHOR_ATTR = 'data-onboarding';
export const ONBOARDING_ANCHORS = {
  /** SessionStartWizard step-② Quick Session card (tour step 4). */
  quickSessionCard: 'quick-session-card',
  /** QuickSessionCanvas "/ship" workflow chip (tour step 5). */
  shipChip: 'ship-chip',
  /** Sidebar "Human review" rail item (tour step 6). */
  humanReview: 'human-review',
} as const;

export const ONBOARDING_STEP_COUNT = 8;

/** Steps rendered as the centered modal card. */
export const ONBOARDING_MODAL_STEPS: ReadonlyArray<number> = [0, 1, 2, 3, 7];
/** Steps rendered as an anchored coachmark over the live UI. */
export const ONBOARDING_COACH_STEPS: ReadonlyArray<number> = [4, 5, 6];
