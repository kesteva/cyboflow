import { create } from 'zustand';
import type { ClaudeDetectionResult, CodexDetectionResult } from '../../../shared/types/onboarding';
import type { PermissionMode } from '../../../shared/types/workflows';
import { ONBOARDING_COACH_STEPS, ONBOARDING_POINTER_STEPS, ONBOARDING_STEP_COUNT } from '../utils/onboarding';

/**
 * onboardingStore — the 12-step first-run tour's state machine.
 *
 * Steps: 0 welcome · 1 connect an agent provider (the only gated step) · 2 permission
 * mode · 3 telemetry consent · 4 add project · 5 quick-session coachmark (wizard Quick
 * Session card) · 6-8 wizard-Configure pointers (runtime / session permission / model) ·
 * 9 /ship coachmark (session canvas chip) · 10 Human-review coachmark ·
 * 11 rail map.
 *
 * The machine is PURE — all persistence (user_preferences JSON snapshot),
 * detection fetches, window-event subscriptions, keyboard handling, and
 * precondition navigation (ensuring the wizard is open when step 5 begins)
 * live in components/onboarding/OnboardingGate. Keep it that way: every
 * transition here must stay synchronously testable.
 *
 * Advancement rules (the tour is completed by DOING, not clicking through):
 * - Modal steps (0,1,2,3,4,11) advance via next(); step 1 refuses until the
 *   Claude or Codex probe says 'detected' AND its consent toggle is on; step 4
 *   normally advances via the real 'project-created' event (its primary
 *   button creates the project), falling back to next() when projects
 *   already exist (replay / resumed installs). Step 3 (telemetry) advances
 *   like any other modal step via next() — the actual consent UI is owned by
 *   its own step component, not this store.
 * - Pointer steps (6-8, the Configure trio) are informational: they advance
 *   via next() (the popover's Next button); interacting with the anchored
 *   control never advances them. Next on the LAST pointer (8) parks 'pending'
 *   — the next tour beat (the /ship chip) only exists once the session
 *   launches, and 'quick-session-created' fires from ANY of steps 5-8 (the
 *   user may hit Start before Next-ing through every pointer), landing 9.
 * - Do-steps advance ONLY via the real action: step 5's card click flips the
 *   wizard to Configure where step 6's anchor mounts, so it advances directly;
 *   step 9's /ship click parks 'pending' while the idea modal runs and
 *   'workflow-run-started' lands 10; step 10 advances directly on its click.
 * - Dots/keyboard may only revisit steps already reached (maxVisitedStep),
 *   so neither can bypass the step-1 gate or the coach preconditions.
 * - forceNext() is the anchor-lost escape (see its interface doc): the only way
 *   to move a do-step forward when its target has unmounted.
 */

export type OnboardingStatus = 'idle' | 'active' | 'pending' | 'skipped' | 'completed';

/** Real-world signals the coach steps wait on (see utils/onboarding.ts events). */
export type OnboardingRealEvent = 'project-created' | 'quick-session-created' | 'workflow-run-started';

/** JSON shape persisted under ONBOARDING_PREF_KEY — version 1 (pre-Telemetry-step). */
export interface PersistedOnboardingV1 {
  version: 1;
  status: Exclude<OnboardingStatus, 'idle'>;
  step: number;
}

/**
 * JSON shape persisted under ONBOARDING_PREF_KEY — version 2. Same shape as
 * v1; only the step-index semantics changed (the Telemetry step's insertion
 * at index 3 shifted every step from the old index 3 onward forward by one).
 * See migratePersistedOnboarding.
 */
export interface PersistedOnboardingV2 {
  version: 2;
  status: Exclude<OnboardingStatus, 'idle'>;
  step: number;
}

/** JSON shape persisted under ONBOARDING_PREF_KEY (either schema version). */
export type PersistedOnboarding = PersistedOnboardingV1 | PersistedOnboardingV2;

