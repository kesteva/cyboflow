/**
 * SessionStartWizard — the center-pane "Start a new session" index-card wizard.
 *
 * Three steps (① Project · ② Workflow · ③ Configure), switched on
 * `wizardOpts.lockProjectId`:
 *   - UNLOCKED (no lockProjectId): ① pick a project from a grid of
 *     {@link ProjectFilingCard}s (+ an "Add project" card), ② pick a workflow
 *     (or the featured {@link QuickSessionCard}), then ③ configure session
 *     settings and launch.
 *   - LOCKED (lockProjectId set): the project is pinned; the wizard opens
 *     directly on ② Workflow. When `allowQuick` is set, the quick card is offered.
 *
 * Workflow preselect (`wizardOpts.preselectWorkflowName`): the Insights "Run
 * compounding session" CTA opens the wizard with an explicit workflow name (e.g.
 * `'compound'`). When the workflow list loads, the matching flow is preselected
 * BY NAME and the wizard auto-advances ② → ③ EXACTLY ONCE (latched by
 * `preselectConsumedRef`) so the caller lands directly on the launch surface
 * without fighting later list reloads or user back-navigation. In unlocked mode
 * the advance naturally fires once the user picks a project (loadWorkflows runs
 * on step ②). This is distinct from the implicit DEFAULT_WORKFLOW_NAME preselect,
 * which only sets selection state and NEVER auto-advances.
 *
 * Step ③ (Configure) is the launch surface and adapts to the selection:
 *   - workflow: agent-permission override + agent runtime (+ caveats) + model
 *     pin (default Opus, threaded into runs.start → workflow_runs.model) + workflow
 *     blueprint editor access + a launch summary.
 *   - quick: agent-permission override + agent runtime (+ caveats) + model pin
 *     (+ the Opus-only fast-mode toggle) + launch summary (there is no workflow to
 *     edit, so the blueprint editor is omitted).
 *   - design: agent-permission override + model pin + launch summary ONLY — the
 *     agent-runtime picker is HIDDEN (design sessions are hard-pinned to the
 *     Claude SDK substrate, see below) and there is no fidelity control in v0
 *     (design-mode.md "Scope and phasing" — static-only until v1).
 *
 * Launch paths (all fire from step ③):
 *   - workflow: `trpc.cyboflow.runs.start.mutate` (threading substrate +
 *     permissionMode) → setActiveRun → goToSession. The Planner ('planner') AND
 *     the Ship ('ship') flow are gated behind {@link IdeaPickerModal} (both are
 *     IDEA-seeded; Ship runs planner ⊕ sprint in one continuous run and selects
 *     the executable task subset later, at the in-run approve-plan gate); the
 *     chosen idea id is threaded as runs.start.mutate({ ideaId }).
 *   - sprint: gated behind {@link TaskBatchPickerModal} — a sprint is ONE
 *     session-hosted run seeded with the multi-selected task ids (single-run
 *     lane model; the orchestrator agent fans the tasks out as subagents in the
 *     shared session worktree), so it follows the same runs.start → setActiveRun
 *     → goToSession path with `taskIds` threaded.
 *   - quick: the {@link useQuickSession} hook — it creates the session + panels
 *     (passing the chosen agentPermissionMode + substrate) and calls
 *     setActiveQuickSession itself.
 *   - design: also gated behind {@link IdeaPickerModal} (single-select — a
 *     design session is idea-bound, design-mode.md "Idea link"), then the SAME
 *     {@link useQuickSession} hook as `quick`, but with the substrate/provider/
 *     runtime hard-coded to 'sdk'/'claude'/'claude-sdk' regardless of the
 *     wizard's agentRuntime state (a security boundary — the MCP scope
 *     mechanism that limits a design session's toolset exists only on the SDK
 *     path), the picked idea id threaded as the new `designIdeaId` param, and
 *     `DESIGN_KICKOFF_PROMPT` threaded as `kickoffPrompt` (design-mode.md
 *     v0.5 "Auto-start") so the session's first turn is sent automatically.
 *     Its `onSuccess` additionally calls `useDesignModeStore.enterDesignMode`
 *     (gated by `isDesignLaunchRef`, set by `launchDesign`) so the wizard
 *     lands directly in the fullscreen design surface.
 *   - launch ('launch', the interview-driven super-planner): gated behind
 *     {@link LaunchPromptModal} — a free-text "what are you trying to build?"
 *     answer grounds the interview's first turn; the trimmed answer is
 *     threaded as runs.start.mutate({ seedPrompt }), same launchRun path as
 *     Planner/Ship.
 *
 * A synchronous in-flight latch (`startInFlightRef`) guards every launch against
 * the double-submit duplicate-run bug (mirrors WorkflowPicker).
 *
 * The whole surface is monospace, mostly square-cornered, on a faint graph-paper
 * grid; UI labels are UPPERCASE wide-tracked.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../../../shared/types/trpc';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';
import type { Project } from '../../../types/project';
import { useNavigationStore } from '../../../stores/navigationStore';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import { useConfigStore } from '../../../stores/configStore';
import { useQuickSession } from '../../../hooks/useQuickSession';
import { useSeededSelection } from '../../../hooks/useSeededSelection';
import {
  useSaveRunTypeDefault,
  SAVE_DEFAULT_TOAST_MS,
} from '../../../hooks/useSaveRunTypeDefault';
import { useDesignModeStore } from '../../../stores/designModeStore';
import { DESIGN_KICKOFF_PROMPT } from '../design/designKickoff';
import { ensureSessionForLaunch } from '../../../utils/ensureSessionForLaunch';
import { IdeaPickerModal } from '../IdeaPickerModal';
import { TaskBatchPickerModal } from '../TaskBatchPickerModal';
import { LaunchPromptModal } from '../LaunchPromptModal';
import { CreateProjectDialog } from '../../CreateProjectDialog';
import { AgentPermissionModeSelector, PERMISSION_MODE_OPTIONS } from '../AgentPermissionModeSelector';
import { SubstrateSelector } from '../SubstrateSelector';
import { ModelSelector, DEFAULT_CODEX_MODEL, DEFAULT_QUICK_MODEL, ULTRACODE_DEFAULT_MODEL } from '../ModelSelector';
import { useModelAvailability } from '../../../stores/modelAvailabilityStore';
import { VariantSelector } from '../VariantSelector';
import { variantSelectionToStartInput, type VariantSelection } from '../variantSelectorLogic';
import { isOpusModel, modelDisplayLabel } from '../unified/ModelPill';
import {
  effortLevelsForProvider,
  isValidEffortForProvider,
  type ReasoningEffort,
} from '../../../../../shared/types/reasoningEffort';
import { McpTogglePill } from '../unified/McpTogglePill';
import { PluginTogglePill } from '../unified/PluginTogglePill';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../../utils/cn';
import { sameStringSet } from '../../../utils/sameStringSet';
import { Switch } from '../../ui/Switch';
import { Button } from '../../ui/Button';
import { WorkflowEditorModal } from '../WorkflowEditorModal';
import { SessionActionToast } from '../SessionActionToast';
import { WizardStepHeader } from './WizardStepHeader';
import type { WizardStep } from './WizardStepHeader';
import { ProjectFilingCard } from './ProjectFilingCard';
import { WorkflowListRow } from './WorkflowListRow';
import { QuickSessionCard } from './QuickSessionCard';
import { UltracodeCard } from './UltracodeCard';
import { DesignCard } from './DesignCard';
import { buildWorkflowMeta, DEFAULT_WORKFLOW_NAME, launcherWorkflowMetas } from './workflowMeta';
import type { WorkflowCardMeta } from './workflowMeta';
import { DEFAULT_SUBSTRATE } from '../../../../../shared/types/substrate';
import { isCodexModelFamily, isCodexModelSelection } from '../../../../../shared/types/agentModels';
import {
  AGENT_RUNTIME_LABELS,
  DEFAULT_SESSION_AGENT_RUNTIME,
  claudeRuntimeFromSubstrate,
  isSessionAgentRuntime,
} from '../../../../../shared/types/agentRuntime';
import {
  runtimeSupportsEffort,
  runtimeSupportsFastMode,
} from '../../../../../shared/types/agentCapabilities';
import {
  DEFAULT_PERMISSION_MODE,
  QUICK_RUN_TYPE_KEY,
  resolveRunTypeLaunchDefaults,
  workflowRunTypeKey,
  type RunTypeLaunchGlobals,
} from '../../../../../shared/types/sessionDefaults';
import type { LaunchAgentRuntime } from '../agentRuntimeUi';
import {
  isCodexRuntime,
  launchRuntimeForPickers,
  providerForRuntime,
  quickSessionRuntimeForLaunch,
  substrateForRuntime,
  workflowRuntimeForLaunch,
} from '../agentRuntimeUi';
import type { ExecutionModel } from '../../../../../shared/types/executionModel';
import { isMixedProviderOrchestratedError } from '../../../../../shared/types/executionModelErrors';
import type { QuickSessionWorktreeMode } from '../../../../../shared/types/worktreeMode';
import { trackEvent } from '../../../utils/telemetry';
import {
  CYBOFLOW_WORKFLOW_NAMES,
  type PermissionMode,
} from '../../../../../shared/types/workflows';
import type { TelemetryFlow } from '../../../../../shared/types/telemetry';
import {
  notifyQuickSessionCreated,
  notifyWorkflowRunStarted,
  ONBOARDING_ANCHOR_ATTR,
  ONBOARDING_ANCHORS,
} from '../../../utils/onboarding';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouterOutputs = inferRouterOutputs<AppRouter>;
/** The result of `cyboflow.runs.start` — inferred, never a local mirror. */
type RunStartResult = RouterOutputs['cyboflow']['runs']['start'];

/**
 * What the user has chosen on the workflow step. `null` until a row (or the
 * quick card) is selected. The union is explicit so the CTA + launch dispatch
 * narrow exhaustively.
 */
type WizardSelection =
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'quick' }
  // Ultracode: opens an interactive session launched with the ultracode setting
  // (no structured run). Behaves like 'quick' at launch but pins the substrate
  // to interactive and threads the effort flag.
  | { kind: 'ultracode' }
  // Design (design-mode.md, v0): idea-bound design session. Does NOT launch
  // directly from the CTA — it gates behind the idea picker (like Planner/Ship)
  // and then starts a quick-session variant hard-pinned to the Claude SDK
  // substrate, threading the picked idea id as `designIdeaId`. See handleStart.
  | { kind: 'design' };

/**
 * The faint graph-paper grid backing the wizard surface. Matches the
 * human-review-queue home (LandingHome) hairline exactly — 35%-alpha #d8cfb8
 * lines on a 24px grid — so the wizard's white focused-paper card reads as the
 * same surface family.
 */
const GRID_BG_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(to right, rgba(216,207,184,0.35) 1px, transparent 1px),' +
    'linear-gradient(to bottom, rgba(216,207,184,0.35) 1px, transparent 1px)',
  backgroundSize: '24px 24px',
};

/**
 * The green hazard-stripe tab that caps the focused-paper card, mirroring
 * {@link CaughtUpHero}. Kept as a module constant so the wizard card and the
 * review-queue hero stay pixel-identical.
 */
const HAZARD_STRIPE_STYLE: React.CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, #2d8a5b 0 8px, #26764e 8px 16px)',
};

/** The dashed "add project" tile fill cue. */
function AddProjectCard({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="wizard-add-project"
      className="flex min-h-[96px] items-center justify-center border border-dashed border-border-emphasized bg-surface-secondary text-text-secondary transition-colors hover:border-interactive hover:text-interactive"
    >
      <span className="eyebrow">＋ Add project</span>
    </button>
  );
}

