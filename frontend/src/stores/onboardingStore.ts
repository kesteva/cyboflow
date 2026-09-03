import { create } from 'zustand';
import type { AgentProvider } from '../../../shared/types/agentRuntime';
import type { ProviderDetectionResult } from '../../../shared/types/onboarding';
import type { ReasoningEffort } from '../../../shared/types/reasoningEffort';
import type { PermissionMode } from '../../../shared/types/workflows';
import {
  ONBOARDING_ADD_PROJECT_STEP,
  ONBOARDING_ASSISTANT_RAIL_STEP,
  ONBOARDING_ASSISTANT_STEPS,
  ONBOARDING_DEFAULT_RUNTIME_STEP,
  ONBOARDING_FIRST_SESSION_STEP,
  ONBOARDING_HANDOFF_STEP,
  ONBOARDING_LAUNCHING_STEP,
  ONBOARDING_PROJECT_DETAIL_STEP,
  ONBOARDING_PROJECT_HOME_STEP,
  ONBOARDING_STEP_COUNT,
} from '../utils/onboarding';

/**
 * onboardingStore — the 15-step first-run tour's state machine, in three phases.
 *
 * Modal-card steps (the app shell is unmounted; a card sits over bare paper):
 *   0 welcome · 1 connect an agent provider (the only gated step) · 2 default
 *   agent (CONDITIONAL — shown only when step 1 left 2+ of {claude, codex}
 *   activated) · 3 model + reasoning effort · 4 permission mode · 5 telemetry
 *   consent · 6 handoff ("You're set up" — continue, or finish here).
 * Guided set-up, bare paper (full-window surface inside the shell row):
 *   7 add a project (existing / new / not sure yet) · 8 the folder picker or the
 *   create form, per the step-7 choice.
 * Guided set-up, IN the shell (the project now exists; the Sidebar is mounted
 * and inert beside the guided column, the AgentRail joins at 12):
 *   9 "your project lives here" · 10 first idea composer (CONDITIONAL, assistant
 *   on) · 11 the assistant's idea proposals (CONDITIONAL) · 12 meet the assistant
 *   rail (CONDITIONAL) · 13 launch your first session (planner / ship / quick) ·
 *   14 "launching your session now" — every exit lands on Human review.
 *
 * The machine is PURE — all persistence (user_preferences JSON snapshot),
 * detection fetches, config writes, keyboard handling, and the project-create
 * IPC live in components/onboarding (OnboardingGate for the modal steps,
 * guided/ for the set-up surface). Keep it that way: every transition here must
 * stay synchronously testable.
 *
 * Advancement rules:
 * - Every step advances via next() (there are no advance-by-doing coach steps
 *   and no 'pending' park any more — both were removed with the coachmark tour).
 *   Step 1 refuses until the Claude or Codex probe says 'detected' AND its
 *   consent toggle is on.
 * - Step 2 (default agent) is the one CONDITIONAL step: it only has a question
 *   to ask when step 1 left more than one of {claude, codex} activated, so
 *   next()/back() step OVER it otherwise (see isStepSkipped) and goTo() refuses
 *   to land on it. The decision is recomputed on every departure from step 1, so
 *   flipping a second provider on and pressing Continue brings the step back.
 *   OMP never counts toward it — it is activatable on Connect but no picker
 *   offers its runtimes (see defaultAgentCandidates).
 * - One branch terminates the tour early from next(): the handoff step with
 *   handoffChoice 'skip' lands 'completed', which mounts the shell on
 *   LandingHome.
 * - The add-project step with projectChoice 'unsure' skips step 8 and walks
 *   straight into the in-shell screens (9+) with guidedProject still null —
 *   the surface renders their no-project variants ("your projects will live
 *   here", "what do you want to get done with Cyboflow?").
 * - Step 8 never advances via next() — the guided create handler calls
 *   projectAdded() after the project lands (it also has side effects the store
 *   must not own), which records the project and moves to step 9.
 * - Steps 10-12 are CONDITIONAL on the global assistant being enabled
 *   (assistantAvailable); with it off, next() from 9 lands on 13.
 * - "Skip — I'll add ideas later" on 10/11 is skipIdeas(): straight to 12, the
 *   tour continues. Step 13 advances only via sessionLaunched() (the launch
 *   handler owns the async work); step 14 exits via finish() alone.
 * - back() is inert from step 9 on: the project exists, there is nothing to
 *   walk back into (the screens carry no Back button).
 * - skip() parks the tour ('skipped') from ANY step — the Sidebar "Resume
 *   setup" card brings it back at the same step (resume(), warm). From step 9
 *   on the Sidebar is clickable: navigating away also parks it (see
 *   guided/guidedNavPause.ts).
 * - Dots/keyboard may only revisit steps already reached (maxVisitedStep), and
 *   dots exist only on the modal steps; the guided screens carry their own Back.
 */