/**
 * Version-1 → version-2 step-index remap: the Telemetry step was inserted at
 * index 3 (after Permission, before Add project), so every old step at or
 * after index 3 now lives one index higher.
 */
export function migrateV1StepIndex(step: number): number {
  return step >= 3 ? step + 1 : step;
}

/**
 * Normalizes a persisted snapshot to the current (version 2) shape.
 * - version 2 snapshots pass through unchanged (already-current schema).
 * - version 1 snapshots with status 'completed' keep their step as-is — a
 *   completed onboarding's step index carries no further navigational
 *   meaning (hydrate short-circuits on status alone), so remapping it would
 *   be a no-op at best and is skipped entirely to avoid ever "breaking" a
 *   completed snapshot.
 * - version 1 snapshots in any other status remap their step via
 *   migrateV1StepIndex before the store ever sees it.
 */
export function migratePersistedOnboarding(persisted: PersistedOnboarding): PersistedOnboardingV2 {
  if (persisted.version === 2) return persisted;
  if (persisted.status === 'completed') {
    return { version: 2, status: 'completed', step: persisted.step };
  }
  return { version: 2, status: persisted.status, step: migrateV1StepIndex(persisted.step) };
}

/**
 * Boot clamp for a restart mid-tour: coach steps whose real-world context is
 * gone resume at the nearest step that can rebuild it. Steps 6-8 anchor the
 * wizard's Configure page and step 9 the session canvas — neither survives a
 * restart — so they re-run step 5, which rebuilds its own precondition (the
 * gate reopens the wizard). Step 10's rail anchor always exists.
 */
export function clampResumeStep(step: number): number {
  if (step >= 6 && step <= 9) return 5;
  return Math.min(Math.max(step, 0), ONBOARDING_STEP_COUNT - 1);
}

interface OnboardingState {
  status: OnboardingStatus;
  /** Current step, 0..11 — meaningful whenever status !== 'idle'. */
  step: number;
  /** Highest step ever reached this run; dots/goTo may only jump ≤ this. */
  maxVisitedStep: number;
  /** True when launched from Settings → Replay walkthrough (step 4 shows the existing-project state). */
  replay: boolean;
  /** Latest claude:detect result; null = probe not yet run (step 1 shows loading). */
  detection: ClaudeDetectionResult | null;
  /** Step-1 consent toggle ("use this install for every session"). */
  connected: boolean;
  /** Latest codex:detect result; null = probe not yet run. */
  codexDetection: CodexDetectionResult | null;
  /** Step-1 consent toggle for the ChatGPT-authenticated Codex runtime. */
  codexConnected: boolean;
  /** Step-2 selection; 'auto' preselected per design, persisted to config on step-2 next(). */
  permMode: PermissionMode;
  /** Boot gate resolved — render nothing until true (no-flash rule, docs/CODE-PATTERNS.md). */
  hydrated: boolean;

  /**
   * Resolve the boot gate. `persisted` is the parsed pref snapshot (null on a
   * pristine install); `projectsCount` decides the pristine branch: existing
   * installs (projects > 0) are marked completed without ever seeing the tour.
   */
  hydrate: (persisted: PersistedOnboarding | null, projectsCount: number) => void;
  /** Start (or restart) the tour at step 0. */
  begin: (replay: boolean) => void;
  next: () => void;
  /**
   * Anchor-lost escape: force a plain step+1 advance, bypassing the
   * advance-by-doing guard. Wired ONLY to the Coachmark's anchor-lost fallback —
   * a do-step (5/9/10) whose target has unmounted (e.g. Back into step 5 after the
   * wizard left the Quick Session card) has no other way forward, since next()
   * no-ops on do-steps.
   */
  forceNext: () => void;
  back: () => void;
  /** Dot navigation — only to steps already visited. */
  goTo: (step: number) => void;
  skip: () => void;
  /** Skipped/pending → active at the current (clamped) step. */
  resume: () => void;
  /**
   * Permanent dismiss from the Sidebar "Resume setup" card: skipped/pending →
   * completed. Unlike skip() (which leaves the resume affordance standing),
   * dismiss() closes the tour for good — the completed snapshot persists, so it
   * never reappears on future boots. Recoverable only via Settings → Replay
   * walkthrough (restart()).
   */
  dismiss: () => void;
  finish: () => void;
  /** Settings → Replay walkthrough. */
  restart: () => void;
  setDetection: (result: ClaudeDetectionResult | null) => void;
  setConnected: (connected: boolean) => void;
  setCodexDetection: (result: CodexDetectionResult | null) => void;
  setCodexConnected: (connected: boolean) => void;
  setPermMode: (mode: PermissionMode) => void;
  /** The user clicked the highlighted coachmark target (capture-phase listener). */
  anchorActioned: () => void;
  /** A real-action window event landed (OnboardingGate forwards them here). */
  realEvent: (kind: OnboardingRealEvent) => void;
}