/** A label/value row in the step-③ launch summary. */
function SummaryRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="eyebrow text-text-muted">{label}</span>
      <span className="truncate font-mono text-xs text-text-primary" title={value}>
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SessionStartWizard(): React.JSX.Element {
  const opts = useNavigationStore((s) => s.wizardOpts);
  const locked = opts?.lockProjectId != null;
  // Quick session is offered whenever the caller opts in — in BOTH locked mode
  // (rail "+ NEW FLOW", pinned project) and the unlocked center-pane flow (home /
  // review-queue "Start a new session"), where the card appears in step 2 once a
  // project is chosen. Not tied to `locked`, so the unlocked path can offer it.
  const allowQuick = opts?.allowQuick === true;
  // Selected finding ids carried by the Insights triage tray CTA. Threaded into
  // runs.start as `findingIds` ONLY when the launched flow is `compound` (the
  // seed is compound-only); see launchRun. Read off the live store via the
  // launchRun dep array so the launch closure never captures a stale set.
  const selectedFindingIds = opts?.selectedFindingIds;

  // Step state. Locked mode opens on ② Workflow (project pinned); unlocked opens
  // on ① Project. ③ Configure is the shared launch step.
  const [step, setStep] = useState<WizardStep>(locked ? 2 : 1);

  // ── Project step (unlocked) ──────────────────────────────────────────────
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // The active project: pinned (locked) or chosen on step 1 (unlocked).
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(
    locked ? (opts?.lockProjectId ?? null) : null,
  );

  // ── Workflow step ────────────────────────────────────────────────────────
  const [workflowMetas, setWorkflowMetas] = useState<WorkflowCardMeta[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [selection, setSelection] = useState<WizardSelection | null>(null);

  // ── Step ③ Configure ─────────────────────────────────────────────────────
  // The global quick-session substrate default (floors to 'interactive'), read
  // reactively from the config store. Projected onto a Claude runtime to form the
  // GLOBAL rung of the runtime ladder for quick + ultracode cards, so quick
  // sessions still default to the PTY when nothing per-type is stored.
  const quickDefaultSubstrate = useConfigStore(
    (s) => s.config?.quickSessionDefaultSubstrate ?? 'interactive',
  );
  // Sparse per-launch-type defaults (config.runTypeDefaults), keyed by
  // `workflow:<workflowId>` or the synthetic global `quick` key. Read reactively
  // off the config store — the same read pattern useQuickSession and
  // useLaunchWorkflow use at their launch seams — so a Settings edit re-seeds an
  // open, untouched wizard instead of going stale.
  const runTypeDefaults = useConfigStore((s) => s.config?.runTypeDefaults);
  const globalPermissionMode = useConfigStore((s) => s.config?.defaultAgentPermissionMode);
  // The user's GLOBAL launch model + agent runtime (one field each, shared by
  // quick sessions and flow runs). The model is normalized exactly as main's
  // configManager.getGlobalLaunchModel normalizes it — trimmed, blank ⇒ unset —
  // so a hand-edited config.json resolves the same on both sides.
  const globalLaunchModel = useConfigStore((s) => s.config?.defaultLaunchModel)?.trim() || undefined;
  const globalAgentRuntime = useConfigStore((s) => s.config?.defaultAgentRuntime);
  const { isAliasUsable } = useModelAvailability();
  // The run-type-defaults key for the CURRENT card. Quick AND Ultracode share
  // the synthetic global 'quick' key (Ultracode is a quick-shaped launch and
  // mints no key of its own); a workflow keys per selected flow; `design` gets
  // its own key because it is deliberately excluded from the stored-defaults
  // surface — giving it a key of its own keeps it on the plain Opus floor
  // instead of silently inheriting the quick default. A null selection floors to
  // 'quick' so the key is never `workflow:null`.
  const runTypeKey =
    selection?.kind === 'workflow'
      ? workflowRunTypeKey(selection.workflowId)
      : selection?.kind === 'design'
        ? 'design'
        : QUICK_RUN_TYPE_KEY;
  // The per-launcher default RUNTIME — the GLOBAL rung of the runtime ladder,
  // below any stored per-type entry. Quick + Ultracode take the quick-session
  // substrate preference projected onto a Claude runtime (PTY by default);
  // WORKFLOW launches keep the SDK default runtime so an SDK flow run can still
  // resolve 'programmatic' (interactive hard-pins orchestrated). DESIGN always
  // lands on 'claude-sdk' (its picker is hidden; see the seed below).
  const launcherDefaultRuntime: LaunchAgentRuntime =
    selection?.kind === 'workflow'
      ? DEFAULT_SESSION_AGENT_RUNTIME
      : selection?.kind === 'design'
        ? 'claude-sdk'
        : quickDefaultSubstrate === 'interactive'
          ? 'claude-interactive'
          : 'claude-sdk';
  // The per-launcher default MODEL — today's exact floor (Ultracode + a usable
  // Fable → Fable, else Opus), supplied as the resolver's GLOBAL rung.
  //
  // The Ultracode/Fable distinction MUST live in the SEED, not in `fallback`:
  // quick and ultracode share the 'quick' key, so if it lived in the fallback,
  // bouncing quick↔ultracode would change neither `key` nor `seed`,
  // useSeededSelection's [key, seed] effect would never re-fire, and Ultracode
  // would keep the Opus floor. Folding it into the resolver's global rung makes
  // the value flip opus↔fable exactly as the card kind changes — and lets an
  // explicitly configured 'quick' default outrank the Fable floor, which is the
  // intended meaning of a user-set default.
  const launcherDefaultModel =
    selection?.kind === 'ultracode' && isAliasUsable(ULTRACODE_DEFAULT_MODEL)
      ? ULTRACODE_DEFAULT_MODEL
      : DEFAULT_QUICK_MODEL;
  // The GLOBAL runtime default, coerced to what THIS card can actually launch:
  //   - workflow → `workflowRuntimeForLaunch`, so a global `codex-pty`
  //     (quick-session-only) is DROPPED and the card falls back to the
  //     substrate rung's Claude SDK default instead of seeding a runtime that
  //     would block the launch CTA.
  //   - quick / ultracode → the full session set (codex-pty included).
  //   - design → never: it is hard-pinned to the Claude SDK substrate
  //     (design-mode.md "Session plumbing", a security boundary), so no global
  //     may move it.
  // A runtime no picker may offer (`RUNTIME_CAPABILITIES.selectableInPickers` —
  // `codex-exec` today) is outside LaunchAgentRuntime on both surfaces and is
  // dropped by `launchRuntimeForPickers`.
  const offerableGlobalRuntime = launchRuntimeForPickers(globalAgentRuntime);
  const globalCardRuntime: LaunchAgentRuntime | undefined =
    offerableGlobalRuntime === undefined || selection?.kind === 'design'
      ? undefined
      : selection?.kind === 'workflow'
        ? (workflowRuntimeForLaunch(offerableGlobalRuntime) ?? undefined)
        : offerableGlobalRuntime;
  /**
   * Every Configure control seeds from the SAME canonical resolver the launch
   * seams use (`resolveRunTypeLaunchDefaults`: stored → globals → floor). Seeding
   * only the model — while still WRITING model + permission + runtime + substrate
   * on "Save as default" — silently rewrote a stored permission/runtime back to
   * the global values the screen happened to display, i.e. lost data on ordinary
   * use. Every control the save CTA captures must therefore also seed from it.
   *
   * The per-launcher runtime default rides the resolver's SUBSTRATE rung, NOT
   * its `agentRuntime` rung. `agentRuntime` is the rung that makes a resolved
   * runtime OWN its substrate, so a synthesized global runtime outranked a
   * STORED substrate that carried no runtime of its own (reachable from
   * Settings: pick a substrate, then set Agent runtime back to "Follow
   * defaults") — the card then launched on a transport the resolver, and
   * `useQuickSession.startWithDefaults`, had already rejected. Every
   * `launcherDefaultRuntime` is a Claude runtime, so the projection is lossless
   * and `runtimeSeed` below inverts it.
   *
   * The `agentRuntime` rung carries the user's GENUINE global runtime and
   * nothing else (`globalCardRuntime`, already coerced to this card's launch
   * kind). It deliberately outranks `launcherDefaultRuntime`: a real user-set
   * runtime beats a per-card default, and — being a real runtime — it owns the
   * substrate it implies, so the pair stays consistent.
   *
   * `model` keeps `launcherDefaultModel` as its FLOOR and puts the global
   * `defaultLaunchModel` above it, matching the comment above: an explicitly
   * configured default outranks the (Ultracode/Fable) floor. A stored per-type
   * model still beats both.
   */
  const launchGlobals: RunTypeLaunchGlobals = {
    model: globalLaunchModel ?? launcherDefaultModel,
    ...(globalPermissionMode !== undefined ? { permissionMode: globalPermissionMode } : {}),
    ...(globalCardRuntime !== undefined ? { agentRuntime: globalCardRuntime } : {}),
    substrate: substrateForRuntime(launcherDefaultRuntime),
  };
  const launchDefaults = resolveRunTypeLaunchDefaults(runTypeKey, runTypeDefaults, launchGlobals);
  // The model + permission seeds, named so the "Save as default" dirty check
  // (below, near handleSaveDefault) can compare each control against EXACTLY the
  // value it was seeded with rather than re-reading the resolver field by field.
  const modelSeed = launchDefaults.model;
  const permissionModeSeed = launchDefaults.permissionMode;
  // Per-launch Claude model for QUICK, ULTRACODE, DESIGN and workflow launches
  // (Configure ③). Driven by useSeededSelection: the value re-seeds REACTIVELY
  // from the resolved default while the current key is untouched, and each key
  // tracks its own touched flag + last user-chosen value, so a pin on one
  // workflow never bleeds onto another. Fable availability is read
  // optimistically — if the snapshot hasn't arrived (or flips later), the spawn
  // seam's availability fallback still degrades an unavailable Fable to Opus and
  // the picker surfaces the grey-out note. Pinned to a concrete snapshot at the
  // spawn seam. Quick/ultracode thread it into useQuickSession; workflow threads
  // it into runs.start ({ model }) → workflow_runs.model (migration 037). Fast
  // mode is the premium Opus-only research preview — a separate opt-in, default
  // OFF, QUICK-only, surfaced only while Opus is selected.
  const {
    value: model,
    setByUser: setModelByUser,
    reseed: reseedModel,
  } = useSeededSelection<string>({
    key: runTypeKey,
    seed: modelSeed,
    fallback: DEFAULT_QUICK_MODEL,
  });
  // Per-run/per-session agent permission. The seed already carries the global
  // default (the resolver's middle rung), so an untouched picker still forwards
  // exactly what the launch would otherwise inherit, and a config fetch that
  // resolves AFTER mount re-seeds it.
  const {
    value: permissionMode,
    setByUser: setPermissionModeByUser,
  } = useSeededSelection<PermissionMode>({
    key: runTypeKey,
    seed: permissionModeSeed,
    fallback: DEFAULT_PERMISSION_MODE,
  });
  // Per-launch agent runtime. Runtime is projected onto the legacy substrate
  // field during the Claude provider/runtime migration and threaded into
  // runs.start / useQuickSession. Card selection changes `runTypeKey`, which
  // re-seeds this control for untouched keys — replacing the old imperative
  // `seedDefaultRuntimeFor` + single wizard-wide touched ref, which could not
  // express "stored default for THIS card" at all.
  const runtimeSeed: LaunchAgentRuntime =
    // Design is hard-pinned to the Claude SDK substrate (design-mode.md "Session
    // plumbing" — a security boundary), so it never seeds off a stored entry.
    // A stored 'codex-exec' is not launchable from any picker, so it seeds
    // nothing and falls through to the resolved substrate's owning runtime.
    selection?.kind === 'design'
      ? 'claude-sdk'
      : isSessionAgentRuntime(launchDefaults.agentRuntime)
        ? launchDefaults.agentRuntime
        : // No stored runtime: the RESOLVED substrate owns the seed, so the pair
          // is consistent by construction and a stored substrate with no
          // accompanying runtime is honoured (with nothing stored this is exactly
          // `launcherDefaultRuntime`, i.e. byte-identical to before).
          claudeRuntimeFromSubstrate(launchDefaults.substrate);
  const {
    value: agentRuntime,
    setByUser: setAgentRuntimeByUser,
    reseed: reseedAgentRuntime,
    isTouched: isAgentRuntimeTouched,
  } = useSeededSelection<LaunchAgentRuntime>({
    key: runTypeKey,
    seed: runtimeSeed,
    fallback: DEFAULT_SESSION_AGENT_RUNTIME,
  });
  const [fastMode, setFastMode] = useState<boolean>(false);
  // Per-session reasoning-effort selection (IDEA-029), QUICK on every runtime
  // whose RUNTIME_CAPABILITIES say the flag reaches the agent (Claude
  // SDK/interactive + codex-sdk). Gated out for a runtime that drops it
  // (codex-pty — no turn-options object) and for Ultracode (pins xhigh,
  // suppresses --effort); a workflow's per-agent effort is set in the step
  // inspector. `null` means "provider default" (no explicit selection sent).
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(null);
  // Tracks the previous effective runtime so the effect below clears a pending
  // effort selection on a genuine runtime transition (never on mount).
  const prevEffectiveRuntimeRef = useRef<LaunchAgentRuntime | null>(null);
  // A workflow cannot launch on Codex PTY, so a runtime that is only valid for a
  // session is coerced back to the SDK default when a workflow card is selected.
  // Goes through `reseed`, NOT `setByUser`: it is a PROGRAMMATIC coercion, and
  // latching the key touched here would permanently freeze reactive re-seeding
  // for a control the user never actually touched.
  useEffect(() => {
    if (
      selection?.kind === 'workflow' &&
      workflowRuntimeForLaunch(agentRuntime) === null
    ) {
      reseedAgentRuntime(DEFAULT_SESSION_AGENT_RUNTIME);
    }
  }, [selection?.kind, agentRuntime, reseedAgentRuntime]);
  useEffect(() => {
    const effectiveRuntime: LaunchAgentRuntime =
      selection?.kind === 'ultracode'
        ? 'claude-interactive'
        : selection?.kind === 'design'
          ? 'claude-sdk'
          : agentRuntime;
    // A runtime flip changes the effective provider, and the effort scales
    // differ (Claude low..max vs Codex none..xhigh). Clear any pending
    // reasoning-effort selection ONLY on an actual runtime transition (not on a
    // model-only change or the effort pick itself — reasoningEffort is
    // deliberately NOT a dep), so a stale cross-provider value can never ride a
    // launch: the spawn seam would silently drop it while the composer pill
    // still displayed it as active. The ref gates the reset to a genuine change
    // and skips the initial mount.
    if (
      prevEffectiveRuntimeRef.current !== null &&
      prevEffectiveRuntimeRef.current !== effectiveRuntime
    ) {
      setReasoningEffort(null);
    }
    prevEffectiveRuntimeRef.current = effectiveRuntime;

    // Family coercion. Two things to know here:
    //
    // 1. It goes through `reseed`, NOT `setByUser` — a programmatic family switch
    //    must never latch the key as user-touched, or the model control would
    //    stop re-seeding for a control the user never actually touched.
    // 2. The Claude replacement is the CURRENT SEED when that seed is itself a
    //    Claude selection, not an unconditional Opus. useSeededSelection's seed
    //    effect is registered before this one (the hook is called above), so on a
    //    flush where key/seed just changed it has already queued the freshly
    //    seeded model while `model` here still holds the PRE-seed value; writing
    //    a hard-coded floor would land LAST and clobber that seed (e.g. a Codex
    //    quick card → Ultracode would settle on Opus instead of Fable). Writing
    //    the seed instead makes the two writers AGREE. With nothing configured
    //    the seed is DEFAULT_QUICK_MODEL for every card except Ultracode, so this
    //    is byte-identical to the previous unconditional floor.
    if (isCodexRuntime(effectiveRuntime)) {
      if (!isCodexModelSelection(model)) reseedModel(DEFAULT_CODEX_MODEL);
      return;
    }
    if (isCodexModelFamily(model)) {
      const seededModel = launchDefaults.model;
      reseedModel(isCodexModelFamily(seededModel) ? DEFAULT_QUICK_MODEL : seededModel);
    }
  }, [selection?.kind, agentRuntime, model, launchDefaults.model, reseedModel]);
  // The stored quick-session reasoning-effort default (written only under the
  // synthetic global 'quick' key).
  const storedQuickEffort = runTypeDefaults?.quick?.reasoningEffort;
  // Seed the QUICK card's reasoning effort from that stored default.
  //
  // Deliberately a plain useState + this dedicated effect rather than a third
  // useSeededSelection: this control has to lose to the cross-provider reset in
  // the effect above, which no touched latch of its own could express.
  //
  // THE INVARIANT: an actual provider flip ALWAYS beats the stored default, and
  // nothing may resurrect the effort afterwards. It is enforced by the
  // `isAgentRuntimeTouched` guard below, NOT by omitting `agentRuntime` from the
  // deps — because the runtime picker is the ONLY way a user flips the provider
  // on this surface, and touching it latches that key forever (useSeededSelection
  // tracks touched per key). So: the moment the user picks a runtime, this effect
  // is dead for that card and the reset above stands.
  //
  // `agentRuntime` IS a dependency, and has to be, because the runtime re-seeds
  // through an effect — one commit AFTER the card-kind change that triggers this
  // seeding. Without it the sequence for "select the quick card" is: commit N
  // seeds the effort, commit N+1 settles the re-seeded runtime and the reset
  // above wipes it. Re-running here on the settled runtime also means the
  // provider-scale check below validates against the runtime that will ACTUALLY
  // launch, instead of the pre-seed one. Both writers run in the same flush with
  // the reset registered first, so the seed lands last and wins — for an
  // UNTOUCHED runtime only.
  //
  // Ultracode (which pins xhigh at spawn and suppresses --effort) and design are
  // excluded by the card-kind guard.
  useEffect(() => {
    if (selection?.kind !== 'quick') return;
    if (storedQuickEffort === undefined) return;
    if (isAgentRuntimeTouched) return;
    const provider = providerForRuntime(
      prevEffectiveRuntimeRef.current ?? DEFAULT_SESSION_AGENT_RUNTIME,
    );
    // The two providers expose different effort scales; a stored level that is
    // not on the current provider's scale would be dropped at the spawn seam
    // while the control still showed it as active, so skip it entirely.
    if (!isValidEffortForProvider(provider, storedQuickEffort)) return;
    setReasoningEffort(storedQuickEffort);
  }, [selection?.kind, storedQuickEffort, agentRuntime, isAgentRuntimeTouched]);
  // Advanced (Configure ③, WORKFLOW only): per-run code-review-eval override.
  // 'inherit' → omit `evalEnabled` (the run inherits the global codeReviewEvalEnabled
  // setting); 'on'/'off' → send true/false → workflow_runs.eval_enabled (migration
  // 044). Meaningless for a quick session (evals only fire for built-in flows), so
  // the control is not shown there. Default 'inherit' keeps launches byte-identical.
  const [evalOverride, setEvalOverride] = useState<'inherit' | 'on' | 'off'>('inherit');
  // Advanced (Configure ③, WORKFLOW only): per-run visual-verification override.
  // 'inherit' → omit `verifyEnabled` (the run inherits the global visualVerify.enabled
  // setting / project `.cyboflow/verify.json`); 'on'/'off' → send true/false →
  // workflow_runs.verify_enabled. Default 'inherit' keeps launches byte-identical.
  const [verifyOverride, setVerifyOverride] = useState<'inherit' | 'on' | 'off'>('inherit');
  // Advanced (Configure ③, WORKFLOW only): per-run execution-model override.
  // 'inherit' → omit `executionModel` (the run resolves via the global
  // defaultExecutionModel setting → env → the 'orchestrated' floor); an explicit
  // choice is the HIGHEST-precedence resolver rung. Interactive-PTY runs always
  // hard-pin 'orchestrated' inside the resolver, so the override only matters on
  // the SDK substrate. Default 'inherit' keeps launches byte-identical.
  const [executionModelOverride, setExecutionModelOverride] = useState<'inherit' | ExecutionModel>('inherit');
  // Advanced (Configure ③, QUICK only): per-session workspace override. 'inherit'
  // → omit `worktreeMode` (createQuick floors to the global quickSessionWorktreeMode
  // Settings default); an explicit choice threads into useQuickSession →
  // sessions.in_place (migration 047). Both substrates support 'in-place' (the
  // interactive gate rides the inline `--settings` flag — no checkout writes).
  // Default 'inherit' keeps launches byte-identical.
  const [worktreeModeOverride, setWorktreeModeOverride] = useState<'inherit' | QuickSessionWorktreeMode>('inherit');
  // Advanced (Configure ③, WORKFLOW only): per-run A/B variant choice (migration
  // 048, VariantSelector). Defaults to 'rotation' — a no-op selection
  // (variantSelectionToStartInput sends neither `variantId` nor `baseline`) so a
  // workflow with zero/ineligible variants launches exactly as before.
  // VariantSelector re-seeds this to the architect default once its list
  // resolves; reset to 'rotation' whenever the selected workflow changes (below)
  // so a stale variant id from a PREVIOUS workflow is never sent to a different
  // workflow's launch.
  const [variantSelection, setVariantSelection] = useState<VariantSelection>({ mode: 'rotation' });
  // Advanced (Configure ③, quick only): per-session MCP DENY set + plugin
  // selection, chosen at session start (NOT a mid-conversation toggle — enforced
  // at the first spawn). Threaded into createQuick; collapsed by default.
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [disabledMcpServers, setDisabledMcpServers] = useState<string[]>([]);
  // Plugins are EXCLUSIVE and reflect the user's CURRENT enabled set: the toggles
  // are seeded from `pluginBaseline` (the plugins enabled in ~/.claude/settings.json,
  // via the catalogue), so the control mirrors reality. At launch we send the
  // selection ONLY when it differs from the baseline (unchanged → undefined →
  // inherit; a change → the exclusive set, incl [] = "disable everything").
  const [enabledPlugins, setEnabledPlugins] = useState<string[]>([]);
  const [pluginBaseline, setPluginBaseline] = useState<string[]>([]);
  const pluginsSeededRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await trpc.cyboflow.plugins.list.query();
        if (cancelled) return;
        const enabledIds = Array.from(new Set(list.filter((p) => p.enabled).map((p) => p.id)));
        setPluginBaseline(enabledIds);
        // Seed the selection to the current-enabled set exactly once (don't clobber
        // a choice the user already made before the async catalogue arrived).
        if (!pluginsSeededRef.current) {
          pluginsSeededRef.current = true;
          setEnabledPlugins(enabledIds);
        }
      } catch {
        // Catalogue unavailable → baseline stays [] → unchanged → inherit.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  // A variant id is workflow-scoped — reset to the no-op 'rotation' selection
  // whenever the selected workflow changes so a PRIOR workflow's variant pin is
  // never sent to a different workflow's launch (VariantSelector re-seeds the
  // real default for the new workflow once its list resolves).
  const selectedWorkflowId = selection?.kind === 'workflow' ? selection.workflowId : null;
  useEffect(() => {
    setVariantSelection({ mode: 'rotation' });
  }, [selectedWorkflowId]);

  // Blueprint editor (workflow path only) — 'edit' (selected flow) or 'create'.
  const [editorMode, setEditorMode] = useState<'edit' | 'create' | null>(null);

  // Planner pre-launch idea gate.
  const [ideaPickerOpen, setIdeaPickerOpen] = useState(false);
  const [pendingWorkflowId, setPendingWorkflowId] = useState<string | null>(null);
  // Design pre-launch idea gate (design-mode.md "Idea link" — required, no
  // idealess design). Shares `ideaPickerOpen` with the Planner/Ship gate above
  // (see handleIdeaPicked); a boolean latch is enough since design binds to
  // exactly one idea (no batch). handleStart resets the OTHER pending target
  // whenever it opens the picker for one flow, so a cancelled attempt can never
  // leak into a later pick of the other kind.
  const [pendingDesign, setPendingDesign] = useState(false);

  // Sprint pre-launch task-batch gate. A sprint run is seeded with the
  // multi-selected task ids (single-run lane model), so its launch goes through
  // the batch picker → runs.start({ taskIds }), mirroring the Planner idea gate.
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);

  // Launch flow pre-launch seed-prompt gate. A 'launch' selection opens this
  // modal first, holding the target workflow id; the trimmed answer is
  // threaded into launchRun as `seedPrompt`, mirroring pendingWorkflowId above.
  const [launchPromptOpen, setLaunchPromptOpen] = useState(false);
  const [pendingLaunchWorkflowId, setPendingLaunchWorkflowId] = useState<string | null>(null);

  // Launch state.
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const startInFlightRef = useRef(false);
  // Design-launch detection for the shared useQuickSession onSuccess below
  // (design-mode.md v0.5 "Auto-start"): launchDesign sets this synchronously,
  // in the same tick it invokes startQuickSession, before any of the hook's
  // awaited work resolves — so it is race-free within this component. Reset
  // on every startQuickSession call site (not only design's own success path)
  // so a failed design launch (onSuccess never fires) can never leak `true`
  // into a later non-design launch.
  const isDesignLaunchRef = useRef(false);
  // A wizard workflow launch creates a host session before runs.start can
  // validate the provider mix. Keep that session attached to the pending
  // attempt so a mixed-provider retry reuses its worktree instead of creating
  // a second one.
  const pendingHostedSessionIdRef = useRef<string | null>(null);

  // Mixed-provider retry prompt (Phase 2 slice D2). launchRun / launchBatch
  // detect isMixedProviderOrchestratedError in their catch and, instead of
  // calling setLaunchError, stash a retry thunk here that re-invokes the exact
  // same launch with executionModel forced to 'programmatic'. The CTA area
  // renders a confirm/cancel prompt off this instead of the raw error.
  const [mixedProviderPrompt, setMixedProviderPrompt] = useState<{
    retry: () => void;
    sessionId: string | null;
  } | null>(null);

  // One-shot latch for the explicit `preselectWorkflowName` auto-advance. Set
  // the moment the preselect resolves and drives ② → ③ once, so later
  // loadWorkflows reruns (e.g. blueprint-editor saves) and user back-navigation
  // (handleBackToWorkflow / handleChangeProject) are never fought back.
  const preselectConsumedRef = useRef(false);

  // Bottom-center slide-up toast.
  const [toast, setToast] = useState<string | null>(null);

  // The currently-active project banner. In locked mode `projects` is empty, so
  // the hook fetches name/path/branch itself. Declared BEFORE useQuickSession so
  // the success toast can read the resolved project name.
  const banner = useActiveProjectBanner(selectedProjectId, projects);

  // ── Quick session hook (bound to the locked project) ─────────────────────
  // Constructed unconditionally at top level (rules of hooks); only USED when
  // allowQuick. setActiveQuickSession is performed inside the hook.
  const {
    start: startQuickSession,
    isStarting: isQuickStarting,
    error: quickError,
  } = useQuickSession({
    projectId: allowQuick ? selectedProjectId : null,
    onSuccess: (sessionId) => {
      setToast(`Starting quick session on ${banner.name}`);
      notifyQuickSessionCreated({ projectId: selectedProjectId });
      // Design-only: drop straight into the fullscreen surface (design-mode.md
      // v0.5 "Auto-start"). See isDesignLaunchRef's declaration above.
      if (isDesignLaunchRef.current) {
        isDesignLaunchRef.current = false;
        useDesignModeStore.getState().enterDesignMode(sessionId);
      }
      // CyboflowRoot reads navigationStore.activeProjectId as its `projectId`
      // prop, and gates the WHOLE quick-session surface on it being non-null
      // (QuickSessionCanvas + TerminalDock + dock tabs). Nothing on the way into
      // this wizard sets it — goToWizard doesn't, and neither do its callers
      // (landing CTAs, onboarding's handleAddProject) — so a user who has never
      // clicked a project/session in the sidebar (i.e. a first-run user) would
      // land on the bare panel fallback with no canvas and no dock. Stamp it
      // here exactly as the two workflow launch paths (launchRun / launchBatch)
      // already do before their own goToSession.
      useNavigationStore.getState().setActiveProjectId(selectedProjectId);
      useNavigationStore.getState().goToSession();
    },
  });

  // Auto-dismiss the launch toast (it normally outlives this component only
  // briefly, since the launch handlers navigate away — but if the wizard stays
  // mounted the toast must clear itself).
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  // ── Load projects on the project step (unlocked) ─────────────────────────
  useEffect(() => {
    if (locked) return;
    setProjectsLoading(true);
    setProjectsError(null);
    void API.projects
      .getAll()
      .then((res) => {
        if (res.success && Array.isArray(res.data)) {
          setProjects(res.data as Project[]);
        } else {
          setProjectsError(res.error ?? 'Failed to load projects');
        }
      })
      .catch((err: unknown) => {
        setProjectsError(err instanceof Error ? err.message : 'Failed to load projects');
      })
      .finally(() => {
        setProjectsLoading(false);
      });
  }, [locked]);

  // ── Load workflows + runs once a project is active ───────────────────────
  // Refactored out of the mount effect into a callable so the blueprint editor
  // (step ③) can re-invoke it after saving a new/edited flow. `preferId` selects
  // a just-saved flow; otherwise the current pick is preserved or the default is
  // chosen.
  const loadWorkflows = useCallback(
    (preferId?: string): Promise<void> => {
      if (selectedProjectId === null) return Promise.resolve();
      const projectId = selectedProjectId;
      setWorkflowsLoading(true);
      setWorkflowsError(null);
      return Promise.all([
        trpc.cyboflow.workflows.list.query({ projectId }),
        trpc.cyboflow.runs.list.query({ projectId }),
      ])
        .then(([rows, runs]) => {
          const metas = buildWorkflowMeta(rows, runs);
          setWorkflowMetas(metas);
          // Resolve the explicit preselect target up-front (no side effects
          // inside the setSelection updater). It only takes effect when a
          // matching flow exists AND it has not already been consumed — the
          // one-shot latch keeps later reruns / back-navigation from re-forcing it.
          //
          // By-ROW-ID preselect (`preselectWorkflowId`) TAKES PRECEDENCE over the
          // by-name path: the gallery Run action passes the unambiguous workflow
          // row id, which avoids the cross-project name-collision footgun where
          // `preselectWorkflowName` silently falls back to DEFAULT_WORKFLOW_NAME
          // ("sprint"). `WorkflowCardMeta.id` IS the workflow row id.
          // `preselectWorkflowName` is kept for the Insights compound CTA.
          const preselectId = opts?.preselectWorkflowId;
          const preselectName = opts?.preselectWorkflowName;
          const preselectRequested = preselectId !== undefined || preselectName !== undefined;
          const preselectTarget = preselectConsumedRef.current
            ? null
            : preselectId !== undefined
              ? metas.find((m) => m.id === preselectId) ?? null
              : preselectName !== undefined
                ? metas.find((m) => m.name === preselectName) ?? null
                : null;
          // A preselect that was ASKED FOR and did not resolve must say so. The
          // silent fallback to "sprint" is merely confusing for a flow the user
          // can still find in the list below — but for a HIDDEN setup flow it
          // is a dead end, since the list is exactly where it is not. Only
          // report an unconsumed request: after the latch fires, a rerun has
          // legitimately stopped looking.
          if (preselectRequested && !preselectConsumedRef.current && preselectTarget === null) {
            setWorkflowsError(
              `Flow "${preselectName ?? preselectId ?? ''}" is not available for this project.`,
            );
          }
          // Selection priority: a just-saved flow (preferId, editor save) >
          // the existing pick > the EXPLICIT preselect > the default flow.
          setSelection((prev) => {
            if (preferId && metas.some((m) => m.id === preferId)) {
              return { kind: 'workflow', workflowId: preferId };
            }
            if (prev !== null) return prev;
            if (preselectTarget !== null) {
              return { kind: 'workflow', workflowId: preselectTarget.id };
            }
            const def = metas.find((m) => m.name === DEFAULT_WORKFLOW_NAME);
            return def ? { kind: 'workflow', workflowId: def.id } : null;
          });
          // Auto-advance ② → ③ EXACTLY ONCE when the explicit preselect resolved.
          // Latched so a later loadWorkflows rerun or user back-nav is not fought.
          // (The implicit DEFAULT_WORKFLOW_NAME preselect above is selection-only —
          // it never advances; see the WorkflowListRow onSelect comment.)
          if (preselectTarget !== null) {
            preselectConsumedRef.current = true;
            setStep((s) => (s === 2 ? 3 : s));
          }
        })
        .catch((err: unknown) => {
          setWorkflowsError(err instanceof Error ? err.message : 'Failed to load workflows');
        })
        .finally(() => {
          setWorkflowsLoading(false);
        });
    },
    [selectedProjectId, opts?.preselectWorkflowId, opts?.preselectWorkflowName],
  );

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  // ── Navigation handlers ──────────────────────────────────────────────────
  const handleBackToQueue = useCallback(() => {
    useNavigationStore.getState().goHome();
  }, []);

  const handleChangeProject = useCallback(() => {
    setStep(1);
    setSelectedProjectId(null);
    setSelection(null);
    setWorkflowMetas([]);
  }, []);

  const handleBackToWorkflow = useCallback(() => {
    setStep(2);
  }, []);

  const handleSelectProject = useCallback((projectId: number) => {
    setSelectedProjectId(projectId);
    setSelection(null);
    setStep(2);
  }, []);

  const handleEditorSaved = useCallback(
    (savedId: string) => {
      setEditorMode(null);
      void loadWorkflows(savedId);
    },
    [loadWorkflows],
  );

  const handleProjectCreated = useCallback((project: Project) => {
    setCreateOpen(false);
    useNavigationStore.getState().goToWizard({ lockProjectId: project.id, allowQuick: true });
  }, []);

  // A host session created for a failed launch is not user content. Delete it
  // when the user declines the retry (or when a non-retryable launch failure
  // occurs), including its worktree via the normal sessions:delete path.
  const cleanupUnusedHostedSession = useCallback(async (sessionId: string | null): Promise<void> => {
    if (sessionId === null) return;
    if (pendingHostedSessionIdRef.current === sessionId) {
      pendingHostedSessionIdRef.current = null;
    }
    try {
      await API.sessions.delete(sessionId);
    } catch {
      // Cleanup is best-effort here; the original launch error remains the
      // useful user-facing result and the backend delete path is fail-soft.
    }
  }, []);

  // Leaving the wizard while the decision is pending must not strand the
  // pre-created host. A successful launch clears the ref before navigation;
  // cancel and ordinary launch failures clear it through the helper above.
  useEffect(() => {
    return () => {
      void cleanupUnusedHostedSession(pendingHostedSessionIdRef.current);
    };
  }, [cleanupUnusedHostedSession]);

  // ── Launch ───────────────────────────────────────────────────────────────
  const launchRun = useCallback(
    async (
      workflowId: string,
      ideaSeed?: { ideaId?: string; ideaIds?: string[] },
      // Set on the mixed-provider retry (see mixedProviderPrompt above) to pin
      // this exact launch to programmatic, overriding the Advanced Orchestration
      // control. Absent on every ordinary launch.
      forceExecutionModel?: ExecutionModel,
      // The mixed-provider retry passes the session created by the first
      // attempt. Omitting this creates and records a fresh host session.
      existingSessionId?: string,
      // The Launch flow's pre-launch free-text answer (LaunchPromptModal).
      // Undefined for every other flow.
      seedPrompt?: string,
    ): Promise<void> => {
      if (startInFlightRef.current) return;
      if (selectedProjectId === null) return;
      startInFlightRef.current = true;
      setLaunchError(null);
      setIsLaunching(true);
      let sessionId: string | null = existingSessionId ?? null;
      try {
        const workflowRuntime = workflowRuntimeForLaunch(agentRuntime);
        if (workflowRuntime === null) {
          throw new Error('Codex (CLI) is only available for quick sessions.');
        }
        const launchSubstrate = substrateForRuntime(workflowRuntime);
        // Ensure the run executes INSIDE a session. This wizard IS the explicit
        // "Start a new session" surface, so it ALWAYS creates a fresh session
        // (forceNew) — it must never silently absorb the quick session the user
        // happens to have selected. (Reusing the selection is reserved for the
        // in-session "Add a workflow" affordance via useLaunchWorkflow.) Without
        // a session the run would take the legacy PARENTLESS path
        // (workflow_runs.session_id null), with nothing to bind the close-out
        // (Merge / PR / Dismiss) or the File Explorer / Diff to.
        if (sessionId === null) {
          sessionId = await ensureSessionForLaunch(selectedProjectId, {
            forceNew: true,
            agentProvider: providerForRuntime(workflowRuntime),
            agentRuntime: workflowRuntime,
            agentModel: model,
          });
          pendingHostedSessionIdRef.current = sessionId;
        }
        // Resolve the launched flow's meta BEFORE the mutate so the seed gate can
        // read meta?.name — the triage-tray finding ids are only seeded into a
        // `compound` run.
        const meta = workflowMetas.find((m) => m.id === workflowId);
        // Single conditional-spread object (exactOptionalPropertyTypes-safe): the
        // optional `ideaId` (planner) and `findingIds` (compound-only triage seed)
        // are spread in only when present, so neither is ever sent as undefined.
        const result: RunStartResult = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId: selectedProjectId,
          sessionId,
          ...(launchSubstrate ? { substrate: launchSubstrate } : {}),
          agentProvider: providerForRuntime(workflowRuntime),
          agentRuntime: workflowRuntime,
          permissionMode,
          // Per-run model pin (migration 037) — the Configure picker, default Opus.
          model,
          // Per-run code-review-eval override (migration 044) — Advanced options.
          // 'inherit' omits the field (inherit the global setting); on/off send a
          // boolean. A per-run ON does NOT unlock quick/custom flows server-side.
          ...(evalOverride !== 'inherit' ? { evalEnabled: evalOverride === 'on' } : {}),
          ...(verifyOverride !== 'inherit' ? { verifyEnabled: verifyOverride === 'on' } : {}),
          // Per-run execution-model override — Advanced options. 'inherit' omits the
          // field (the resolver ladder decides); an explicit choice is the
          // highest-precedence rung of resolveExecutionModel. A mixed-provider
          // retry (forceExecutionModel) takes precedence over the Advanced control.
          ...(forceExecutionModel !== undefined
            ? { executionModel: forceExecutionModel }
            : executionModelOverride !== 'inherit'
              ? { executionModel: executionModelOverride }
              : {}),
          ...(ideaSeed?.ideaIds !== undefined
            ? { ideaIds: ideaSeed.ideaIds }
            : ideaSeed?.ideaId !== undefined
              ? { ideaId: ideaSeed.ideaId }
              : {}),
          ...(seedPrompt !== undefined ? { seedPrompt } : {}),
          ...(selectedFindingIds?.length && meta?.name === 'compound'
            ? { findingIds: selectedFindingIds }
            : {}),
          ...variantSelectionToStartInput(variantSelection),
        });
        // Nest the run under its session so the close-out + panels resolve
        // (setActiveRun's parentSessionId sets selectedSessionId).
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        useNavigationStore.getState().setActiveProjectId(selectedProjectId);
        if (pendingHostedSessionIdRef.current === sessionId) {
          pendingHostedSessionIdRef.current = null;
        }

        const slash = meta?.slashCommand ?? '/workflow';
        setToast(`Launching ${slash} on ${banner.name} ⌥ ${result.branchName}`);

        trackEvent('workflow_run_started', {
          launch_surface: 'wizard',
          flow:
            meta && (CYBOFLOW_WORKFLOW_NAMES as readonly string[]).includes(meta.name)
              ? (meta.name as TelemetryFlow)
              : 'custom',
          ...(launchSubstrate ? { substrate: launchSubstrate } : {}),
          permission_mode: permissionMode,
        });
        notifyWorkflowRunStarted({ runId: result.runId, launchSurface: 'wizard' });
        useNavigationStore.getState().goToSession();
      } catch (err: unknown) {
        if (isMixedProviderOrchestratedError(err)) {
          // Do NOT surface a raw error — offer to retry as programmatic instead.
          setMixedProviderPrompt({
            sessionId,
            retry: () =>
            void launchRun(workflowId, ideaSeed, 'programmatic', sessionId ?? undefined, seedPrompt),
          });
          startInFlightRef.current = false;
          return;
        }
        await cleanupUnusedHostedSession(sessionId);
        setLaunchError(err instanceof Error ? err.message : 'Failed to start run');
        startInFlightRef.current = false;
      } finally {
        setIsLaunching(false);
      }
    },
    [selectedProjectId, workflowMetas, banner.name, agentRuntime, permissionMode, model, evalOverride, verifyOverride, executionModelOverride, selectedFindingIds, variantSelection, cleanupUnusedHostedSession],
  );

  // Sprint launch — ONE session-hosted run seeded with the multi-selected task
  // ids (single-run lane model). Follows launchRun exactly
  // (ensureSessionForLaunch → runs.start → setActiveRun → goToSession);
  // `taskIds` makes the launcher create the lane batch and stamp
  // workflow_runs.batch_id, and per-task progress renders as lanes in the run
  // progress rail. Mirrors WorkflowPicker.launchBatch.
  const launchBatch = useCallback(
    async (
      workflowId: string,
      taskIds: string[],
      // Set on the mixed-provider retry (see mixedProviderPrompt above) — mirrors
      // launchRun's forceExecutionModel.
      forceExecutionModel?: ExecutionModel,
      existingSessionId?: string,
    ): Promise<void> => {
      if (startInFlightRef.current) return;
      if (selectedProjectId === null) return;
      startInFlightRef.current = true;
      setLaunchError(null);
      setIsLaunching(true);
      let sessionId: string | null = existingSessionId ?? null;
      try {
        const workflowRuntime = workflowRuntimeForLaunch(agentRuntime);
        if (workflowRuntime === null) {
          throw new Error('Codex (CLI) is only available for quick sessions.');
        }
        const launchSubstrate = substrateForRuntime(workflowRuntime);
        // forceNew: the wizard always starts a NEW session (see launchRun).
        if (sessionId === null) {
          sessionId = await ensureSessionForLaunch(selectedProjectId, {
            forceNew: true,
            agentProvider: providerForRuntime(workflowRuntime),
            agentRuntime: workflowRuntime,
            agentModel: model,
          });
          pendingHostedSessionIdRef.current = sessionId;
        }
        const result: RunStartResult = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId: selectedProjectId,
          sessionId,
          ...(launchSubstrate ? { substrate: launchSubstrate } : {}),
          agentProvider: providerForRuntime(workflowRuntime),
          agentRuntime: workflowRuntime,
          permissionMode,
          // Per-run model pin (migration 037) — the Configure picker, default Opus.
          model,
          // Per-run code-review-eval override (migration 044) — Advanced options.
          ...(evalOverride !== 'inherit' ? { evalEnabled: evalOverride === 'on' } : {}),
          ...(verifyOverride !== 'inherit' ? { verifyEnabled: verifyOverride === 'on' } : {}),
          // Per-run execution-model override — Advanced options (see launchRun).
          // A mixed-provider retry (forceExecutionModel) takes precedence.
          ...(forceExecutionModel !== undefined
            ? { executionModel: forceExecutionModel }
            : executionModelOverride !== 'inherit'
              ? { executionModel: executionModelOverride }
              : {}),
          taskIds,
          ...variantSelectionToStartInput(variantSelection),
        });
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        useNavigationStore.getState().setActiveProjectId(selectedProjectId);
        if (pendingHostedSessionIdRef.current === sessionId) {
          pendingHostedSessionIdRef.current = null;
        }

        const meta = workflowMetas.find((m) => m.id === workflowId);
        const slash = meta?.slashCommand ?? '/sprint';
        setToast(`Launching ${slash} (${taskIds.length} tasks) on ${banner.name} ⌥ ${result.branchName}`);

        notifyWorkflowRunStarted({ runId: result.runId, launchSurface: 'wizard' });
        useNavigationStore.getState().goToSession();
      } catch (err: unknown) {
        if (isMixedProviderOrchestratedError(err)) {
          // Do NOT surface a raw error — offer to retry as programmatic instead.
          setMixedProviderPrompt({
            sessionId,
            retry: () => void launchBatch(workflowId, taskIds, 'programmatic', sessionId ?? undefined),
          });
          startInFlightRef.current = false;
          return;
        }
        await cleanupUnusedHostedSession(sessionId);
        setLaunchError(err instanceof Error ? err.message : 'Failed to start sprint run');
        startInFlightRef.current = false;
      } finally {
        setIsLaunching(false);
      }
    },
    [selectedProjectId, workflowMetas, banner.name, agentRuntime, permissionMode, model, evalOverride, verifyOverride, executionModelOverride, variantSelection, cleanupUnusedHostedSession],
  );

  // Design launch — fires from the idea-picker confirm callback
  // (handleIdeaPicked), never directly from the CTA (see handleStart's design
  // arm below). Hard-pins the SDK substrate + Claude provider/runtime
  // regardless of the wizard's agentRuntime state (design-mode.md "Session
  // plumbing": design sessions resolve to the Claude SDK substrate
  // unconditionally — a security boundary, since the MCP scope mechanism that
  // limits a design session's toolset exists only on that path) and threads
  // the picked idea id as `designIdeaId` so createQuick can validate ownership
  // and stamp sessions.design_idea_id server-side.
  const launchDesign = useCallback(
    (ideaId: string) => {
      const pluginSelection = sameStringSet(enabledPlugins, pluginBaseline) ? undefined : enabledPlugins;
      // Set BEFORE invoking startQuickSession — see isDesignLaunchRef's
      // declaration for the race-free reasoning.
      isDesignLaunchRef.current = true;
      void startQuickSession(
        permissionMode,
        'sdk',
        undefined,
        model,
        fastMode,
        disabledMcpServers,
        pluginSelection,
        worktreeModeOverride !== 'inherit' ? worktreeModeOverride : undefined,
        'claude',
        'claude-sdk',
        reasoningEffort ?? undefined,
        ideaId,
        DESIGN_KICKOFF_PROMPT,
      );
    },
    [
      startQuickSession,
      permissionMode,
      model,
      fastMode,
      disabledMcpServers,
      enabledPlugins,
      pluginBaseline,
      worktreeModeOverride,
      reasoningEffort,
    ],
  );

  const handleStart = useCallback(() => {
    if (selection === null || startInFlightRef.current || mixedProviderPrompt !== null) return;

    if (selection.kind === 'quick') {
      const sessionRuntime = quickSessionRuntimeForLaunch(agentRuntime);
      // Fast mode is Opus-only; never request it for another model even if the
      // toggle was left on before the model was switched.
      //
      // MCP deny + plugin selection are enforced on both CLAUDE substrates (SDK:
      // composeMcpServers delete + disallowedTools; interactive: --disallowed-tools
      // + disabledMcpjsonServers + enabledPlugins via --settings). Plugins reflect
      // the current enabled set, so send the selection ONLY when the user changed
      // it — `undefined` (unchanged) leaves the column NULL (inherit); an explicit
      // array (incl []) pins the exclusive set for the session.
      const pluginSelection = sameStringSet(enabledPlugins, pluginBaseline) ? undefined : enabledPlugins;
      const quickSubstrate = substrateForRuntime(sessionRuntime);
      const quickProvider = providerForRuntime(sessionRuntime);
      // Defensive reset: a previously FAILED design launch never reaches
      // onSuccess (where the flag is normally cleared) — guard against it
      // leaking into this non-design launch.
      isDesignLaunchRef.current = false;
      void startQuickSession(
        permissionMode,
        quickSubstrate,
        undefined,
        model,
        runtimeSupportsFastMode(sessionRuntime) && isOpusModel(model) && fastMode,
        disabledMcpServers,
        pluginSelection,
        // Workspace override (Advanced) — 'inherit' omits it (server floors to the
        // global default); an explicit choice threads into sessions.in_place.
        worktreeModeOverride !== 'inherit' ? worktreeModeOverride : undefined,
        quickProvider,
        sessionRuntime,
        reasoningEffort ?? undefined,
      );
      return;
    }

    if (selection.kind === 'ultracode') {
      // Ultracode is an interactive session in ultracode mode: pin the substrate
      // to 'interactive' (PTY is required for the live REPL + dynamic-workflow
      // detection) and thread `effort: 'ultracode'` → the ultracode setting.
      // The Configure model (default Fable when available) + Advanced MCP/plugin
      // selections thread exactly like a quick launch — the interactive eager
      // spawn receives the model via claudeConfig and enforces the deny/plugin
      // sets. Fast mode stays QUICK-only (its toggle never shows here).
      const pluginSelection = sameStringSet(enabledPlugins, pluginBaseline) ? undefined : enabledPlugins;
      // Defensive reset — see the 'quick' branch above.
      isDesignLaunchRef.current = false;
      void startQuickSession(
        permissionMode,
        'interactive',
        'ultracode',
        model,
        false,
        disabledMcpServers,
        pluginSelection,
        undefined,
        'claude',
        'claude-interactive',
        // No reasoningEffort: the Ultracode card pins xhigh and the interactive
        // spawn suppresses --effort while effort==='ultracode' (a selection
        // would be a no-op), so the wizard never offers the control here.
      );
      return;
    }

    if (selection.kind === 'design') {
      // Design is idea-bound (design-mode.md "Idea link — integrity contract"):
      // gate behind the idea picker, single-select, exactly like the Planner/
      // Ship gate below — but do NOT flip the launch latch yet (the picker
      // stays freely cancellable). Reset pendingWorkflowId so a stale
      // planner/ship target from an earlier cancelled attempt can never make
      // this picker open in `multi` mode (see handleIdeaPicked / its `multi`
      // computation below).
      setLaunchError(null);
      setPendingWorkflowId(null);
      setPendingDesign(true);
      setIdeaPickerOpen(true);
      return;
    }

    // selection.kind === 'workflow'
    const meta = workflowMetas.find((m) => m.id === selection.workflowId);
    if (meta?.name === 'planner' || meta?.name === 'ship') {
      // Gate behind the idea picker — do NOT flip the latch yet. Ship (planner ⊕
      // sprint in one continuous run) is IDEA-seeded like the planner, so it
      // shares the idea gate; the human task-subset selection happens later, at
      // the in-run approve-plan gate. Reset pendingDesign so a stale design
      // latch from an earlier cancelled attempt can never route this pick into
      // launchDesign (see handleIdeaPicked).
      setLaunchError(null);
      setPendingDesign(false);
      setPendingWorkflowId(selection.workflowId);
      setIdeaPickerOpen(true);
      return;
    }
    if (meta?.name === 'sprint') {
      // Gate behind the task batch picker — a sprint launches ONE session-hosted
      // run seeded with the picked task ids. Do NOT flip the latch yet (opening
      // the picker stays freely cancellable).
      setLaunchError(null);
      setBatchPickerOpen(true);
      return;
    }
    if (meta?.name === 'launch') {
      // Gate behind the seed-prompt modal — the interview-driven super-planner
      // needs a free-text "what are you building?" answer before its first
      // turn. Do NOT flip the latch yet (the modal stays freely cancellable).
      setLaunchError(null);
      setPendingDesign(false);
      setPendingLaunchWorkflowId(selection.workflowId);
      setLaunchPromptOpen(true);
      return;
    }
    void launchRun(selection.workflowId);
  }, [selection, workflowMetas, startQuickSession, launchRun, permissionMode, agentRuntime, model, fastMode, reasoningEffort, disabledMcpServers, enabledPlugins, pluginBaseline, worktreeModeOverride, mixedProviderPrompt]);

  const handleIdeaPicked = useCallback(
    // `opts.separateIdeaIds` ("Plan separately", IDEA-009) is deliberately NOT
    // threaded here: a successful launchRun navigates away (goToSession) and its
    // in-flight latch is only reset on failure, so firing N+1 sequential
    // launches from this surface is unsafe (unlike WorkflowPicker /
    // QuickSessionCanvas, which never navigate away). Only the batch/single
    // launch fires; peeled-off ideas are left unlaunched.
    (ideaIds: string[]) => {
      setIdeaPickerOpen(false);
      if (pendingDesign) {
        // Design is single-select (the modal's `multi` prop is forced false
        // for it below), so exactly one id comes back.
        setPendingDesign(false);
        const ideaId = ideaIds[0];
        if (ideaId !== undefined) void launchDesign(ideaId);
        return;
      }
      if (pendingWorkflowId === null) return;
      // A 1-element batch and a single-idea launch are behaviorally identical
      // downstream, but the singular `ideaId` path is the well-trodden one —
      // normalize down to it rather than sending a 1-element `ideaIds` array.
      if (ideaIds.length === 1) {
        void launchRun(pendingWorkflowId, { ideaId: ideaIds[0] });
      } else if (ideaIds.length > 1) {
        void launchRun(pendingWorkflowId, { ideaIds });
      }
    },
    [pendingDesign, pendingWorkflowId, launchRun, launchDesign],
  );

  const handleBatchPicked = useCallback(
    (taskIds: string[]) => {
      setBatchPickerOpen(false);
      if (taskIds.length === 0) return;
      // The sprint workflow id is the current selection (handleStart resolved it
      // before opening the picker, and the modal blocks re-selection meanwhile).
      if (selection?.kind !== 'workflow') return;
      void launchBatch(selection.workflowId, taskIds);
    },
    [selection, launchBatch],
  );

  const handleLaunchPromptSubmit = useCallback(
    (seedPrompt: string): void => {
      setLaunchPromptOpen(false);
      if (pendingLaunchWorkflowId === null) return;
      void launchRun(pendingLaunchWorkflowId, undefined, undefined, undefined, seedPrompt);
    },
    [pendingLaunchWorkflowId, launchRun],
  );

  // Mixed-provider retry prompt — confirm re-invokes the stashed thunk (the
  // exact same launch, forced to programmatic); cancel just dismisses.
  const handleMixedProviderConfirm = useCallback(() => {
    const pending = mixedProviderPrompt;
    setMixedProviderPrompt(null);
    pending?.retry();
  }, [mixedProviderPrompt]);

  const handleMixedProviderCancel = useCallback(() => {
    const pending = mixedProviderPrompt;
    setMixedProviderPrompt(null);
    void cleanupUnusedHostedSession(pending?.sessionId ?? null);
  }, [mixedProviderPrompt, cleanupUnusedHostedSession]);

  // ── CTA label / disabled ─────────────────────────────────────────────────
  const ctaBusy = isLaunching || isQuickStarting;
  const workflowRuntimeBlocked =
    selection?.kind === 'workflow' && workflowRuntimeForLaunch(agentRuntime) === null;
  const effectiveRuntime: LaunchAgentRuntime =
    selection?.kind === 'ultracode'
      ? 'claude-interactive'
      : selection?.kind === 'design'
        ? 'claude-sdk'
        : agentRuntime;
  const effectiveProvider = providerForRuntime(effectiveRuntime);
  const effectiveSubstrate = substrateForRuntime(effectiveRuntime);
  const selectedMeta =
    selection?.kind === 'workflow'
      ? workflowMetas.find((m) => m.id === selection.workflowId)
      : undefined;
  let ctaLabel: string;
  if (selection === null) {
    ctaLabel = 'Select a workflow';
  } else if (selection.kind === 'quick') {
    ctaLabel = 'Start quick session';
  } else if (selection.kind === 'ultracode') {
    ctaLabel = 'Run /ultracode';
  } else if (selection.kind === 'design') {
    ctaLabel = 'Start design session';
  } else {
    ctaLabel = `Run ${selectedMeta?.slashCommand ?? '/workflow'}`;
  }

  // Human-readable agent-permission label for the launch summary.
  const permissionLabel =
    PERMISSION_MODE_OPTIONS.find((o) => o.id === permissionMode)?.label ?? permissionMode;

  // ── "Save as default" (③ Configure) ──────────────────────────────────────
  /**
   * Persist the Configure knobs as the stored default for the CURRENT card's
   * run-type key. Independent of launching in BOTH directions: this never starts
   * a session/run, and the CTA never writes a default. It must never touch the
   * live launch controls, so the launch payload is identical before and after a
   * save. (The store's post-write fetchConfig does refresh `runTypeDefaults`,
   * which feeds useSeededSelection's seed — harmless, since the value just
   * stored IS the live value.)
   *
   * `design` is excluded from the stored-defaults surface entirely: it renders
   * no CTA and gets a null key, so there is nothing to write.
   */
  const saveDefaultLabel =
    selection?.kind === 'workflow'
      ? workflowMetas.find((m) => m.id === selection.workflowId)?.title ?? 'this flow'
      : // Quick AND Ultracode both write the synthetic global 'quick' key, so
        // the label says "Quick sessions" for both rather than naming the card.
        'Quick sessions';
  const {
    save: saveDefault,
    undo: undoSaveDefault,
    canUndo: canUndoSaveDefault,
    isSaving: isSavingDefault,
    toast: saveToast,
    dismissToast: dismissSaveToast,
  } = useSaveRunTypeDefault({
    key: selection === null || selection.kind === 'design' ? null : runTypeKey,
    label: saveDefaultLabel,
  });

  const handleSaveDefault = useCallback(() => {
    saveDefault({
      model,
      permissionMode,
      // The runtime this card would actually launch on (Ultracode pins
      // interactive; the picker is hidden for it), not the raw picker state.
      agentRuntime: effectiveRuntime,
      // `?? null` (delete), NOT undefined (leave untouched): a Codex runtime has
      // no substrate projection, and leaving a previously-stored Claude
      // substrate behind would pair a stale 'sdk'/'interactive' with a Codex
      // agentRuntime in the same entry.
      substrate: substrateForRuntime(effectiveRuntime) ?? null,
      // Effort is captured ONLY from the quick card — the only one with an
      // effort control. `?? null` because the control's "Default" option means
      // "no explicit selection", which must CLEAR any stored effort rather than
      // leave it standing. Ultracode shares this key but is excluded: it pins
      // xhigh at spawn with no control, so writing it would persist a value the
      // user never chose. A workflow's per-agent effort lives in the step
      // inspector. Variant and quick worktree mode are out of scope for v1.
      ...(selection?.kind === 'quick' ? { reasoningEffort: reasoningEffort ?? null } : {}),
    });
  }, [saveDefault, selection?.kind, model, permissionMode, effectiveRuntime, reasoningEffort]);

  /**
   * The value the reasoning-effort control was SEEDED with, restated exactly as
   * the seeding effect above resolves it: the stored quick effort when one is
   * stored AND it is on the current provider's scale, else `null` ("provider
   * default", the control's own untouched state). Only the quick card has an
   * effort control (and only it writes the field), so every other card seeds
   * `null` and the comparison below is a no-op for them.
   */
  const reasoningEffortSeed: ReasoningEffort | null =
    storedQuickEffort !== undefined &&
    isValidEffortForProvider(effectiveProvider, storedQuickEffort)
      ? storedQuickEffort
      : null;

  /**
   * Whether the Configure controls currently differ from what they were SEEDED
   * with — the sole visibility condition for the save CTA (there is nothing to
   * save while the screen already shows the stored default).
   *
   * Compared against the seeds, never against `isTouched`: `setByUser` latches on
   * ANY user pick, including one that sets a control straight back to the value
   * it already held, which would strand the CTA on screen with nothing to write.
   * Seed-comparison instead makes the affordance self-correcting — reverting a
   * change hides it again, a successful save re-seeds the controls to the values
   * just stored (so it hides itself), and an Undo re-seeds them back (so it
   * returns).
   *
   * The compared set is exactly the set `handleSaveDefault` writes, minus
   * `substrate` (derived from the runtime, so the runtime comparison covers it).
   * Effort therefore counts on the QUICK card only — the one card that writes
   * the field (ultracode shares the key but pins xhigh with no control, and the
   * `reasoningEffort` state itself is wizard-wide, so an unguarded comparison
   * would leak a quick-card effort pick onto a workflow card as a phantom
   * "dirty"). The runtime compared is the PICKER's value against the picker's
   * seed — not `effectiveRuntime`, whose card-kind pins (ultracode/design) are
   * not control state and would read as permanently dirty.
   */
  const isSaveDefaultDirty =
    model !== modelSeed ||
    permissionMode !== permissionModeSeed ||
    agentRuntime !== runtimeSeed ||
    (selection?.kind === 'quick' && reasoningEffort !== reasoningEffortSeed);

  const combinedError = launchError ?? quickError;

  // Selected-project banner card — shared by the workflow step (②) and the
  // configure step (③).
  const projectBannerCard = (
    <div className="flex flex-col gap-1 border border-border-emphasized bg-surface-primary p-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true">📁</span>
        <span
          className="truncate text-text-primary"
          style={{ fontSize: '14px', fontWeight: 700 }}
        >
          {banner.name}
        </span>
        <span className="ml-auto truncate font-mono text-xs text-status-success">
          ⌥ {banner.branch ?? '—'}
        </span>
      </div>
      <span className="truncate font-mono text-xs text-text-secondary" title={banner.path ?? undefined}>
        {banner.path ?? '—'}
      </span>
    </div>
  );

  return (
    <div className="relative h-full w-full overflow-y-auto" style={GRID_BG_STYLE}>
      <div className="mx-auto w-full max-w-[720px] px-6 py-8">
        {/* Focused-paper card — a white sheet capped with the green hazard
            stripe, floating on the graph-paper grid. Mirrors the review-queue
            home (CaughtUpHero) so every page of the wizard reads as the same
            surface. All step content (header + step body) lives inside it. */}
        <div className="border border-border-primary bg-surface-primary">
          <div className="h-2 w-full" style={HAZARD_STRIPE_STYLE} />

          <div className="flex flex-col gap-4 px-6 py-6">
            <WizardStepHeader
              locked={locked}
              step={step}
              onBackToQueue={handleBackToQueue}
              onChangeProject={handleChangeProject}
              onBackToWorkflow={handleBackToWorkflow}
            />

            {/* Keep the mixed-provider decision at the top of the wizard card.
                It is sticky so a long Configure form cannot hide the user's
                only actionable retry/cancel choice below the fold. */}
            {mixedProviderPrompt !== null && (
              <div
                data-testid="mixed-provider-switch-prompt"
                role="alertdialog"
                aria-label="Switch to programmatic execution"
                className="sticky top-2 z-20 flex flex-col gap-2 border border-status-warning/30 bg-status-warning/10 p-3"
              >
                <p className="text-sm text-status-warning">
                  This flow runs one or more steps on Codex, which requires programmatic execution. Switch this run to programmatic and launch?
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleMixedProviderConfirm}
                    data-testid="mixed-provider-switch-confirm"
                    className="flex-1 bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover"
                  >
                    Switch & launch
                  </button>
                  <button
                    type="button"
                    onClick={handleMixedProviderCancel}
                    data-testid="mixed-provider-switch-cancel"
                    className="flex-1 rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

        {/* ── Step 1: project grid (unlocked only) ── */}
        {!locked && step === 1 && (
          <div className="flex flex-col gap-3">
            <span className="eyebrow text-text-secondary">Choose a project</span>
            {projectsLoading && (
              <p className="text-xs text-text-secondary">Loading projects…</p>
            )}
            {projectsError !== null && (
              <p className="text-xs text-status-error" role="alert">
                {projectsError}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              {projects.map((project) => (
                <ProjectFilingCard
                  key={project.id}
                  project={project}
                  selected={selectedProjectId === project.id}
                  onSelect={() => handleSelectProject(project.id)}
                />
              ))}
              <AddProjectCard onClick={() => setCreateOpen(true)} />
            </div>
          </div>
        )}

        {/* ── Step 2: workflow list ── */}
        {step === 2 && selectedProjectId !== null && (
          <div className="flex flex-col gap-4 pb-24">
            {projectBannerCard}

            {/* Quick session (featured, allowQuick only) */}
            {allowQuick && (
              <QuickSessionCard
                selected={selection?.kind === 'quick'}
                onSelect={() => {
                  // No control needs an imperative seed here: the selection
                  // change flips useSeededSelection's key/seed and every seeded
                  // control (model, permission, runtime) re-seeds reactively —
                  // untouched keys only.
                  setSelection({ kind: 'quick' });
                  setStep(3);
                }}
              />
            )}

            {/* Ultracode — featured peer of Quick session: an interactive
                session in ultracode mode (launches like quick), so it sits with
                the featured options above the "run a workflow" divider. */}
            <UltracodeCard
              selected={selection?.kind === 'ultracode'}
              onSelect={() => {
                setSelection({ kind: 'ultracode' });
                setStep(3);
              }}
            />

            {/* Design (design-mode.md, v0) — featured peer of Quick/Ultracode,
                gated on allowQuick like Quick: its launch ultimately calls
                startQuickSession (useQuickSession's hook is constructed with
                `projectId: allowQuick ? selectedProjectId : null` above), which
                no-ops without a project id. Selecting it does NOT launch from
                here — the CTA on ③ opens the idea picker first (handleStart). */}
            {allowQuick && (
              <DesignCard
                selected={selection?.kind === 'design'}
                onSelect={() => {
                  setSelection({ kind: 'design' });
                  setStep(3);
                }}
              />
            )}

            {/* Divider — separates the featured launchers from the structured
                workflow list (shown only when quick launches are allowed). */}
            {allowQuick && (
              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 border-t border-dashed border-border-primary" />
                <span className="eyebrow text-text-muted">or run a workflow</span>
                <span className="h-px flex-1 border-t border-dashed border-border-primary" />
              </div>
            )}

            {/* Workflow list */}
            {workflowsLoading && (
              <p className="text-xs text-text-secondary">Loading workflows…</p>
            )}
            {workflowsError !== null && (
              <p className="text-xs text-status-error" role="alert">
                {workflowsError}
              </p>
            )}
            {/* Setup flows (verify-setup) are filtered HERE, at the render
                site, and not out of `workflowMetas` itself — the array is
                indexed by id on five other paths in this file (launch, banner,
                CTA label, planner check), and a setup flow launched from its
                own surface still has to resolve its meta through them. */}
            <div className="flex flex-col gap-2">
              {launcherWorkflowMetas(workflowMetas).map((meta) => (
                <WorkflowListRow
                  key={meta.id}
                  meta={meta}
                  selected={
                    selection?.kind === 'workflow' && selection.workflowId === meta.id
                  }
                  onSelect={() => {
                    // Selecting a workflow auto-advances to ③ Configure. The
                    // initial default pre-selection (in loadWorkflows) only sets
                    // state — it never calls setStep — so the wizard does NOT
                    // auto-jump on load; only a user click advances. That
                    // pre-selection now DOES seed every Configure control (the
                    // hooks key off `workflow:<id>` reactively), which with
                    // nothing configured still resolves to exactly the previous
                    // values (Opus floor, global permission, SDK runtime).
                    setSelection({ kind: 'workflow', workflowId: meta.id });
                    setStep(3);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Step 3: configure session settings + launch ── */}
        {step === 3 && selectedProjectId !== null && selection !== null && (
          <div className="flex flex-col gap-4" data-testid="wizard-step3">
            {projectBannerCard}

            {/* Agent runtime — shown before the model because runtime controls
                which model family is available. Workflow launches allow workflow
                runtimes only; quick launches also allow Codex PTY. Hidden for
                Ultracode, which always uses Claude interactive PTY, AND for
                Design, which is hard-pinned to the Claude SDK substrate
                (design-mode.md "Session plumbing" — a security boundary, since
                the MCP scope mechanism that limits a design session's toolset
                exists only on the SDK path). */}
            {selection.kind !== 'ultracode' && selection.kind !== 'design' && (
              <div {...{ [ONBOARDING_ANCHOR_ATTR]: ONBOARDING_ANCHORS.substrateSelect }}>
                <SubstrateSelector
                  value={agentRuntime}
                  // A real per-launch pick — latches THIS key touched, so the
                  // card's stored/global default stops re-seeding it (and only it).
                  onChange={setAgentRuntimeByUser}
                  id="wizard-substrate"
                  caveatsTestId="wizard-substrate-caveats"
                  runtimeScope={selection.kind === 'quick' ? 'session' : 'workflow'}
                />
              </div>
            )}

            {/* Session permission — shown for BOTH workflow and quick launches; an
                explicit choice writes the host session's agent_permission_mode (the
                sole execution authority) for either launch kind. Provider-specific
                copy stays below runtime because runtime controls the provider. */}
            <div {...{ [ONBOARDING_ANCHOR_ATTR]: ONBOARDING_ANCHORS.sessionPermission }}>
              <AgentPermissionModeSelector
                value={permissionMode}
                onChange={setPermissionModeByUser}
                agentProvider={effectiveProvider}
                agentRuntime={effectiveRuntime}
              />
            </div>

            {/* Model picker — shown for ALL launch kinds and scoped to the selected
                runtime/provider. Quick + ultracode thread it into useQuickSession
                (→ the claude panel / interactive eager spawn); workflow threads
                it into runs.start ({ model }) → workflow_runs.model (migration
                037). Ultracode defaults to Fable when available (the per-key
                model seed). Fast mode stays QUICK-only. OMP Fleet has no model
                picker — it runs on the producer default (DEFAULT_OMP_MODEL), so
                the control is hidden for that runtime rather than shown as a
                lie. */}
            {effectiveRuntime !== 'omp-fleet' && (
              <div {...{ [ONBOARDING_ANCHOR_ATTR]: ONBOARDING_ANCHORS.modelSelect }}>
                <ModelSelector
                  value={model}
                  onChange={(m) => {
                    // setByUser latches THIS key as touched, so reactive re-seeding
                    // stops for it (and only for it).
                    setModelByUser(m);
                    // Fast mode is Opus-only; drop it when leaving Opus.
                    if (!isOpusModel(m)) setFastMode(false);
                  }}
                  id="wizard-model"
                  agentProvider={effectiveProvider}
                  agentRuntime={effectiveRuntime}
                />
              </div>
            )}
            {/* Reasoning-effort select — QUICK, every effort-capable runtime.
                Shown for Claude (SDK Options.effort / interactive --effort) AND
                codex-sdk (startCodexSdkTurn → buildCodexAppServerTurnOptions maps
                it onto the app-server turn). Excluded for a runtime whose
                RUNTIME_CAPABILITIES.supportsEffort is false — codex-pty, whose
                PTY CLI has no turn-options object to carry the flag. Ultracode is
                a separate card (selection.kind==='ultracode'): its interactive
                spawn pins xhigh and suppresses --effort, so no select there.
                effortLevelsForProvider adapts the scale (Codex none..xhigh). */}
            {selection.kind === 'quick' && runtimeSupportsEffort(effectiveRuntime) && (
              <div className="flex flex-col gap-1">
                <label htmlFor="wizard-effort" className="text-xs font-medium text-text-secondary">
                  Reasoning effort
                </label>
                <select
                  id="wizard-effort"
                  value={reasoningEffort ?? ''}
                  onChange={(e) =>
                    setReasoningEffort(e.target.value === '' ? null : (e.target.value as ReasoningEffort))
                  }
                  className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
                  aria-label="Select reasoning effort"
                  data-testid="wizard-effort-select"
                >
                  <option value="">Default</option>
                  {effortLevelsForProvider(effectiveProvider).map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {/* Fast mode — Opus-only, and only on a runtime that carries it
                (RUNTIME_CAPABILITIES.supportsFastMode: both Claude runtimes; no
                Codex analogue). */}
            {selection.kind === 'quick' && runtimeSupportsFastMode(effectiveRuntime) && isOpusModel(model) && (
              <div
                data-testid="wizard-fast-mode-row"
                className="flex items-center justify-between gap-3 rounded-button border border-border-secondary bg-surface-secondary px-3 py-2"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-text-primary">Fast mode</span>
                  <span className="text-xs text-text-tertiary">
                    Faster Opus output · premium · default off
                  </span>
                </div>
                <Switch
                  id="wizard-fast-mode"
                  checked={fastMode}
                  onCheckedChange={(v) => setFastMode(v === true)}
                  aria-label="Fast mode"
                />
              </div>
            )}

            {/* Per-run A/B variant selector (migration 048), WORKFLOW only — hidden
                entirely for a workflow with zero variants. Threaded into
                runs.start as variantId / baseline (never both); rotation sends
                neither field. */}
            {selection.kind === 'workflow' && (
              <VariantSelector
                workflowId={selection.workflowId}
                value={variantSelection}
                onChange={setVariantSelection}
                id="wizard-variant"
              />
            )}
            {/* Advanced (QUICK + ULTRACODE): workspace plus Claude-only MCP/plugin
                selection. These are a session-START decision — the deny-list is
                enforced at the first spawn, so toggling mid-conversation was
                confusing and could leak a disabled server back via the CLI's
                settingSources auto-load. Both substrates enforce the selection:
                SDK (composeMcpServers delete + strictMcpConfig + disallowedTools)
                and interactive PTY (--disallowed-tools mcp__<srv> +
                disabledMcpjsonServers + enabledPlugins via --settings) — ultracode
                is an interactive Claude quick session, so it gets the same controls.
                Codex quick runtimes do not consume these launch selections, so the
                MCP/plugin rows are omitted instead of implying enforcement.
                Collapsed by default; the pills are controlled (no sessionId yet →
                wizard owns the state and threads it into createQuick). */}
            {(selection.kind === 'quick' || selection.kind === 'ultracode') && (
              <div className="rounded-button border border-border-secondary bg-surface-secondary">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  data-testid="wizard-advanced-toggle"
                  aria-expanded={showAdvanced}
                  className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-text-primary"
                >
                  <span>Advanced</span>
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 text-text-tertiary transition-transform',
                      showAdvanced && 'rotate-180',
                    )}
                  />
                </button>
                {showAdvanced && (
                  <div
                    className="flex flex-col gap-3 border-t border-border-secondary px-3 py-3"
                    data-testid="wizard-advanced-body"
                  >
                    {effectiveProvider === 'claude' && (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium text-text-primary">MCP servers</span>
                            <span className="text-xs text-text-tertiary">
                              Disable servers this session should not load
                            </span>
                          </div>
                          <McpTogglePill disabled={disabledMcpServers} onChange={setDisabledMcpServers} />
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex flex-col">
                            <span className="text-sm font-medium text-text-primary">Plugins</span>
                            <span className="text-xs text-text-tertiary">
                              Reflects your enabled plugins — turn any off for this session
                            </span>
                          </div>
                          <PluginTogglePill selected={enabledPlugins} onChange={setEnabledPlugins} />
                        </div>
                      </>
                    )}

                    {/* Workspace — where this quick session's working tree lives.
                        'Use global setting' omits worktreeMode (createQuick floors to
                        the Settings default); 'In place' skips worktree creation and
                        works directly in the checkout (sessions.in_place, migration
                        047). Available on both substrates — the interactive gate
                        rides the inline --settings flag, no checkout writes. */}
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium text-text-primary">Workspace</span>
                        <span className="text-xs text-text-tertiary">
                          In place works directly in your checkout — no isolation, and workflows launched from the session open in a separate worktree-backed session
                        </span>
                      </div>
                      <div className="flex gap-1.5" role="radiogroup" aria-label="Workspace">
                        {([
                          { value: 'inherit', label: 'Use global setting', testid: 'wizard-worktree-inherit' },
                          { value: 'worktree', label: 'Own worktree', testid: 'wizard-worktree-worktree' },
                          { value: 'in-place', label: 'In place (project checkout)', testid: 'wizard-worktree-inplace' },
                        ] as const).map(({ value, label, testid }) => (
                          <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={worktreeModeOverride === value}
                            onClick={() => setWorktreeModeOverride(value)}
                            data-testid={testid}
                            className={cn(
                              'flex-1 rounded-button border px-2 py-1.5 text-xs font-medium transition-colors',
                              worktreeModeOverride === value
                                ? 'border-interactive bg-interactive-surface text-text-primary'
                                : 'border-border-secondary bg-bg-primary text-text-secondary hover:bg-surface-hover',
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Advanced (WORKFLOW only): per-run code-review-eval override. Evals
                only fire for built-in flows at their human-review step, so this is
                meaningless for a quick session and is not shown there. 'Use global
                setting' omits the field (inherit the Settings toggle); On/Off pin
                workflow_runs.eval_enabled for this run (migration 044). Collapsed by
                default — reuses showAdvanced (only one selection kind renders). */}
            {selection.kind === 'workflow' && (
              <div className="rounded-button border border-border-secondary bg-surface-secondary">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  data-testid="wizard-workflow-advanced-toggle"
                  aria-expanded={showAdvanced}
                  className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-text-primary"
                >
                  <span>Advanced</span>
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 text-text-tertiary transition-transform',
                      showAdvanced && 'rotate-180',
                    )}
                  />
                </button>
                {showAdvanced && (
                  <div
                    className="flex flex-col gap-2 border-t border-border-secondary px-3 py-3"
                    data-testid="wizard-workflow-advanced-body"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-text-primary">Quality eval</span>
                      <span className="text-xs text-text-tertiary">
                        LLM-jury review of this run's diff at the review step
                      </span>
                    </div>
                    <div
                      className="flex gap-1.5"
                      role="radiogroup"
                      aria-label="Quality eval"
                    >
                      {([
                        { value: 'inherit', label: 'Use global setting' },
                        { value: 'on', label: 'On' },
                        { value: 'off', label: 'Off' },
                      ] as const).map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={evalOverride === value}
                          onClick={() => setEvalOverride(value)}
                          data-testid={`wizard-eval-${value}`}
                          className={cn(
                            'flex-1 rounded-button border px-2 py-1.5 text-xs font-medium transition-colors',
                            evalOverride === value
                              ? 'border-interactive bg-interactive-surface text-text-primary'
                              : 'border-border-secondary bg-bg-primary text-text-secondary hover:bg-surface-hover',
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {/* Per-run visual-verification override. 'Use global setting'
                        omits the field (inherit visualVerify.enabled / project
                        `.cyboflow/verify.json`); On/Off pin
                        workflow_runs.verify_enabled for this run. */}
                    <div className="mt-1 flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-text-primary">Visual verification</span>
                      <span className="text-xs text-text-tertiary">
                        Capture + LLM-judge this run's UI deliverables at the verify step
                      </span>
                    </div>
                    <div
                      className="flex gap-1.5"
                      role="radiogroup"
                      aria-label="Visual verification"
                    >
                      {([
                        { value: 'inherit', label: 'Use global setting' },
                        { value: 'on', label: 'On' },
                        { value: 'off', label: 'Off' },
                      ] as const).map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={verifyOverride === value}
                          onClick={() => setVerifyOverride(value)}
                          data-testid={`wizard-verify-${value}`}
                          className={cn(
                            'flex-1 rounded-button border px-2 py-1.5 text-xs font-medium transition-colors',
                            verifyOverride === value
                              ? 'border-interactive bg-interactive-surface text-text-primary'
                              : 'border-border-secondary bg-bg-primary text-text-secondary hover:bg-surface-hover',
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {/* Per-run execution-model override — the highest-precedence rung
                        of resolveExecutionModel. 'Use global setting' omits the field
                        (inherit Settings → Workflow Orchestration / env / the
                        'orchestrated' floor). Interactive-PTY runs hard-pin
                        orchestrated in the resolver, so an explicit 'Programmatic'
                        only takes effect on the SDK substrate. */}
                    <div className="mt-1 flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-text-primary">Orchestration</span>
                      <span className="text-xs text-text-tertiary">
                        Who walks this run's steps — SDK runs only; the terminal substrate is always orchestrated
                      </span>
                    </div>
                    <div
                      className="flex gap-1.5"
                      role="radiogroup"
                      aria-label="Orchestration"
                    >
                      {([
                        { value: 'inherit', label: 'Use global setting' },
                        { value: 'orchestrated', label: 'Orchestrated' },
                        { value: 'programmatic', label: 'Programmatic' },
                      ] as const).map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={executionModelOverride === value}
                          onClick={() => setExecutionModelOverride(value)}
                          data-testid={`wizard-execmodel-${value}`}
                          className={cn(
                            'flex-1 rounded-button border px-2 py-1.5 text-xs font-medium transition-colors',
                            executionModelOverride === value
                              ? 'border-interactive bg-interactive-surface text-text-primary'
                              : 'border-border-secondary bg-bg-primary text-text-secondary hover:bg-surface-hover',
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Workflow-only control: blueprint-editor access (there is no
                workflow to edit for a quick session). */}
            {selection.kind === 'workflow' && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditorMode('edit')}
                  data-testid="wizard-edit-flow"
                  className="flex-1 rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
                >
                  Edit blueprint
                </button>
                <button
                  type="button"
                  onClick={() => setEditorMode('create')}
                  data-testid="wizard-new-flow"
                  className="flex-1 rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
                >
                  New flow
                </button>
              </div>
            )}

            {/* Save-as-default outcome. Undo is offered ONLY for a write the
                store confirmed landed — a failure toast carries no Undo, because
                replaying it would delete a default the failed write never
                overwrote. */}
            {saveToast !== null && (
              <div
                className="fixed bottom-4 right-4 z-50"
                data-testid="wizard-save-toast"
                data-tone={saveToast.tone}
              >
                <SessionActionToast
                  message={saveToast.message}
                  isVisible
                  onDismiss={dismissSaveToast}
                  durationMs={SAVE_DEFAULT_TOAST_MS}
                  tone={saveToast.tone}
                  {...(canUndoSaveDefault
                    ? { actionLabel: 'Undo', onAction: undoSaveDefault }
                    : {})}
                />
              </div>
            )}

            {/* Launch summary — a warm sub-box inside the white card (mirrors
                the EndCta box pattern in the review-queue home). */}
            <div
              data-testid="wizard-launch-summary"
              className="flex flex-col gap-1.5 border border-border-primary bg-surface-secondary p-3"
            >
              <span className="eyebrow text-text-secondary">Launch summary</span>
              <SummaryRow label="Project" value={banner.name} />
              <SummaryRow label="Branch" value={banner.branch ?? '—'} />
              <SummaryRow
                label="Mode"
                value={
                  selection.kind === 'quick'
                    ? 'Quick session'
                    : selection.kind === 'ultracode'
                      ? 'Ultracode (/ultracode)'
                      : selection.kind === 'design'
                        ? 'Design session'
                        : selectedMeta?.slashCommand ?? '/workflow'
                }
              />
              <SummaryRow label="Permission" value={permissionLabel} />
              <SummaryRow label="Runtime" value={AGENT_RUNTIME_LABELS[effectiveRuntime]} />
              {effectiveRuntime !== 'omp-fleet' && (
                <SummaryRow
                  label="Model"
                  value={effectiveProvider === 'codex' ? model : modelDisplayLabel(model)}
                />
              )}

              {selection.kind === 'quick' && runtimeSupportsFastMode(effectiveRuntime) && isOpusModel(model) && (
                <SummaryRow label="Fast mode" value={fastMode ? 'On' : 'Off'} />
              )}
              {selection.kind === 'ultracode' && (
                <SummaryRow label="Effort" value="ultracode (xhigh + auto workflows)" />
              )}
              {/* Triage-tray seed: surfaced only for a compound launch carrying
                  selected findings (the seed is compound-only). */}
              {selectedFindingIds !== undefined &&
                selectedFindingIds.length > 0 &&
                selectedMeta?.name === 'compound' && (
                  <SummaryRow label="Findings" value={`${selectedFindingIds.length} selected`} />
                )}
            </div>

            {/* Launch CTA — last element inside the card. */}
            <div className="flex flex-col gap-2 pt-1">
              {combinedError !== null && combinedError !== undefined && (
                <p className="text-xs text-status-error" role="alert">
                  {combinedError}
                </p>
              )}
              <button
                type="button"
                onClick={handleStart}
                disabled={selection === null || ctaBusy || workflowRuntimeBlocked || mixedProviderPrompt !== null}
                data-testid="wizard-cta"
                className="w-full rounded-button bg-interactive px-4 py-2 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {ctaLabel}
              </button>
              {/* Offered ONLY once the controls diverge from their seeds (see
                  isSaveDefaultDirty): with the card already showing the stored
                  default there is nothing to write, so the affordance stays out
                  of the way. Sits BELOW the primary launch button so the reading
                  order matches the priority. Omitted entirely for `design`,
                  which is excluded from stored defaults. */}
              {selection.kind !== 'design' && isSaveDefaultDirty && (
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  fullWidth
                  onClick={handleSaveDefault}
                  disabled={isSavingDefault}
                  data-testid="wizard-save-default"
                >
                  Save as default for {saveDefaultLabel}
                </Button>
              )}
            </div>
          </div>
        )}
          </div>
        </div>
      </div>

      {/* ── Bottom-center slide-up launch toast ── */}
      {toast !== null && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
          <div
            data-testid="wizard-launch-toast"
            className="animate-slideDown border border-border-emphasized px-4 py-2 font-mono text-sm text-text-on-interactive shadow-lg motion-reduce:animate-none"
            style={{ backgroundColor: '#1a1815' }}
          >
            {toast}
          </div>
        </div>
      )}

      {/* ── Planner / Ship / Design idea gate ── */}
      {ideaPickerOpen && selectedProjectId !== null && (
        <IdeaPickerModal
          isOpen
          projectId={selectedProjectId}
          onClose={() => setIdeaPickerOpen(false)}
          onPicked={handleIdeaPicked}
          // Multi-select batch (IDEA-009) is a Planner-only affordance — Ship
          // and Design both stay single-select (Ship consumes exactly one idea
          // per run; Design binds to exactly one idea, see design-mode.md
          // "Idea link"). `!pendingDesign` short-circuits the multi check so a
          // stale pendingWorkflowId can never flip a design pick into multi
          // mode (defense in depth — handleStart already resets it on open).
          multi={
            !pendingDesign &&
            workflowMetas.find((m) => m.id === pendingWorkflowId)?.name === 'planner'
          }
          // Design's picker opens straight on the "pick existing idea" tab; its
          // "new idea" tab IS the spec's auto-mint-stub affordance (already the
          // modal's default, named explicitly here for self-documentation).
          defaultMode="pick"
          // The wizard's launch navigates away on success and cannot fire the
          // per-idea N+1 separate launches, so the pick-time split is hidden
          // here (handleIdeaPicked drops opts — see its doc comment). Design
          // picks are single-select regardless, so this is moot for it.
          allowPlanSeparately={false}
        />
      )}

      {/* ── Sprint task-batch gate ── */}
      {batchPickerOpen && selectedProjectId !== null && (
        <TaskBatchPickerModal
          isOpen
          projectId={selectedProjectId}
          substrate={effectiveSubstrate ?? DEFAULT_SUBSTRATE}
          onClose={() => setBatchPickerOpen(false)}
          onPicked={handleBatchPicked}
        />
      )}

      {/* ── Launch seed-prompt gate ── */}
      {launchPromptOpen && (
        <LaunchPromptModal
          open
          onCancel={() => setLaunchPromptOpen(false)}
          onSubmit={handleLaunchPromptSubmit}
        />
      )}

      {/* ── Add-project dialog ── */}
      {createOpen && (
        <CreateProjectDialog
          isOpen
          onClose={() => setCreateOpen(false)}
          onCreated={handleProjectCreated}
        />
      )}

      {/* ── Workflow blueprint editor (step ③, workflow path) ── */}
      {editorMode !== null && selectedProjectId !== null && selection?.kind === 'workflow' && (
        <WorkflowEditorModal
          isOpen
          mode={editorMode}
          workflowId={editorMode === 'edit' ? selection.workflowId : ''}
          projectId={selectedProjectId}
          onClose={() => setEditorMode(null)}
          onSaved={handleEditorSaved}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Banner helper — resolves name/path/branch for the selected-project banner.
// In locked mode `projects` is not loaded, so name/path come from a one-shot
// projects fetch and the branch from detectBranch.
// ---------------------------------------------------------------------------

interface ProjectBanner {
  name: string;
  path: string | null;
  branch: string | null;
}

function useActiveProjectBanner(
  projectId: number | null,
  loadedProjects: Project[],
): ProjectBanner {
  const [resolved, setResolved] = useState<Project | null>(null);
  const [branch, setBranch] = useState<string | null>(null);

  // Prefer an already-loaded project (unlocked flow); else fetch it once
  // (locked flow, where the project grid was never loaded).
  const fromLoaded =
    projectId === null ? null : loadedProjects.find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    if (projectId === null) {
      setResolved(null);
      return;
    }
    if (fromLoaded !== null) {
      setResolved(fromLoaded);
      return;
    }
    let cancelled = false;
    void API.projects
      .getAll()
      .then((res) => {
        if (cancelled) return;
        if (res.success && Array.isArray(res.data)) {
          const match = (res.data as Project[]).find((p) => p.id === projectId) ?? null;
          setResolved(match);
        }
      })
      .catch(() => {
        /* leave resolved null — banner shows em dashes */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, fromLoaded]);

  const effective = fromLoaded ?? resolved;
  const path = effective?.path ?? null;

  useEffect(() => {
    if (path === null) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    void API.projects
      .detectBranch(path)
      .then((res) => {
        if (cancelled) return;
        if (res.success && typeof res.data === 'string') setBranch(res.data);
      })
      .catch(() => {
        /* branch stays null */
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return {
    name: effective?.name ?? 'Project',
    path,
    branch,
  };
}