export type OnboardingStatus = 'idle' | 'active' | 'skipped' | 'completed';

/**
 * The statuses a PRE-v4 snapshot could carry. 'pending' was the coachmark tour's
 * park state (a do-step waiting on a real-world action); the coach steps are
 * gone, so v4 has no such status and the migration folds it into 'skipped'.
 */
type LegacyPersistedStatus = Exclude<OnboardingStatus, 'idle'> | 'pending';

/** JSON shape persisted under ONBOARDING_PREF_KEY — version 1 (pre-Telemetry-step). */
export interface PersistedOnboardingV1 {
  version: 1;
  status: LegacyPersistedStatus;
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
  status: LegacyPersistedStatus;
  step: number;
}

/**
 * JSON shape persisted under ONBOARDING_PREF_KEY — version 3. Same shape again;
 * the Default-agent step's insertion at index 2 (after Connect) shifted every
 * step from the old index 2 onward forward by one. The user's ANSWER is not
 * persisted here — it goes straight to `AppConfig.defaultAgentRuntime`, the
 * field every launch already resolves through.
 */
export interface PersistedOnboardingV3 {
  version: 3;
  status: LegacyPersistedStatus;
  step: number;
}

/**
 * JSON shape persisted under ONBOARDING_PREF_KEY — version 4 (current). The
 * restructure replaced the six coachmark steps + the rail map with the Model
 * step (new index 3), the handoff step, and the two guided set-up screens; the
 * 13-step tour became 9. Status 'pending' no longer exists.
 */
export interface PersistedOnboardingV4 {
  version: 4;
  status: Exclude<OnboardingStatus, 'idle'>;
  step: number;
}

/** JSON shape persisted under ONBOARDING_PREF_KEY (any schema version). */
export type PersistedOnboarding =
  | PersistedOnboardingV1
  | PersistedOnboardingV2
  | PersistedOnboardingV3
  | PersistedOnboardingV4;

/**
 * Version-1 → version-2 step-index remap: the Telemetry step was inserted at
 * index 3 (after Permission, before Add project), so every old step at or
 * after index 3 now lives one index higher.
 */
export function migrateV1StepIndex(step: number): number {
  return step >= 3 ? step + 1 : step;
}

/**
 * Version-2 → version-3 step-index remap: the Default-agent step was inserted at
 * index 2 (after Connect), so every v2 step at or after index 2 lives one index
 * higher. Composed AFTER migrateV1StepIndex for a v1 snapshot — a v1 index has
 * to become a v2 index before this remap means anything.
 */
export function migrateV2StepIndex(step: number): number {
  return step >= ONBOARDING_DEFAULT_RUNTIME_STEP ? step + 1 : step;
}

/**
 * Version-3 → version-4 step-index remap. Unlike the two before it this is not a
 * shift: the Model step took index 3 (pushing Permission and Telemetry forward
 * by one), and everything from the old Add-project step onward — the old
 * add-project modal, the six coachmark steps, the rail map — was deleted
 * outright. Those positions have no v4 counterpart, so they all land on the
 * handoff step (6): the last modal card, from which the user can either walk
 * into the guided set-up or finish.
 */
export function migrateV3StepIndex(step: number): number {
  if (step <= 2) return step; // welcome / connect / default agent — unmoved
  if (step === 3) return 4; // v3 permission → v4 permission
  if (step === 4) return 5; // v3 telemetry → v4 telemetry
  return ONBOARDING_HANDOFF_STEP; // v3 add-project (5) through rail map (12)
}

