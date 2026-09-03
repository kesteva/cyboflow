import { useCallback, useEffect, useRef, useState } from 'react';
import { PROVIDER_DEFAULT_RUNTIME, providerForRuntime } from '../../../../shared/types/agentRuntime';
import { normalizeAgentModelSelection } from '../../../../shared/types/agentModels';
import type { ProviderDetectionResult } from '../../../../shared/types/onboarding';
import { PROVIDERS_DETECT_CHANNEL } from '../../../../shared/types/onboarding';
import type { ReasoningEffort } from '../../../../shared/types/reasoningEffort';
import { normalizeEffortSelection } from '../../../../shared/types/reasoningEffort';
import { DEFAULT_QUICK_MODEL, QUICK_RUN_TYPE_KEY } from '../../../../shared/types/sessionDefaults';
import type { IPCResponse } from '../../utils/api';
import { API } from '../../utils/api';
import { useConfigStore } from '../../stores/configStore';
import {
  retryCodexModelCatalog,
  useCodexModelCatalog,
} from '../../stores/codexModelCatalogStore';
import { PROVIDER_MODEL_CATALOG_SLICES } from '../../stores/providerModelCatalogStore';
import {
  defaultAgentCandidates,
  isNextGateBlocked,
  skippedStepSet,
  useOnboardingStore,
  type PersistedOnboarding,
  type PersistedOnboardingV4,
} from '../../stores/onboardingStore';
import { onboardingTelemetryEvents } from '../../stores/onboardingTelemetry';
import {
  isGuidedStep,
  ONBOARDING_DEFAULT_RUNTIME_STEP,
  ONBOARDING_HANDOFF_STEP,
  ONBOARDING_MODAL_STEPS,
  ONBOARDING_MODEL_STEP,
  ONBOARDING_PREF_KEY,
} from '../../utils/onboarding';
import { emitTelemetryChangeEvents, trackEvent } from '../../utils/telemetry';
import { OnboardingOverlay } from './OnboardingOverlay';
import { OnboardingModalCard, type PrimaryAction } from './OnboardingModalCard';
import { OnboardingSpiralReveal } from './OnboardingSpiralReveal';
import { WelcomeStep } from './steps/WelcomeStep';
import { ConnectStep } from './steps/ConnectStep';
import { PermissionStep } from './steps/PermissionStep';
import { TelemetryStep, type TelemetryDraft } from './steps/TelemetryStep';
import { DefaultRuntimeStep } from './steps/DefaultRuntimeStep';
import { ModelStep } from './steps/ModelStep';
import { HandoffStep } from './steps/HandoffStep';
import { stageTourExit } from './guided/guidedFinish';

/**
 * OnboardingGate — the single side-effect host around the pure onboardingStore,
 * scoped to the MODAL half of the tour (steps 0-6). Owns boot hydration (the
 * persisted snapshot, gated so nothing renders until it resolves — the no-flash
 * rule), snapshot persistence, usage telemetry, arrow-key navigation, the step-1
 * credential probe, and every step's config write: provider access, default
 * agent runtime, model + reasoning effort, permission mode, telemetry consent.
 * The store stays synchronously testable; every async lives here.
 *
 * Mounted once, app-wide, from App.tsx, and stays mounted for the whole tour.
 * It renders the overlay only while the tour is 'active' AND standing on a modal
 * step — the two guided set-up screens (7-8) are owned by GuidedSetupSurface
 * inside the shell row, so this component renders null there while keeping its
 * hydration/persistence/telemetry subscriptions alive.
 */

const MISSING_DETECTION: ProviderDetectionResult<'claude'> = {
  credentials: { found: false, source: null, account: null },
  binary: { found: false, path: null, version: null },
  state: 'missing',
};

const UNAVAILABLE_CODEX_DETECTION: ProviderDetectionResult<'codex'> = {
  runtime: { found: false, path: null, version: null },
  account: { found: false, email: null, planType: null },
  state: 'unavailable',
};

const UNAVAILABLE_OMP_DETECTION: ProviderDetectionResult<'omp'> = {
  binaryPath: null,
  version: null,
  state: 'unavailable',
};

/** Step-3 effort floor per provider, used when nothing valid is persisted. */
const DEFAULT_EFFORT: Record<'claude' | 'codex', ReasoningEffort> = {
  claude: 'high',
  codex: 'medium',
};

