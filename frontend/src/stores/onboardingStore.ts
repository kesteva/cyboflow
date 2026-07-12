import { create } from 'zustand';
import type { ClaudeDetectionResult } from '../../../shared/types/onboarding';
import type { PermissionMode } from '../../../shared/types/workflows';
import { ONBOARDING_COACH_STEPS, ONBOARDING_POINTER_STEPS, ONBOARDING_STEP_COUNT } from '../utils/onboarding';

/**
 * onboardingStore — the 11-step first-run tour's state machine.
 *
 * Steps: 0 welcome · 1 connect Claude Code (the only gated step) · 2 permission
 * mode · 3 add project · 4 quick-session coachmark (wizard Quick Session card) ·
 * 5-7 wizard-Configure pointers (session permission / model / substrate) ·
 * 8 /ship coachmark (session canvas chip) · 9 Human-review coachmark ·
 * 10 rail map.
 *
 * The machine is PURE — all persistence (user_preferences JSON snapshot),
 * detection fetches, window-event subscriptions, keyboard handling, and
 * precondition navigation (ensuring the wizard is open when step 4 begins)
 * live in components/onboarding/OnboardingGate. Keep it that way: every
 * transition here must stay synchronously testable.
 *
 * Advancement rules (the tour is completed by DOING, not clicking through):
 * - Modal steps (0,1,2,3,10) advance via next(); step 1 refuses until the
 *   credential probe says 'detected' AND the consent toggle is on; step 3
 *   normally advances via the real 'project-created' event (its primary
 *   button creates the project), falling back to next() when projects
 *   already exist (replay / resumed installs).
 * - Pointer steps (5-7, the Configure trio) are informational: they advance
 *   via next() (the popover's Next button); interacting with the anchored
 *   control never advances them. Next on the LAST pointer (7) parks 'pending'
 *   — the next tour beat (the /ship chip) only exists once the session
 *   launches, and 'quick-session-created' fires from ANY of steps 4-7 (the
 *   user may hit Start before Next-ing through every pointer), landing 8.
 * - Do-steps advance ONLY via the real action: step 4's card click flips the
 *   wizard to Configure where step 5's anchor mounts, so it advances directly;
 *   step 8's /ship click parks 'pending' while the idea modal runs and
 *   'workflow-run-started' lands 9; step 9 advances directly on its click.
 * - Dots/keyboard may only revisit steps already reached (maxVisitedStep),
 *   so neither can bypass the step-1 gate or the coach preconditions.
 * - forceNext() is the anchor-lost escape (see its interface doc): the only way
 *   to move a do-step forward when its target has unmounted.
 */

export type OnboardingStatus = 'idle' | 'active' | 'pending' | 'skipped' | 'completed';

/** Real-world signals the coach steps wait on (see utils/onboarding.ts events). */
export type OnboardingRealEvent = 'project-created' | 'quick-session-created' | 'workflow-run-started';

/** JSON shape persisted under ONBOARDING_PREF_KEY. */
export interface PersistedOnboarding {
  version: 1;
  status: Exclude<OnboardingStatus, 'idle'>;
  step: number;
}

/**
 * Boot clamp for a restart mid-tour: coach steps whose real-world context is
 * gone resume at the nearest step that can rebuild it. Steps 5-7 anchor the
 * wizard's Configure page and step 8 the session canvas — neither survives a
 * restart — so they re-run step 4, which rebuilds its own precondition (the
 * gate reopens the wizard). Step 9's rail anchor always exists.
 */
export function clampResumeStep(step: number): number {
  if (step >= 5 && step <= 8) return 4;
  return Math.min(Math.max(step, 0), ONBOARDING_STEP_COUNT - 1);
}