/**
 * Normalizes a persisted snapshot to the current (version 4) shape.
 * - version 4 snapshots pass through unchanged (already-current schema).
 * - snapshots with status 'completed' keep their step as-is — a completed
 *   onboarding's step index carries no further navigational meaning (hydrate
 *   short-circuits on status alone), so remapping it would be a no-op at best
 *   and is skipped entirely to avoid ever "breaking" a completed snapshot.
 * - older snapshots in any other status are walked forward one version at a
 *   time (v1 → v2 → v3 → v4) before the store ever sees them, and the retired
 *   'pending' status folds into 'skipped' (the Sidebar resume card's state).
 */
export function migratePersistedOnboarding(persisted: PersistedOnboarding): PersistedOnboardingV4 {
  if (persisted.version === 4) return persisted;
  const status = persisted.status === 'pending' ? 'skipped' : persisted.status;
  if (status === 'completed') {
    return { version: 4, status: 'completed', step: persisted.step };
  }
  let step = persisted.step;
  if (persisted.version === 1) step = migrateV1StepIndex(step);
  if (persisted.version <= 2) step = migrateV2StepIndex(step);
  step = migrateV3StepIndex(step);
  return { version: 4, status, step };
}

/**
 * Boot clamp for a restart mid-tour. Every guided screen past the branch choice
 * needs one: step 8 renders the picker or the create form per a branch choice
 * (projectChoice) that is deliberately NOT persisted, and steps 9-14 render
 * around a project (guidedProject) that is not persisted either — so a cold
 * re-entry there has nothing to render and resumes at step 7, where the choice
 * is made. Everything else keeps its step; out-of-range values clamp into the
 * tour's window.
 */
export function clampResumeStep(step: number): number {
  if (step >= ONBOARDING_PROJECT_DETAIL_STEP && step < ONBOARDING_STEP_COUNT) {
    return ONBOARDING_ADD_PROJECT_STEP;
  }
  return Math.min(Math.max(step, 0), ONBOARDING_STEP_COUNT - 1);
}

/** Step-13 radio — which first session to launch. */
export type SessionChoice = 'planner' | 'ship' | 'quick';

/** The project the guided set-up added (steps 9-14 render around it). */
export interface GuidedProject {
  id: number;
  name: string;
}

/** What step 13 launched — step 14 renders its status and can open it. */
export interface LaunchedSession {
  kind: SessionChoice;
  /** The host session (quick session, or the flow run's host). */
  sessionId: string;
  /** The workflow run id for planner/ship; null for a quick session. */
  runId: string | null;
}