export function OnboardingGate(): React.JSX.Element | null {
  const hydrated = useOnboardingStore((s) => s.hydrated);
  const status = useOnboardingStore((s) => s.status);
  const step = useOnboardingStore((s) => s.step);
  const maxVisitedStep = useOnboardingStore((s) => s.maxVisitedStep);
  const detection = useOnboardingStore((s) => s.detection);
  const connected = useOnboardingStore((s) => s.connected);
  const codexDetection = useOnboardingStore((s) => s.codexDetection);
  const codexConnected = useOnboardingStore((s) => s.codexConnected);
  const ompDetection = useOnboardingStore((s) => s.ompDetection);
  const ompConnected = useOnboardingStore((s) => s.ompConnected);
  const permMode = useOnboardingStore((s) => s.permMode);
  const defaultProvider = useOnboardingStore((s) => s.defaultProvider);
  const multiRuntime = useOnboardingStore((s) => s.multiRuntime);
  const assistantAvailable = useOnboardingStore((s) => s.assistantAvailable);
  const defaultModel = useOnboardingStore((s) => s.defaultModel);
  const defaultEffort = useOnboardingStore((s) => s.defaultEffort);
  const modelPhase = useOnboardingStore((s) => s.modelPhase);
  const handoffChoice = useOnboardingStore((s) => s.handoffChoice);

  const hydrate = useOnboardingStore((s) => s.hydrate);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const goTo = useOnboardingStore((s) => s.goTo);
  const skip = useOnboardingStore((s) => s.skip);
  const setDetection = useOnboardingStore((s) => s.setDetection);
  const setConnected = useOnboardingStore((s) => s.setConnected);
  const setCodexDetection = useOnboardingStore((s) => s.setCodexDetection);
  const setCodexConnected = useOnboardingStore((s) => s.setCodexConnected);
  const setOmpDetection = useOnboardingStore((s) => s.setOmpDetection);
  const setOmpConnected = useOnboardingStore((s) => s.setOmpConnected);
  const setPermMode = useOnboardingStore((s) => s.setPermMode);
  const setDefaultProvider = useOnboardingStore((s) => s.setDefaultProvider);
  const setDefaultModel = useOnboardingStore((s) => s.setDefaultModel);
  const setDefaultEffort = useOnboardingStore((s) => s.setDefaultEffort);
  const setModelPhase = useOnboardingStore((s) => s.setModelPhase);
  const setHandoffChoice = useOnboardingStore((s) => s.setHandoffChoice);

  const [checking, setChecking] = useState(false);
  // Step-5 (telemetry) draft, resolved fresh from AppConfig.telemetry every
  // time the step is (re-)entered — see the resolve effect below. null = not yet
  // resolved (config not loaded, or step just entered before config's around).
  const [telemetryDraft, setTelemetryDraft] = useState<TelemetryDraft | null>(null);
  const [telemetrySubmitting, setTelemetrySubmitting] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  // Snapshot of the resolved config at telemetry-step entry — the diff base for
  // which channel(s) actually changed (telemetry_opt_out_changed fires
  // per-changed-channel only, never for an unchanged one).
  const telemetryBaselineRef = useRef<TelemetryDraft | null>(null);

  // Persist the snapshot on any (status, step) change once hydrated. Registered
  // before hydration resolves so the initial idle→active/completed write lands.
  useEffect(() => {
    return useOnboardingStore.subscribe((state, prev) => {
      if (!state.hydrated || state.status === 'idle') return;
      if (state.status === prev.status && state.step === prev.step) return;
      const snapshot: PersistedOnboardingV4 = { version: 4, status: state.status, step: state.step };
      void window.electron?.invoke('preferences:set', ONBOARDING_PREF_KEY, JSON.stringify(snapshot));
    });
  }, []);

  // Emit onboarding usage telemetry off the same store transitions. Registered
  // before hydration resolves so the pristine first-run 'started' is caught. The
  // transition→event decision is a pure function (onboardingTelemetry); this shell
  // just fires each result. Every step the user sees emits onboarding_step_viewed.
  useEffect(() => {
    return useOnboardingStore.subscribe((state, prev) => {
      for (const ev of onboardingTelemetryEvents(prev, state)) {
        switch (ev.name) {
          case 'onboarding_started':
            trackEvent('onboarding_started', ev.props);
            break;
          case 'onboarding_step_viewed':
            trackEvent('onboarding_step_viewed', ev.props);
            break;
          case 'onboarding_skipped':
            trackEvent('onboarding_skipped', ev.props);
            break;
          case 'onboarding_resumed':
            trackEvent('onboarding_resumed', ev.props);
            break;
          case 'onboarding_dismissed':
            trackEvent('onboarding_dismissed', ev.props);
            break;
          case 'onboarding_completed':
            trackEvent('onboarding_completed', ev.props);
            break;
        }
      }
    });
  }, []);

  // Boot hydration, on the SHORT path wherever one exists. The project count is
  // consulted only when there is NO persisted snapshot (hydrate's pristine
  // branch), and API.projects.getAll runs `git rev-list` per project — so an
  // install that has a snapshot must never pay for it. An install upgrading into
  // the feature (no snapshot, N projects) fetches the list exactly once, after
  // which the 'completed' snapshot it writes takes this path too.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let parsed: PersistedOnboarding | null = null;
      try {
        const raw = (await window.electron?.invoke('preferences:get', ONBOARDING_PREF_KEY)) as
          | IPCResponse<string>
          | undefined;
        if (raw?.success && typeof raw.data === 'string' && raw.data.length > 0) {
          parsed = JSON.parse(raw.data) as PersistedOnboarding;
        }
      } catch {
        parsed = null;
      }
      if (cancelled) return;
      if (parsed !== null) {
        hydrate(parsed, 0);
        return;
      }
      let projectsCount = 0;
      try {
        const res = await API.projects.getAll();
        if (res.success && Array.isArray(res.data)) projectsCount = res.data.length;
      } catch {
        /* projects unavailable — treat as pristine */
      }
      if (cancelled) return;
      hydrate(null, projectsCount);
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  // E2E boot marker: the tour scrim hydrates asynchronously, so a fixed-timeout
  // probe in the test helpers races it under machine load. 'active' = the scrim
  // is (or is about to be) up; 'resolved' = this boot will not show it.
  useEffect(() => {
    if (!hydrated) return;
    document.body.dataset.onboarding = status === 'active' ? 'active' : 'resolved';
  }, [hydrated, status]);

  // The step-1 provider probes. Re-run together on Check again; each failure
  // degrades independently so one provider never hides a usable sibling.
  const runDetect = useCallback(async () => {
    setChecking(true);
    const [claudeResponse, codexResponse, ompResponse] = await Promise.all([
      window.electron?.invoke(PROVIDERS_DETECT_CHANNEL, 'claude').catch(() => undefined) as
        | Promise<IPCResponse<ProviderDetectionResult<'claude'>> | undefined>
        | undefined,
      window.electron?.invoke(PROVIDERS_DETECT_CHANNEL, 'codex').catch(() => undefined) as
        | Promise<IPCResponse<ProviderDetectionResult<'codex'>> | undefined>
        | undefined,
      window.electron?.invoke(PROVIDERS_DETECT_CHANNEL, 'omp').catch(() => undefined) as
        | Promise<IPCResponse<ProviderDetectionResult<'omp'>> | undefined>
        | undefined,
    ]);
    setDetection(
      claudeResponse?.success && claudeResponse.data
        ? claudeResponse.data
        : MISSING_DETECTION,
    );
    setCodexDetection(
      codexResponse?.success && codexResponse.data
        ? codexResponse.data
        : UNAVAILABLE_CODEX_DETECTION,
    );
    setOmpDetection(
      ompResponse?.success && ompResponse.data
        ? ompResponse.data
        : UNAVAILABLE_OMP_DETECTION,
    );
    setChecking(false);
  }, [setCodexDetection, setDetection, setOmpDetection]);

  useEffect(() => {
    if (
      status === 'active'
      && step === 1
      && (detection === null || codexDetection === null || ompDetection === null)
      && !checking
    ) {
      void runDetect();
    }
  }, [status, step, detection, codexDetection, ompDetection, checking, runDetect]);

  // Step-1 toggles reflect the SAVED provider access, so replaying the
  // walkthrough on a configured install opens on the user's current setting
  // rather than a blank slate (and Continue then re-persists it unchanged).
  // A pristine install has no saved value — the toggles stay off and the step
  // gate keeps demanding an explicit opt-in, exactly as before. OMP's floor is
  // the ONE difference: claude/codex default to `true` here (their absent⇒
  // enabled legacy floor), but OMP defaults to `false` — a pristine install
  // must never seed the toggle on for a provider AGENT_PROVIDER_REGISTRY.omp
  // itself floors to disabled.
  const persistedProviderAccess = useConfigStore((s) => s.config?.agentProviderAccess);
  useEffect(() => {
    if (status !== 'active' || step !== 1 || persistedProviderAccess === undefined) return;
    setConnected(persistedProviderAccess.claude ?? true);
    setCodexConnected(persistedProviderAccess.codex ?? true);
    setOmpConnected(persistedProviderAccess.omp ?? false);
  }, [status, step, persistedProviderAccess, setConnected, setCodexConnected, setOmpConnected]);

  // Telemetry-step draft resolution. Resolved ONLY from the live
  // AppConfig.telemetry (never a hardcoded true/true guess) every time the step
  // is (re-)entered — including replay (Settings → Replay walkthrough calls
  // restart(), which re-enters at step 0 and walks back through it fresh).
  // If config hasn't loaded yet, the step stays in its loading state and a
  // config-store subscription resolves the draft the moment it arrives.
  useEffect(() => {
    if (status !== 'active' || step !== 5) return;
    setTelemetryError(null);
    const resolveFromConfig = (): boolean => {
      const cfgTelemetry = useConfigStore.getState().config?.telemetry;
      if (!cfgTelemetry) return false;
      const resolved: TelemetryDraft = {
        errorReportingEnabled: cfgTelemetry.errorReportingEnabled,
        usageMetricsEnabled: cfgTelemetry.usageMetricsEnabled,
      };
      setTelemetryDraft(resolved);
      telemetryBaselineRef.current = resolved;
      return true;
    };
    if (resolveFromConfig()) return;
    setTelemetryDraft(null);
    telemetryBaselineRef.current = null;
    return useConfigStore.subscribe((state, prev) => {
      if (state.config?.telemetry && state.config.telemetry !== prev.config?.telemetry) {
        resolveFromConfig();
      }
    });
  }, [status, step]);

  // The providers that can actually BE a default agent — claude/codex only (OMP
  // is activatable on Connect but no picker offers its runtimes). These are the
  // rows step 2 offers, the set its selection must stay inside, and the fallback
  // for step 3's effective provider.
  const candidates = defaultAgentCandidates({
    detection,
    connected,
    codexDetection,
    codexConnected,
    ompDetection,
    ompConnected,
  });
  // Recomputed each render, so the JSON key (not the array identity) is what the
  // seed effect below depends on.
  const candidatesKey = candidates.join(',');

  // Step-2 seed: open on the user's SAVED default where there is one (so replay
  // on a configured install shows their current answer rather than a blank
  // slate), else the first candidate — the step's Next always has something
  // valid to persist, and no row is silently preselected that the Connect step
  // did not activate.
  const persistedDefaultRuntime = useConfigStore((s) => s.config?.defaultAgentRuntime);
  useEffect(() => {
    if (status !== 'active' || step !== ONBOARDING_DEFAULT_RUNTIME_STEP) return;
    const saved =
      persistedDefaultRuntime === undefined ? null : providerForRuntime(persistedDefaultRuntime);
    const seed =
      saved !== null && (saved === 'claude' || saved === 'codex') && candidates.includes(saved)
        ? saved
        : (candidates[0] ?? null);
    setDefaultProvider(seed);
    // `candidates` is rebuilt every render; `candidatesKey` is its stable summary.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on candidatesKey, see above
  }, [status, step, candidatesKey, persistedDefaultRuntime, setDefaultProvider]);

  /**
   * The provider step 3 asks its questions FOR. Step 2's answer when that step
   * is part of this run; otherwise the single candidate the Connect step left
   * activated. 'claude' is the last-resort floor — past the step-1 gate at least
   * one candidate always exists, so it only covers a state the tour cannot be in.
   */
  const modelProvider: 'claude' | 'codex' =
    multiRuntime && (defaultProvider === 'claude' || defaultProvider === 'codex')
      ? defaultProvider
      : (candidates[0] ?? 'claude');

  // Codex's model list is DISCOVERED, so it is fetched only while step 3 is
  // actually showing Codex rows — never on a Claude run, and never before the
  // step is reached (discovery spawns a short-lived Codex app-server).
  const codexCatalogEnabled =
    status === 'active' && step === ONBOARDING_MODEL_STEP && modelProvider === 'codex';
  const codexCatalog = useCodexModelCatalog(codexCatalogEnabled);
  const codexLoading = codexCatalogEnabled && codexCatalog.loading;
  const codexFailed = codexCatalogEnabled && !codexCatalog.loading && codexCatalog.error !== null;

  const persistedLaunchModel = useConfigStore((s) => s.config?.defaultLaunchModel);
  const persistedQuickEffort = useConfigStore(
    (s) => s.config?.runTypeDefaults?.[QUICK_RUN_TYPE_KEY]?.reasoningEffort,
  );

  // Step-3 seed. Runs once per entry into the step and again whenever the
  // effective provider changes (the answers live in the provider's own id space,
  // so a Codex model is not a legal Claude seed and vice versa). The ref, not a
  // dependency list, is what makes it once-per-entry: the effect must also run
  // when Codex discovery settles, and re-seeding then would clobber a pick the
  // user already made.
  const modelSeedRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'active' || step !== ONBOARDING_MODEL_STEP) {
      modelSeedRef.current = null; // re-seed on the next entry
      return;
    }
    // Codex's floor comes from the catalog's own default, so seeding before
    // discovery SETTLES would write a value we are about to replace. Read the
    // slice LIVE rather than through the rendered hook value: `ensureStarted`
    // flips `loading` during the same effect flush this runs in (its effect is
    // registered earlier, by the hook call above), so the rendered snapshot
    // still says "idle" on the very commit that kicks the fetch off.
    if (modelProvider === 'codex') {
      const slice = PROVIDER_MODEL_CATALOG_SLICES.codex.store.getState();
      const settled = !slice.loading && (slice.catalog !== null || slice.error !== null);
      if (!settled) return;
    }
    if (modelSeedRef.current === modelProvider) return;
    modelSeedRef.current = modelProvider;

    const savedModel = normalizeAgentModelSelection(modelProvider, persistedLaunchModel);
    const modelFloor =
      modelProvider === 'claude' ? DEFAULT_QUICK_MODEL : (codexCatalog.defaultModel ?? 'auto');
    const savedEffort = normalizeEffortSelection(modelProvider, persistedQuickEffort);
    setDefaultModel(savedModel ?? modelFloor);
    setDefaultEffort(savedEffort ?? DEFAULT_EFFORT[modelProvider]);
    setModelPhase('model');
  }, [
    status,
    step,
    modelProvider,
    codexCatalog.loading,
    codexCatalog.defaultModel,
    persistedLaunchModel,
    persistedQuickEffort,
    setDefaultModel,
    setDefaultEffort,
    setModelPhase,
  ]);

  // Unreachable catalog: 'auto' ("let the Codex runtime pick") is the one model
  // value that is valid without a catalog, so the step stays completable instead
  // of parking on a selection the user cannot see or change — including a stale
  // catalogue id left over from a run where discovery DID work. The model
  // question is thereby settled, so the card moves straight to the effort phase
  // (its list renders in place of the missing model list either way).
  useEffect(() => {
    if (!codexFailed) return;
    if (defaultModel !== 'auto') setDefaultModel('auto');
    if (modelPhase !== 'effort') setModelPhase('effort');
  }, [codexFailed, defaultModel, modelPhase, setDefaultModel, setModelPhase]);

  const handleInstall = useCallback(() => {
    if (window.electronAPI) void window.electronAPI.openExternal('https://claude.ai/code');
  }, []);

  const handleLocate = useCallback(async () => {
    const res = await API.dialog.openFile();
    if (res.success && typeof res.data === 'string' && res.data) {
      // Via the config STORE (not raw API.config.update) so the renderer's
      // cached config refreshes too — consumers seed from the store.
      await useConfigStore.getState().updateConfig({ claudeExecutablePath: res.data });
      setDetection(null); // re-arms runDetect
    }
  }, [setDetection]);

  // Step-1 provider consent IS the global provider-access setting: Continue
  // persists the toggles to AppConfig.agentProviderAccess — the exact field
  // Settings → Integrations edits — so a provider the user leaves off here is
  // hidden from every runtime picker and rejected at the launch seams. Same
  // re-entry guard and non-fatal posture as handlePermNext below.
  const connectNextInFlight = useRef(false);
  const handleConnectNext = useCallback(async () => {
    if (connectNextInFlight.current) return;
    connectNextInFlight.current = true;
    try {
      // Full access object, never a partial patch — the step gate guarantees at
      // least one of claude/codex is true, so this can never write an all-off
      // map. `omp` rides along at whatever the (optional, non-gating) toggle is
      // currently set to — false unless the user explicitly opted in.
      //
      // Providers this step has NO toggle for are carried over from what is
      // stored rather than omitted: an absent key floors to that provider's
      // default, which is DISABLED for every post-toggle provider, so listing
      // only the ones with a switch would silently clear an opt-in the user
      // made elsewhere. Onboarding can be re-entered from Settings, so this is
      // not a first-run-only path.
      //
      // With exactly ONE default-eligible candidate the conditional step 2 is
      // skipped, so THIS is the only place `defaultAgentRuntime` can be written
      // for such an install — without it a Codex-only user would launch on
      // Claude (SessionStartWizard floors an absent default to claude-sdk).
      // Two candidates leave the field alone; step 2 asks and writes it.
      const eligible = defaultAgentCandidates({
        detection,
        connected,
        codexDetection,
        codexConnected,
        ompDetection,
        ompConnected,
      });
      const soleCandidate = eligible.length === 1 ? eligible[0] : null;
      await useConfigStore.getState().updateConfig({
        agentProviderAccess: {
          ...persistedProviderAccess,
          claude: connected,
          codex: codexConnected,
          omp: ompConnected,
        },
        ...(soleCandidate !== null
          ? { defaultAgentRuntime: PROVIDER_DEFAULT_RUNTIME[soleCandidate] }
          : {}),
      });
    } catch {
      /* non-fatal — advance regardless; the toggles live on in Settings → Integrations */
    } finally {
      connectNextInFlight.current = false;
    }
    next();
  }, [
    connected,
    codexConnected,
    ompConnected,
    detection,
    codexDetection,
    ompDetection,
    persistedProviderAccess,
    next,
  ]);

  // Step-2 (default agent) Next: persists the chosen PROVIDER's structured
  // runtime into `AppConfig.defaultAgentRuntime` — the middle rung of
  // resolveRunTypeLaunchDefaults, so it seeds quick sessions and flow runs
  // alike. Via the config STORE so the renderer's cached config refreshes and
  // the wizard's seeded pickers inherit the choice without a restart. Same
  // re-entry guard and non-fatal posture as the handlers around it.
  const defaultRuntimeNextInFlight = useRef(false);
  const handleDefaultRuntimeNext = useCallback(async () => {
    if (defaultRuntimeNextInFlight.current || defaultProvider === null) return;
    defaultRuntimeNextInFlight.current = true;
    try {
      await useConfigStore.getState().updateConfig({
        defaultAgentRuntime: PROVIDER_DEFAULT_RUNTIME[defaultProvider],
      });
    } catch {
      /* non-fatal — advance regardless; the default lives on in Settings → Session settings */
    } finally {
      defaultRuntimeNextInFlight.current = false;
    }
    next();
  }, [defaultProvider, next]);

  // Step-3 (model + effort) Next, from the 'effort' phase only. TWO write
  // channels, deliberately SEQUENCED rather than raced: `updateConfig` and
  // `applyRunTypeDefault` both refetch the whole config into the same store, so
  // firing them concurrently lets the slower refetch land a snapshot taken
  // before the faster write. The effort goes to the quick run type as a MERGE —
  // `replace` would drop whatever else the user has stored under that key
  // (model, permission mode, substrate, runtime).
  const modelNextInFlight = useRef(false);
  const handleModelNext = useCallback(async () => {
    if (modelNextInFlight.current) return;
    modelNextInFlight.current = true;
    try {
      if (defaultModel !== null) {
        // `assistantModel` follows only a CLAUDE pick: the chat assistant is
        // hard-wired to ClaudeCodeManager, so a Codex id there would be spawned
        // against a runtime that cannot serve it. 'auto' is skipped for the same
        // reason it exists — it means "no explicit model", which the assistant
        // already expresses by leaving the field unset.
        await useConfigStore.getState().updateConfig({
          defaultLaunchModel: defaultModel,
          ...(modelProvider === 'claude' && defaultModel !== 'auto'
            ? { assistantModel: defaultModel }
            : {}),
        });
      }
      if (defaultEffort !== null) {
        await useConfigStore.getState().applyRunTypeDefault(QUICK_RUN_TYPE_KEY, {
          kind: 'merge',
          value: { reasoningEffort: defaultEffort },
        });
      }
    } catch {
      /* non-fatal — advance regardless; both live on in Settings → Session settings */
    } finally {
      modelNextInFlight.current = false;
    }
    next();
  }, [defaultModel, defaultEffort, modelProvider, next]);

  // Re-entry guard: the config write is async, so a second activation (held
  // ArrowRight auto-repeat, double-click) while the await is in flight would
  // otherwise call next() twice and blow past a step the user never saw.
  const permNextInFlight = useRef(false);
  const handlePermNext = useCallback(async () => {
    if (permNextInFlight.current) return;
    permNextInFlight.current = true;
    try {
      // MUST go through the config store: updateConfig persists AND refetches
      // the renderer's cached config, so downstream seeds (the wizard's
      // permission-mode useSeededSelection) inherit the choice without an app
      // restart.
      await useConfigStore.getState().updateConfig({ defaultAgentPermissionMode: permMode });
    } catch {
      /* non-fatal — advance regardless; the pill can be changed in Settings */
    } finally {
      permNextInFlight.current = false;
    }
    next();
  }, [permMode, next]);

  // Re-entry guard mirrors handlePermNext: the config write is async, so a
  // second activation while the first is in flight must not double-persist or
  // double-advance.
  const telemetryNextInFlight = useRef(false);
  const handleTelemetryNext = useCallback(async () => {
    if (telemetryNextInFlight.current || telemetryDraft === null) return;
    telemetryNextInFlight.current = true;
    setTelemetrySubmitting(true);
    setTelemetryError(null);
    try {
      // Full telemetry object, never a partial patch — installId (and the
      // sibling channel) must never be dropped by an update that only meant
      // to change one flag.
      const installId = useConfigStore.getState().config?.telemetry?.installId ?? '';
      const ok = await useConfigStore.getState().updateConfig({
        telemetry: {
          installId,
          errorReportingEnabled: telemetryDraft.errorReportingEnabled,
          usageMetricsEnabled: telemetryDraft.usageMetricsEnabled,
        },
      });
      if (!ok) {
        setTelemetryError(
          useConfigStore.getState().error || 'Could not save your telemetry preferences.',
        );
        return;
      }
      const baseline = telemetryBaselineRef.current;
      if (baseline) emitTelemetryChangeEvents(baseline, telemetryDraft);
      next();
    } finally {
      telemetryNextInFlight.current = false;
      setTelemetrySubmitting(false);
    }
  }, [telemetryDraft, next]);

  const gateBlocked = isNextGateBlocked({
    step,
    detection,
    connected,
    codexDetection,
    codexConnected,
  });

  let primary: PrimaryAction;
  switch (step) {
    case 1:
      primary = {
        label: 'Continue →',
        disabled: gateBlocked,
        title: 'Connect Claude or Codex to continue',
        onClick: () => void handleConnectNext(),
      };
      break;
    case ONBOARDING_DEFAULT_RUNTIME_STEP:
      primary = {
        label: 'Next →',
        disabled: defaultProvider === null,
        title: 'Pick the agent new sessions should use',
        onClick: () => void handleDefaultRuntimeNext(),
      };
      break;
    case ONBOARDING_MODEL_STEP:
      // Two questions, one card: the first "Next" only reveals the effort list.
      primary = {
        label: 'Next →',
        disabled: codexLoading,
        title: 'Waiting for the Codex model list',
        onClick:
          modelPhase === 'model'
            ? () => setModelPhase('effort')
            : () => void handleModelNext(),
      };
      break;
    case 4:
      primary = { label: 'Next →', disabled: false, onClick: () => void handlePermNext() };
      break;
    case 5:
      primary = {
        label: 'Next →',
        disabled: telemetryDraft === null || telemetrySubmitting,
        onClick: () => void handleTelemetryNext(),
      };
      break;
    case ONBOARDING_HANDOFF_STEP:
      // Both choices call next(); the store decides whether that walks into the
      // guided set-up or completes the tour here. "Finish" is a tour EXIT, so
      // the rail/greeting side effects are staged first (the shell mounts on
      // the very transition next() makes).
      primary = {
        label: handoffChoice === 'skip' ? 'Finish →' : 'Continue →',
        disabled: false,
        onClick:
          handoffChoice === 'skip'
            ? () => {
                stageTourExit(null);
                next();
              }
            : next,
      };
      break;
    default:
      primary = { label: "Let's go →", disabled: false, onClick: next };
  }

  // Arrow-key nav reads the live primary so ArrowRight honours step gates /
  // config persistence. The guided screens (7-8) carry their own buttons and
  // their own branch semantics, so arrows are inert there — this component is
  // still mounted for hydration/persistence, but it does not drive them.
  const primaryRef = useRef(primary);
  primaryRef.current = primary;
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    if (status !== 'active') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return; // held-key auto-repeat must not machine-gun steps
      if (isGuidedStep(stepRef.current)) return;
      if (e.key === 'ArrowRight') {
        const p = primaryRef.current;
        if (!p.disabled) p.onClick();
      } else if (e.key === 'ArrowLeft') {
        back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, back]);

  if (!hydrated || status !== 'active') return null;
  // Steps 7-8 render inside the shell row (GuidedSetupSurface), not this portal.
  if (!ONBOARDING_MODAL_STEPS.includes(step)) return null;

  // The steps this run does NOT show, so the dots and "STEP n / N" counters
  // describe the tour the user actually walks.
  const skippedSteps = skippedStepSet({ multiRuntime, assistantAvailable });

  const body = ((): React.ReactNode => {
    switch (step) {
      case 0:
        return <WelcomeStep />;
      case 1:
        return (
          <ConnectStep
            claudeDetection={detection}
            claudeConnected={connected}
            codexDetection={codexDetection}
            codexConnected={codexConnected}
            ompDetection={ompDetection}
            ompConnected={ompConnected}
            checking={checking}
            onToggleClaude={() => setConnected(!connected)}
            onToggleCodex={() => setCodexConnected(!codexConnected)}
            onToggleOmp={() => setOmpConnected(!ompConnected)}
            onRecheck={() => void runDetect()}
            onLocate={() => void handleLocate()}
            onInstall={handleInstall}
          />
        );
      case ONBOARDING_DEFAULT_RUNTIME_STEP:
        return (
          <DefaultRuntimeStep
            providers={candidates}
            value={defaultProvider}
            onChange={setDefaultProvider}
          />
        );
      case ONBOARDING_MODEL_STEP:
        return (
          <ModelStep
            provider={modelProvider}
            model={defaultModel}
            effort={defaultEffort}
            phase={modelPhase}
            onModelChange={(model) => {
              setDefaultModel(model);
              setModelPhase('effort');
            }}
            onEffortChange={setDefaultEffort}
            onPhaseChange={setModelPhase}
            catalog={{
              options: codexCatalog.options,
              loading: codexCatalog.loading,
              error: codexCatalog.error,
              onRetry: retryCodexModelCatalog,
            }}
          />
        );
      case 4:
        return <PermissionStep value={permMode} onChange={setPermMode} />;
      case 5:
        return (
          <TelemetryStep
            value={telemetryDraft}
            onChange={setTelemetryDraft}
            submitting={telemetrySubmitting}
            error={telemetryError}
          />
        );
      case ONBOARDING_HANDOFF_STEP:
        return <HandoffStep value={handoffChoice} onChange={setHandoffChoice} />;
      default:
        return null;
    }
  })();

  return (
    <OnboardingOverlay>
      {/* Behind the card: the tan wrapper the tour unwinds out of, one band per
          modal step. Renders null once the reveal completes on the handoff step. */}
      <OnboardingSpiralReveal step={step} />
      <OnboardingModalCard
        step={step}
        maxVisitedStep={maxVisitedStep}
        skippedSteps={skippedSteps}
        hero={step === 0}
        primary={primary}
        onBack={back}
        onSkip={skip}
        onGoTo={goTo}
      >
        {body}
      </OnboardingModalCard>
    </OnboardingOverlay>
  );
}