const LAST_STEP = ONBOARDING_STEP_COUNT - 1;

/** Step 1 refuses to advance until the probe is green and consent is given. */
export function isNextGateBlocked(
  state: Pick<
    OnboardingState,
    'step' | 'detection' | 'connected' | 'codexDetection' | 'codexConnected'
  >,
): boolean {
  if (state.step !== 1) return false;
  const claudeReady = state.detection?.state === 'detected' && state.connected;
  const codexReady = state.codexDetection?.state === 'detected' && state.codexConnected;
  return !claudeReady && !codexReady;
}

/** Advance-by-doing coach steps (5, 9, 10) — coach steps that are NOT pointers. */
const isDoStep = (step: number): boolean =>
  ONBOARDING_COACH_STEPS.includes(step) && !ONBOARDING_POINTER_STEPS.includes(step);

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  status: 'idle',
  step: 0,
  maxVisitedStep: 0,
  replay: false,
  detection: null,
  connected: false,
  codexDetection: null,
  codexConnected: false,
  permMode: 'auto',
  hydrated: false,

  hydrate: (persisted, projectsCount) => {
    if (persisted === null) {
      if (projectsCount > 0) {
        // Existing install upgrading into the feature — never show the tour.
        set({ status: 'completed', hydrated: true });
      } else {
        set({ status: 'active', step: 0, maxVisitedStep: 0, replay: false, hydrated: true });
      }
      return;
    }
    const migrated = migratePersistedOnboarding(persisted);
    if (migrated.status === 'completed') {
      set({ status: 'completed', hydrated: true });
      return;
    }
    // Any mid-tour state (active/pending/skipped) resumes as skipped — the
    // rail's Resume button re-enters at the clamped step, letting the gate
    // rebuild coach preconditions instead of dropping a coachmark on a stale
    // anchor.
    const step = clampResumeStep(migrated.step);
    set({ status: 'skipped', step, maxVisitedStep: step, replay: false, hydrated: true });
  },

  begin: (replay) => set({
    status: 'active',
    step: 0,
    maxVisitedStep: 0,
    replay,
    connected: false,
    detection: null,
    codexConnected: false,
    codexDetection: null,
    permMode: 'auto',
    hydrated: true,
  }),

  next: () => {
    const s = get();
    if (s.status !== 'active') return;
    if (isDoStep(s.step)) return; // do-steps advance by doing, never by next()
    if (isNextGateBlocked(s)) return;
    // Next on the last Configure pointer parks quiet: step 9's anchor (the
    // /ship chip) only exists once the session launches, so the tour waits for
    // 'quick-session-created' — unless the session already exists (revisiting
    // via dots/Back), where a plain advance is safe.
    if (s.step === 8 && s.maxVisitedStep < 9) {
      set({ status: 'pending' });
      return;
    }
    if (s.step >= LAST_STEP) {
      set({ status: 'completed' });
      return;
    }
    const step = s.step + 1;
    set({ step, maxVisitedStep: Math.max(s.maxVisitedStep, step) });
  },

  forceNext: () => {
    const s = get();
    if (s.status !== 'active') return;
    if (isNextGateBlocked(s)) return; // defensive — coach steps are never the step-1 gate
    if (s.step >= LAST_STEP) {
      set({ status: 'completed' });
      return;
    }
    const step = s.step + 1;
    set({ step, maxVisitedStep: Math.max(s.maxVisitedStep, step) });
  },

  back: () => {
    const s = get();
    if (s.status !== 'active') return;
    set({ step: Math.max(s.step - 1, 0) });
  },

  goTo: (step) => {
    const s = get();
    if (s.status !== 'active') return;
    if (step < 0 || step > s.maxVisitedStep || step === s.step) return;
    set({ step });
  },

  skip: () => {
    const s = get();
    if (s.status !== 'active' && s.status !== 'pending') return;
    set({ status: 'skipped' });
  },

  resume: () => {
    const s = get();
    if (s.status !== 'skipped' && s.status !== 'pending') return;
    // The Sidebar "Resume setup" button is the only caller, so a resume is a
    // COLD re-entry after the user skipped/parked and moved on. The wizard-
    // Configure pointer steps (6-8) anchor the session-start screen, which is
    // the first thing gone once the wizard closes — resuming onto a vanished
    // anchor renders a disconnected, floating coachmark. Rebuild like the boot
    // path: fall back to step 5 (its precondition reopens the wizard) and reset
    // maxVisited so dots can't jump straight back onto the still-missing
    // anchors. Steps 9-10 keep their step (the /ship coachmark's Continue escape
    // and the always-present rail anchor cover a missing target), and modal
    // steps never disconnect.
    if (s.step >= 6 && s.step <= 8) {
      set({ status: 'active', step: 5, maxVisitedStep: 5 });
      return;
    }
    set({ status: 'active', step: s.step });
  },

  dismiss: () => {
    const s = get();
    if (s.status !== 'skipped' && s.status !== 'pending') return;
    // Keep the step so the persisted snapshot + telemetry record where the user
    // walked away; completed short-circuits hydrate regardless of step.
    set({ status: 'completed' });
  },

  finish: () => set({ status: 'completed' }),

  restart: () => get().begin(true),

  setDetection: (detection) => set({ detection }),
  setConnected: (connected) => set({ connected }),
  setCodexDetection: (codexDetection) => set({ codexDetection }),
  setCodexConnected: (codexConnected) => set({ codexConnected }),
  setPermMode: (permMode) => set({ permMode }),

  anchorActioned: () => {
    const s = get();
    if (s.status !== 'active' || !isDoStep(s.step)) return;
    if (s.step === 5) {
      // The card click flips the wizard to Configure, where step 6's anchor
      // (the runtime selector) mounts — advance directly.
      set({ step: 6, maxVisitedStep: Math.max(s.maxVisitedStep, 6) });
      return;
    }
    if (s.step === 10) {
      // Human review opens immediately on the click — straight to the rail map.
      set({ step: 11, maxVisitedStep: Math.max(s.maxVisitedStep, 11) });
      return;
    }
    // Step 9: the /ship click hands control to the idea modal; the overlay
    // goes quiet until 'workflow-run-started' lands.
    set({ status: 'pending' });
  },

  realEvent: (kind) => {
    const s = get();
    if (s.status !== 'active' && s.status !== 'pending') return;
    const advanceTo = (step: number): void =>
      set({ status: 'active', step, maxVisitedStep: Math.max(s.maxVisitedStep, step) });
    if (kind === 'project-created' && s.step === 4) advanceTo(5);
    // The launch may fire from ANY Configure-page step — the user can hit
    // Start quick session before Next-ing through every pointer.
    else if (kind === 'quick-session-created' && s.step >= 5 && s.step <= 8) advanceTo(9);
    else if (kind === 'workflow-run-started' && s.step === 9) advanceTo(10);
  },
}));