interface OnboardingState {
  status: OnboardingStatus;
  /** Current step, 0..8 — meaningful whenever status !== 'idle'. */
  step: number;
  /** Highest step ever reached this run; dots/goTo may only jump ≤ this. */
  maxVisitedStep: number;
  /** True when launched from Settings → Replay walkthrough. */
  replay: boolean;
  /** Latest providers:detect('claude') result; null = probe not yet run (step 1 shows loading). */
  detection: ProviderDetectionResult<'claude'> | null;
  /** Step-1 consent toggle ("use this install for every session"). */
  connected: boolean;
  /** Latest providers:detect('codex') result; null = probe not yet run. */
  codexDetection: ProviderDetectionResult<'codex'> | null;
  /** Step-1 consent toggle for the ChatGPT-authenticated Codex runtime. */
  codexConnected: boolean;
  /**
   * Latest providers:detect('omp') result; null = probe not yet run. OMP is an
   * OPTIONAL row on step 1 — unlike claude/codex it never participates in
   * isNextGateBlocked, since its runtimes are not yet offered by any picker
   * (RUNTIME_CAPABILITIES.selectableInPickers), so "connected" here means only
   * "the provider-access toggle will be turned on", not "ready to launch".
   */
  ompDetection: ProviderDetectionResult<'omp'> | null;
  /**
   * Step-1 consent toggle for OMP. Defaults false and STAYS false unless the
   * user explicitly opts in — mirrors AGENT_PROVIDER_REGISTRY.omp.defaultEnabled
   * (absent access-map key floors to disabled for OMP, unlike claude/codex) so
   * onboarding never turns a provider on that a fresh install would otherwise
   * leave off.
   */
  ompConnected: boolean;
  /** Step-4 selection; 'auto' preselected per design, persisted to config on step-4 next(). */
  permMode: PermissionMode;
  /**
   * Step-2 selection — which ACTIVATED provider new sessions should default to.
   * null = not yet resolved (the gate seeds it from the persisted
   * `defaultAgentRuntime`, else the single candidate, on entry).
   */
  defaultProvider: AgentProvider | null;
  /**
   * Whether step 2 (default agent) is part of THIS run of the tour. Recomputed
   * every time the user leaves the Connect step: the question only exists when
   * more than one of {claude, codex} came out of it activated. Starts true so the
   * early steps show the full tour and the count only ever shrinks on an explicit
   * action, never mid-probe.
   */
  multiRuntime: boolean;
  /**
   * Step-3 model selection, in the effective provider's own id space (a Claude
   * alias like 'opus', or a Codex catalog id / 'auto'). null = not yet seeded.
   */
  defaultModel: string | null;
  /** Step-3 reasoning-effort selection, on the effective provider's scale. */
  defaultEffort: ReasoningEffort | null;
  /**
   * Step 3 asks two questions on one card: the model list first, then the effort
   * list once a model is picked ('effort' also renders the chosen model as a
   * single row with a CHANGE affordance back to 'model').
   */
  modelPhase: 'model' | 'effort';
  /** Step-6 radio: walk into the guided set-up, or finish the tour here. */
  handoffChoice: 'continue' | 'skip';
  /** Step-7 radio: which step-8 screen to render, or continue without a project. */
  projectChoice: 'existing' | 'new' | 'unsure';
  /**
   * The project step 8 created — set by projectAdded(), read by every screen
   * from 9 on (copy names it; step 13 seeds its backlog; every exit navigates to
   * it). Stays null on the 'unsure' branch, where the same screens render their
   * no-project variants. NOT persisted: a cold boot never resumes past step 7
   * (clampResumeStep).
   */
  guidedProject: GuidedProject | null;
  /**
   * Whether the global assistant is enabled (Settings → Assistant) and so
   * whether steps 10-12 are part of THIS run. Seeded true; the guided surface
   * stamps the real value from config on entry to step 9.
   */
  assistantAvailable: boolean;
  /** Step-13 radio: which first session to launch. */
  sessionChoice: SessionChoice;
  /** What step 13 launched; set by sessionLaunched(), rendered by step 14. */
  launched: LaunchedSession | null;
  /** Boot gate resolved — render nothing until true (no-flash rule, docs/CODE-PATTERNS.md). */
  hydrated: boolean;

  /**
   * Resolve the boot gate. `persisted` is the parsed pref snapshot (null on a
   * pristine install); `projectsCount` decides the pristine branch: existing
   * installs (projects > 0) are marked completed without ever seeing the tour.
   * It is consulted ONLY when `persisted === null`, so the caller may pass 0
   * without fetching the project list whenever a snapshot exists.
   */
  hydrate: (persisted: PersistedOnboarding | null, projectsCount: number) => void;
  /** Start (or restart) the tour at step 0. */
  begin: (replay: boolean) => void;
  next: () => void;
  back: () => void;
  /** Dot navigation — only to steps already visited. */
  goTo: (step: number) => void;
  skip: () => void;
  /** Skipped → active at the current (clamped) step. */
  resume: () => void;
  /**
   * Permanent dismiss from the Sidebar "Resume setup" card: skipped →
   * completed. Unlike skip() (which leaves the resume affordance standing),
   * dismiss() closes the tour for good — the completed snapshot persists, so it
   * never reappears on future boots. Recoverable only via Settings → Replay
   * walkthrough (restart()).
   */
  dismiss: () => void;
  /**
   * Step 8's exit: the project landed. Records it and moves to step 9 (the
   * first in-shell screen). The create handler is the one caller (step 8 has
   * no next()); it stamps the active project in navigationStore FIRST, so the
   * Sidebar the step-9 shell mounts never auto-selects a different view.
   */
  projectAdded: (project: GuidedProject) => void;
  /**
   * The "Not sure yet" branch caught up: a project was created (Sidebar "Add
   * Project") while the in-shell screens were running without one. Records it
   * so the remaining screens switch to their with-project variants; the step
   * does not move. No-op when a project is already recorded or before step 9.
   */
  projectAdopted: (project: GuidedProject) => void;
  /**
   * "Skip — I'll add ideas later" on steps 10/11: jump to the rail intro (12).
   * The tour continues (unlike skip(), which ends it) — the user only declined
   * the idea capture, not the rest of the set-up.
   */
  skipIdeas: () => void;
  /**
   * Step 13's exit: the launch handler resolved. Records what launched and moves
   * to step 14, which renders its status. Step 13 has no next().
   */
  sessionLaunched: (launched: LaunchedSession) => void;
  /**
   * Terminal completion. Every exit from steps 9-14 (skip links, "Finish
   * without launching", the two step-14 buttons) reaches it — after the
   * caller staged the shell side effects (see guided/guidedFinish.ts).
   */
  finish: () => void;
  /** Settings → Replay walkthrough. */
  restart: () => void;
  setDetection: (result: ProviderDetectionResult<'claude'> | null) => void;
  setConnected: (connected: boolean) => void;
  setCodexDetection: (result: ProviderDetectionResult<'codex'> | null) => void;
  setCodexConnected: (connected: boolean) => void;
  setOmpDetection: (result: ProviderDetectionResult<'omp'> | null) => void;
  setOmpConnected: (connected: boolean) => void;
  setPermMode: (mode: PermissionMode) => void;
  setDefaultProvider: (provider: AgentProvider | null) => void;
  setDefaultModel: (model: string | null) => void;
  setDefaultEffort: (effort: ReasoningEffort | null) => void;
  setModelPhase: (phase: 'model' | 'effort') => void;
  setHandoffChoice: (choice: 'continue' | 'skip') => void;
  setProjectChoice: (choice: 'existing' | 'new' | 'unsure') => void;
  setAssistantAvailable: (available: boolean) => void;
  setSessionChoice: (choice: SessionChoice) => void;
}

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

