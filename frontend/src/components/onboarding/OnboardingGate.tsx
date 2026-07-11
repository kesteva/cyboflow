import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClaudeDetectionResult } from '../../../../shared/types/onboarding';
import { CLAUDE_DETECT_CHANNEL } from '../../../../shared/types/onboarding';
import type { Project } from '../../types/project';
import type { IPCResponse } from '../../utils/api';
import { API } from '../../utils/api';
import { useConfigStore } from '../../stores/configStore';
import { useNavigationStore } from '../../stores/navigationStore';
import {
  isNextGateBlocked,
  useOnboardingStore,
  type OnboardingRealEvent,
  type PersistedOnboarding,
} from '../../stores/onboardingStore';
import { ONBOARDING_EVENTS, ONBOARDING_MODAL_STEPS, ONBOARDING_PREF_KEY } from '../../utils/onboarding';
import { OnboardingOverlay } from './OnboardingOverlay';
import { OnboardingModalCard, type PrimaryAction } from './OnboardingModalCard';
import { Coachmark } from './Coachmark';
import { WelcomeStep } from './steps/WelcomeStep';
import { ConnectStep } from './steps/ConnectStep';
import { PermissionStep } from './steps/PermissionStep';
import { AddProjectStep } from './steps/AddProjectStep';
import { RailMapStep } from './steps/RailMapStep';

/**
 * OnboardingGate — the single side-effect host around the pure onboardingStore.
 * Owns boot hydration (pref snapshot + project count, gated so nothing renders
 * until resolved — the no-flash rule), snapshot persistence, real-action event
 * forwarding, arrow-key navigation, the step-1 credential probe, the step-4
 * wizard precondition, and the step-2/step-3 config/project side effects. The
 * store stays synchronously testable; every async lives here.
 *
 * Mounted once, app-wide, from App.tsx. Renders the overlay only while the tour
 * is 'active' (skipped/pending/completed render nothing — the Sidebar owns the
 * "Resume setup" affordance while skipped).
 */

const MISSING_DETECTION: ClaudeDetectionResult = {
  credentials: { found: false, source: null, account: null },
  binary: { found: false, path: null, version: null },
  state: 'missing',
};

/** Trailing path segment, tolerant of either separator + trailing slashes. */
function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
}