interface OnboardingState {
  status: OnboardingStatus;
  /** Current step, 0..10 — meaningful whenever status !== 'idle'. */
  step: number;
  /** Highest step ever reached this run; dots/goTo may only jump ≤ this. */
  maxVisitedStep: number;
  /** True when launched from Settings → Replay walkthrough (step 3 shows the existing-project state). */
  replay: boolean;
  /** Latest claude:detect result; null = probe not yet run (step 1 shows loading). */
  detection: ClaudeDetectionResult | null;
  /** Step-1 consent toggle ("use this install for every session"). */
  connected: boolean;
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
   * a do-step (4/8/9) whose target has unmounted (e.g. Back into step 4 after the
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
  finish: () => void;
  /** Settings → Replay walkthrough. */
  restart: () => void;
  setDetection: (result: ClaudeDetectionResult | null) => void;
  setConnected: (connected: boolean) => void;
  setPermMode: (mode: PermissionMode) => void;
  /** The user clicked the highlighted coachmark target (capture-phase listener). */
  anchorActioned: () => void;
  /** A real-action window event landed (OnboardingGate forwards them here). */
  realEvent: (kind: OnboardingRealEvent) => void;
}

const LAST_STEP = ONBOARDING_STEP_COUNT - 1;

/** Step 1 refuses to advance until the probe is green and consent is given. */
export function isNextGateBlocked(state: Pick<OnboardingState, 'step' | 'detection' | 'connected'>): boolean {
  return state.step === 1 && !(state.detection?.state === 'detected' && state.connected);
}

/** Advance-by-doing coach steps (4, 8, 9) — coach steps that are NOT pointers. */
const isDoStep = (step: number): boolean =>
  ONBOARDING_COACH_STEPS.includes(step) && !ONBOARDING_POINTER_STEPS.includes(step);

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  status: 'idle',
  step: 0,
  maxVisitedStep: 0,
  replay: false,
  detection: null,
  connected: false,
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
    if (persisted.status === 'completed') {
      set({ status: 'completed', hydrated: true });
      return;
    }
    // Any mid-tour state (active/pending/skipped) resumes as skipped — the
    // rail's Resume button re-enters at the clamped step, letting the gate
    // rebuild coach preconditions instead of dropping a coachmark on a stale
    // anchor.
    const step = clampResumeStep(persisted.step);
    set({ status: 'skipped', step, maxVisitedStep: step, replay: false, hydrated: true });
  },

  begin: (replay) => set({
    status: 'active',
    step: 0,
    maxVisitedStep: 0,
    replay,
    connected: false,
    detection: null,
    permMode: 'auto',
    hydrated: true,
  }),

  next: () => {
    const s = get();
    if (s.status !== 'active') return;
    if (isDoStep(s.step)) return; // do-steps advance by doing, never by next()
    if (isNextGateBlocked(s)) return;
    // Next on the last Configure pointer parks quiet: step 8's anchor (the
    // /ship chip) only exists once the session launches, so the tour waits for
    // 'quick-session-created' — unless the session already exists (revisiting
    // via dots/Back), where a plain advance is safe.
    if (s.step === 7 && s.maxVisitedStep < 8) {
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
    // Configure pointer steps (5-7) anchor the session-start screen, which is
    // the first thing gone once the wizard closes — resuming onto a vanished
    // anchor renders a disconnected, floating coachmark. Rebuild like the boot
    // path: fall back to step 4 (its precondition reopens the wizard) and reset
    // maxVisited so dots can't jump straight back onto the still-missing
    // anchors. Steps 8-9 keep their step (the /ship coachmark's Continue escape
    // and the always-present rail anchor cover a missing target), and modal
    // steps never disconnect.
    if (s.step >= 5 && s.step <= 7) {
      set({ status: 'active', step: 4, maxVisitedStep: 4 });
      return;
    }
    set({ status: 'active', step: s.step });
  },

  finish: () => set({ status: 'completed' }),

  restart: () => get().begin(true),

  setDetection: (detection) => set({ detection }),
  setConnected: (connected) => set({ connected }),
  setPermMode: (permMode) => set({ permMode }),

  anchorActioned: () => {
    const s = get();
    if (s.status !== 'active' || !isDoStep(s.step)) return;
    if (s.step === 4) {
      // The card click flips the wizard to Configure, where step 5's anchor
      // (the permission selector) mounts — advance directly.
      set({ step: 5, maxVisitedStep: Math.max(s.maxVisitedStep, 5) });
      return;
    }
    if (s.step === 9) {
      // Human review opens immediately on the click — straight to the rail map.
      set({ step: 10, maxVisitedStep: Math.max(s.maxVisitedStep, 10) });
      return;
    }
    // Step 8: the /ship click hands control to the idea modal; the overlay
    // goes quiet until 'workflow-run-started' lands.
    set({ status: 'pending' });
  },

  realEvent: (kind) => {
    const s = get();
    if (s.status !== 'active' && s.status !== 'pending') return;
    const advanceTo = (step: number): void =>
      set({ status: 'active', step, maxVisitedStep: Math.max(s.maxVisitedStep, step) });
    if (kind === 'project-created' && s.step === 3) advanceTo(4);
    // The launch may fire from ANY Configure-page step — the user can hit
    // Start quick session before Next-ing through every pointer.
    else if (kind === 'quick-session-created' && s.step >= 4 && s.step <= 7) advanceTo(8);
    else if (kind === 'workflow-run-started' && s.step === 8) advanceTo(9);
  },
}));