/** The state slice the provider helpers below read. */
type ProviderSlice = Pick<
  OnboardingState,
  'detection' | 'connected' | 'codexDetection' | 'codexConnected' | 'ompDetection' | 'ompConnected'
>;

/**
 * The providers the Connect step left ACTIVATED — probe green AND consent
 * toggle on. Deliberately stricter than the access map the step persists (which
 * carries the raw toggle): a provider whose binary vanished since the last run
 * seeds its toggle back on from config but is not something we should offer as
 * "your default agent". Returned in AGENT_PROVIDERS order so the step's rows and
 * the fallback selection agree.
 */
export function activatedProviders(state: ProviderSlice): AgentProvider[] {
  const out: AgentProvider[] = [];
  if (state.detection?.state === 'detected' && state.connected) out.push('claude');
  if (state.codexDetection?.state === 'detected' && state.codexConnected) out.push('codex');
  if (state.ompDetection?.state === 'detected' && state.ompConnected) out.push('omp');
  return out;
}

/**
 * The activated providers that can actually BE a default agent — claude and
 * codex only. OMP is activatable on Connect (its access-map key is written) but
 * no launch picker offers its runtimes yet, so it is neither a row on the
 * Default-agent step nor a reason to show that step at all. This is the list the
 * step renders and the count `multiRuntime` is decided from.
 */
export function defaultAgentCandidates(state: ProviderSlice): Array<'claude' | 'codex'> {
  return activatedProviders(state).filter(
    (p): p is 'claude' | 'codex' => p === 'claude' || p === 'codex',
  );
}

/** The state slice the skip helpers read. */
type SkipSlice = Pick<OnboardingState, 'multiRuntime' | 'assistantAvailable'>;

/**
 * Whether `step` is skipped for this run. Two conditional groups: the
 * Default-agent step (a single activated candidate leaves it with no question
 * to ask) and the three assistant steps (10-12, meaningless with the global
 * assistant disabled). Every navigation path steps over a skipped step and the
 * progress numbering drops it.
 */
export function isStepSkipped(step: number, state: SkipSlice): boolean {
  if (step === ONBOARDING_DEFAULT_RUNTIME_STEP) return !state.multiRuntime;
  if (ONBOARDING_ASSISTANT_STEPS.includes(step)) return !state.assistantAvailable;
  return false;
}

// Stable identities: the gate feeds these straight into React props, so a fresh
// Set per render would re-run every memo downstream. One constant per
// combination of the two conditions.
const EMPTY_SKIPPED: ReadonlySet<number> = new Set<number>();
const DEFAULT_RUNTIME_SKIPPED: ReadonlySet<number> = new Set([ONBOARDING_DEFAULT_RUNTIME_STEP]);
const ASSISTANT_SKIPPED: ReadonlySet<number> = new Set(ONBOARDING_ASSISTANT_STEPS);
const BOTH_SKIPPED: ReadonlySet<number> = new Set([
  ONBOARDING_DEFAULT_RUNTIME_STEP,
  ...ONBOARDING_ASSISTANT_STEPS,
]);