export function OnboardingGate(): React.JSX.Element | null {
  const hydrated = useOnboardingStore((s) => s.hydrated);
  const status = useOnboardingStore((s) => s.status);
  const step = useOnboardingStore((s) => s.step);
  const maxVisitedStep = useOnboardingStore((s) => s.maxVisitedStep);
  const detection = useOnboardingStore((s) => s.detection);
  const connected = useOnboardingStore((s) => s.connected);
  const permMode = useOnboardingStore((s) => s.permMode);

  const hydrate = useOnboardingStore((s) => s.hydrate);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const goTo = useOnboardingStore((s) => s.goTo);
  const skip = useOnboardingStore((s) => s.skip);
  const setDetection = useOnboardingStore((s) => s.setDetection);
  const setConnected = useOnboardingStore((s) => s.setConnected);
  const setPermMode = useOnboardingStore((s) => s.setPermMode);
  const anchorActioned = useOnboardingStore((s) => s.anchorActioned);
  const realEvent = useOnboardingStore((s) => s.realEvent);

  const [projects, setProjects] = useState<Project[]>([]);
  const [checking, setChecking] = useState(false);
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [busyCreate, setBusyCreate] = useState(false);

  // Persist the snapshot on any (status, step) change once hydrated. Registered
  // before hydration resolves so the initial idle→active/completed write lands.
  useEffect(() => {
    return useOnboardingStore.subscribe((state, prev) => {
      if (!state.hydrated || state.status === 'idle') return;
      if (state.status === prev.status && state.step === prev.step) return;
      const snapshot: PersistedOnboarding = { version: 1, status: state.status, step: state.step };
      void window.electron?.invoke('preferences:set', ONBOARDING_PREF_KEY, JSON.stringify(snapshot));
    });
  }, []);

  // Boot hydration: parse the pref snapshot + count projects, then resolve the
  // gate. Existing installs (projects > 0, no snapshot) are marked completed.
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
      let list: Project[] = [];
      try {
        const res = await API.projects.getAll();
        if (res.success && Array.isArray(res.data)) list = res.data;
      } catch {
        /* projects unavailable — treat as pristine */
      }
      if (cancelled) return;
      setProjects(list);
      hydrate(parsed, list.length);
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  // Forward the three real-action window events into the store's coach machine.
  useEffect(() => {
    const forward = (kind: OnboardingRealEvent) => () => realEvent(kind);
    // project-created also keeps the local projects list fresh (step-3 display,
    // step-4 wizard lockProjectId) when the project was created via the normal
    // CreateProjectDialog rather than the tour's own card.
    const onProject = (e: Event): void => {
      const detail = (e as CustomEvent<Project | undefined>).detail;
      if (detail && typeof detail === 'object' && typeof detail.id === 'number') {
        setProjects((prev) => (prev.some((p) => p.id === detail.id) ? prev : [...prev, detail]));
      }
      realEvent('project-created');
    };
    const onQuick = forward('quick-session-created');
    const onRun = forward('workflow-run-started');
    window.addEventListener(ONBOARDING_EVENTS.projectCreated, onProject);
    window.addEventListener(ONBOARDING_EVENTS.quickSessionCreated, onQuick);
    window.addEventListener(ONBOARDING_EVENTS.workflowRunStarted, onRun);
    return () => {
      window.removeEventListener(ONBOARDING_EVENTS.projectCreated, onProject);
      window.removeEventListener(ONBOARDING_EVENTS.quickSessionCreated, onQuick);
      window.removeEventListener(ONBOARDING_EVENTS.workflowRunStarted, onRun);
    };
  }, [realEvent]);

  // The step-1 credential probe. Re-runs whenever detection is cleared (Check
  // again / after locating a binary). Any failure degrades to 'missing'.
  const runDetect = useCallback(async () => {
    setChecking(true);
    try {
      const res = (await window.electron?.invoke(CLAUDE_DETECT_CHANNEL)) as
        | IPCResponse<ClaudeDetectionResult>
        | undefined;
      setDetection(res?.success && res.data ? res.data : MISSING_DETECTION);
    } catch {
      setDetection(MISSING_DETECTION);
    } finally {
      setChecking(false);
    }
  }, [setDetection]);

  useEffect(() => {
    if (status === 'active' && step === 1 && detection === null && !checking) void runDetect();
  }, [status, step, detection, checking, runDetect]);

  // Step-4 precondition: the Quick Session card lives in the wizard, so ensure it
  // is the center surface before the coachmark tries to anchor.
  useEffect(() => {
    if (status !== 'active' || step !== 4) return;
    const nav = useNavigationStore.getState();
    if (nav.view !== 'wizard') {
      nav.goToWizard({ lockProjectId: projects[0]?.id, allowQuick: true });
    }
  }, [status, step, projects]);

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

  const handleBrowse = useCallback(async () => {
    const res = await API.dialog.openDirectory();
    if (res.success && typeof res.data === 'string' && res.data) setPickedPath(res.data);
  }, []);

  const handleAddProject = useCallback(async () => {
    if (!pickedPath || busyCreate) return;
    setBusyCreate(true);
    try {
      const res = await API.projects.create({ name: basename(pickedPath), path: pickedPath, active: false });
      if (res.success && res.data) {
        const created = res.data;
        setProjects((prev) => [...prev, created]);
        // Mirror CreateProjectDialog's broadcast (we bypass that dialog); the
        // gate's own listener advances the tour to step 4. goToWizard matches the
        // app's real post-create flow so the step-4 anchor exists.
        window.dispatchEvent(new CustomEvent(ONBOARDING_EVENTS.projectCreated, { detail: created }));
        useNavigationStore.getState().goToWizard({ lockProjectId: created.id, allowQuick: true });
      }
    } finally {
      setBusyCreate(false);
    }
  }, [pickedPath, busyCreate]);

  // Re-entry guard: the config write is async, so a second activation (held
  // ArrowRight auto-repeat, double-click) while the await is in flight would
  // otherwise call next() twice and blow past step 3's UI-only project gate.
  const permNextInFlight = useRef(false);
  const handlePermNext = useCallback(async () => {
    if (permNextInFlight.current) return;
    permNextInFlight.current = true;
    try {
      // MUST go through the config store: updateConfig persists AND refetches
      // the renderer's cached config, so downstream seeds (the wizard's
      // useAgentPermissionMode) inherit the choice without an app restart.
      await useConfigStore.getState().updateConfig({ defaultAgentPermissionMode: permMode });
    } catch {
      /* non-fatal — advance regardless; the pill can be changed in Settings */
    } finally {
      permNextInFlight.current = false;
    }
    next();
  }, [permMode, next]);

  const hasProject = projects.length > 0;
  const gateBlocked = isNextGateBlocked({ step, detection, connected });

  let primary: PrimaryAction;
  switch (step) {
    case 1:
      primary = { label: 'Continue →', disabled: gateBlocked, title: 'Connect Claude Code to continue', onClick: next };
      break;
    case 2:
      primary = { label: 'Next →', disabled: false, onClick: () => void handlePermNext() };
      break;
    case 3:
      primary = hasProject
        ? { label: 'Next →', disabled: false, onClick: next }
        : { label: 'Add project →', disabled: !pickedPath || busyCreate, onClick: () => void handleAddProject() };
      break;
    case 7:
      primary = { label: 'Finish →', disabled: false, onClick: next };
      break;
    default:
      primary = { label: "Let's go →", disabled: false, onClick: next };
  }

  // Arrow-key nav reads the live primary so ArrowRight honours step gates /
  // config persistence; coach steps have no primary and next() no-ops on them.
  const primaryRef = useRef(primary);
  primaryRef.current = primary;
  useEffect(() => {
    if (status !== 'active') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return; // held-key auto-repeat must not machine-gun steps
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

  const isModal = ONBOARDING_MODAL_STEPS.includes(step);

  const body = ((): React.ReactNode => {
    switch (step) {
      case 0:
        return <WelcomeStep />;
      case 1:
        return (
          <ConnectStep
            detection={detection}
            connected={connected}
            checking={checking}
            onToggleConnect={() => setConnected(!connected)}
            onRecheck={() => void runDetect()}
            onLocate={() => void handleLocate()}
            onInstall={handleInstall}
          />
        );
      case 2:
        return <PermissionStep value={permMode} onChange={setPermMode} />;
      case 3:
        return (
          <AddProjectStep
            hasExistingProject={hasProject}
            firstProjectName={projects[0]?.name ?? null}
            firstProjectPath={projects[0]?.path ?? null}
            pickedPath={pickedPath}
            onBrowse={() => void handleBrowse()}
          />
        );
      case 7:
        return <RailMapStep />;
      default:
        return null;
    }
  })();

  return (
    <OnboardingOverlay>
      {isModal ? (
        <OnboardingModalCard
          step={step}
          maxVisitedStep={maxVisitedStep}
          hero={step === 0}
          primary={primary}
          onBack={back}
          onSkip={skip}
          onGoTo={goTo}
        >
          {body}
        </OnboardingModalCard>
      ) : (
        <Coachmark
          step={step}
          maxVisitedStep={maxVisitedStep}
          onBack={back}
          onSkip={skip}
          onGoTo={goTo}
          onAnchorActioned={anchorActioned}
        />
      )}
    </OnboardingOverlay>
  );
}