/** The set of skipped indices, for the progress-numbering helpers. */
export function skippedStepSet(state: SkipSlice): ReadonlySet<number> {
  if (state.multiRuntime) return state.assistantAvailable ? EMPTY_SKIPPED : ASSISTANT_SKIPPED;
  return state.assistantAvailable ? DEFAULT_RUNTIME_SKIPPED : BOTH_SKIPPED;
}

/**
 * The next/previous index that is not skipped, or null when the walk runs off
 * the end of the tour. `dir` is +1 or -1.
 */
function stepAfter(step: number, dir: 1 | -1, state: SkipSlice): number | null {
  for (let i = step + dir; i >= 0 && i < ONBOARDING_STEP_COUNT; i += dir) {
    if (!isStepSkipped(i, state)) return i;
  }
  return null;
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  status: 'idle',
  step: 0,
  maxVisitedStep: 0,
  replay: false,
  detection: null,
  connected: false,
  codexDetection: null,
  codexConnected: false,
  ompDetection: null,
  ompConnected: false,
  permMode: 'auto',
  defaultProvider: null,
  multiRuntime: true,
  defaultModel: null,
  defaultEffort: null,
  modelPhase: 'model',
  handoffChoice: 'continue',
  projectChoice: 'existing',
  guidedProject: null,
  assistantAvailable: true,
  sessionChoice: 'planner',
  launched: null,
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
    // Any unfinished state (active/skipped, modal OR guided) resumes as skipped
    // — the Sidebar's Resume card re-enters at the clamped step (a guided step
    // past the branch choice clamps to 7: the branch/project/launch it needs
    // were never persisted), so a boot never drops the user back into a
    // half-built screen or hides the shell behind a tour they did not re-open.
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
    ompConnected: false,
    ompDetection: null,
    permMode: 'auto',
    defaultProvider: null,
    multiRuntime: true,
    defaultModel: null,
    defaultEffort: null,
    modelPhase: 'model',
    handoffChoice: 'continue',
    projectChoice: 'existing',
    guidedProject: null,
    assistantAvailable: true,
    sessionChoice: 'planner',
    launched: null,
    hydrated: true,
  }),

  next: () => {
    const s = get();
    if (s.status !== 'active') return;
    if (isNextGateBlocked(s)) return;
    // Three steps never advance via next(): step 8 moves on through
    // projectAdded() (the create handler owns the async work and the
    // navigation side effects that must land BEFORE the Sidebar mounts), step
    // 13 through sessionLaunched() (same shape — the launch is async), and step
    // 14 only exits, via finish().
    if (
      s.step === ONBOARDING_PROJECT_DETAIL_STEP ||
      s.step === ONBOARDING_FIRST_SESSION_STEP ||
      s.step === ONBOARDING_LAUNCHING_STEP
    ) {
      return;
    }
    // The one early exit: leaves the tour on LandingHome with no project.
    if (s.step === ONBOARDING_HANDOFF_STEP && s.handoffChoice === 'skip') {
      set({ status: 'completed' });
      return;
    }
    // "Not sure yet" has no project to detail: skip step 8 and continue into
    // the shell with guidedProject null (the screens render their no-project
    // variants).
    if (s.step === ONBOARDING_ADD_PROJECT_STEP && s.projectChoice === 'unsure') {
      set({
        step: ONBOARDING_PROJECT_HOME_STEP,
        maxVisitedStep: Math.max(s.maxVisitedStep, ONBOARDING_PROJECT_HOME_STEP),
      });
      return;
    }
    // Leaving Connect re-decides whether the conditional Default-agent step is
    // part of this run — it must be settled BEFORE the walk below picks a
    // target, or a user who just enabled a second provider would be stepped
    // straight over the question they now qualify for.
    const multiRuntime =
      s.step === 1 ? defaultAgentCandidates(s).length >= 2 : s.multiRuntime;
    const step = stepAfter(s.step, 1, { multiRuntime, assistantAvailable: s.assistantAvailable });
    if (step === null) {
      set({ multiRuntime, status: 'completed' });
      return;
    }
    set({ multiRuntime, step, maxVisitedStep: Math.max(s.maxVisitedStep, step) });
  },

  back: () => {
    const s = get();
    if (s.status !== 'active') return;
    // The in-shell screens (9+) have no Back: the project already exists and
    // step 8 would offer to create it again.
    if (s.step >= ONBOARDING_PROJECT_HOME_STEP) return;
    set({ step: stepAfter(s.step, -1, s) ?? 0 });
  },

  goTo: (step) => {
    const s = get();
    if (s.status !== 'active') return;
    if (step < 0 || step > s.maxVisitedStep || step === s.step) return;
    if (isStepSkipped(step, s)) return; // a dot the tour never renders
    set({ step });
  },

  skip: () => {
    const s = get();
    if (s.status !== 'active') return;
    // Parks the tour at its current step — modal card OR guided screen — so the
    // Sidebar "Resume setup" card can bring it back. Every exit that is not a
    // deliberate completion (Skip links, clicking away into the Sidebar) goes
    // through here; finish() is the terminal one.
    set({ status: 'skipped' });
  },

  resume: () => {
    const s = get();
    if (s.status !== 'skipped') return;
    // WARM re-entry from the Sidebar card: everything a guided step needs
    // (projectChoice, guidedProject, launched) is still in memory, so the tour
    // picks up exactly where it was parked. A COLD re-entry (boot) was already
    // clamped by hydrate() — the persisted snapshot never carries that state.
    set({ status: 'active' });
  },

  dismiss: () => {
    const s = get();
    if (s.status !== 'skipped') return;
    // Keep the step so the persisted snapshot + telemetry record where the user
    // walked away; completed short-circuits hydrate regardless of step.
    set({ status: 'completed' });
  },

  projectAdopted: (project) => {
    const s = get();
    if (s.status !== 'active' || s.guidedProject !== null) return;
    if (s.step < ONBOARDING_PROJECT_HOME_STEP) return;
    set({ guidedProject: project });
  },

  projectAdded: (project) => {
    const s = get();
    if (s.status !== 'active' || s.step !== ONBOARDING_PROJECT_DETAIL_STEP) return;
    set({
      guidedProject: project,
      step: ONBOARDING_PROJECT_HOME_STEP,
      maxVisitedStep: Math.max(s.maxVisitedStep, ONBOARDING_PROJECT_HOME_STEP),
    });
  },

  skipIdeas: () => {
    const s = get();
    if (s.status !== 'active') return;
    if (s.step < ONBOARDING_PROJECT_HOME_STEP || s.step >= ONBOARDING_ASSISTANT_RAIL_STEP) return;
    set({
      step: ONBOARDING_ASSISTANT_RAIL_STEP,
      maxVisitedStep: Math.max(s.maxVisitedStep, ONBOARDING_ASSISTANT_RAIL_STEP),
    });
  },

  sessionLaunched: (launched) => {
    const s = get();
    if (s.status !== 'active' || s.step !== ONBOARDING_FIRST_SESSION_STEP) return;
    set({
      launched,
      step: ONBOARDING_LAUNCHING_STEP,
      maxVisitedStep: Math.max(s.maxVisitedStep, ONBOARDING_LAUNCHING_STEP),
    });
  },

  finish: () => set({ status: 'completed' }),

  restart: () => get().begin(true),

  setDetection: (detection) => set({ detection }),
  setConnected: (connected) => set({ connected }),
  setCodexDetection: (codexDetection) => set({ codexDetection }),
  setCodexConnected: (codexConnected) => set({ codexConnected }),
  setOmpDetection: (ompDetection) => set({ ompDetection }),
  setOmpConnected: (ompConnected) => set({ ompConnected }),
  setPermMode: (permMode) => set({ permMode }),
  setDefaultProvider: (defaultProvider) => set({ defaultProvider }),
  setDefaultModel: (defaultModel) => set({ defaultModel }),
  setDefaultEffort: (defaultEffort) => set({ defaultEffort }),
  setModelPhase: (modelPhase) => set({ modelPhase }),
  setHandoffChoice: (handoffChoice) => set({ handoffChoice }),
  setProjectChoice: (projectChoice) => set({ projectChoice }),
  setAssistantAvailable: (assistantAvailable) => set({ assistantAvailable }),
  setSessionChoice: (sessionChoice) => set({ sessionChoice }),
}));
