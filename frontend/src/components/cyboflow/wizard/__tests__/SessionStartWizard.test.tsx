/**
 * SessionStartWizard tests — step ③ (Configure) navigation, adaptive rendering,
 * and launch threading.
 *
 * Behaviors verified:
 *   1. Locked mode opens on ② Workflow; "Next: configure" advances to ③ Configure;
 *      "Back to workflow" returns to ②.
 *   2. ③ adapts to the selection: BOTH kinds show the substrate selector (quick
 *      sessions opt into the interactive PTY substrate here, same as workflow
 *      launches); only a WORKFLOW selection shows the blueprint-editor buttons
 *      (there is no workflow to edit for a quick session).
 *   3. Launching a workflow from ③ threads `substrate` + `permissionMode` into
 *      runs.start.mutate (seeded default, and an explicit per-run override).
 *   4. Launching a quick session from ③ threads the chosen `agentPermissionMode`
 *      + `substrate` into API.sessions.createQuick.
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// tRPC mock — the wizard fetches workflows.list + runs.list and launches via
// runs.start.mutate.
// ---------------------------------------------------------------------------
const { mockUseOmpAvailability } = vi.hoisted(() => ({
  mockUseOmpAvailability: vi.fn<() => { launchable: boolean; ariaMode: boolean }>(() => ({
    launchable: false,
    ariaMode: false,
  })),
}));

vi.mock('../../../../hooks/useOmpAvailability', () => ({
  useOmpAvailability: mockUseOmpAvailability,
}));

vi.mock('../../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        list: { query: vi.fn().mockResolvedValue([]) },
        start: {
          mutate: vi.fn().mockResolvedValue({
            runId: 'run-test-001',
            worktreePath: '/tmp/wt',
            branchName: 'run/run-test-001',
          }),
        },
        // Sprint launches ONE session-hosted run via runs.start({ taskIds })
        // (gated behind the task batch picker) — no separate batch endpoint.
      },
      // The batch picker reads the effective substrate to size its cap N.
      substrates: {
        resolveEffective: { query: vi.fn().mockResolvedValue({ substrate: 'sdk' }) },
      },
      // A/B testing (migration 048) — VariantSelector fetches this for the
      // selected workflow. Empty by default so it renders nothing and never
      // adds variantId/baseline to the runs.start payload.
      variants: {
        list: { query: vi.fn().mockResolvedValue([]) },
      },
      workflows: {
        list: {
          query: vi.fn().mockResolvedValue([
            // Sprint is the DEFAULT_WORKFLOW_NAME → pre-selected on open. Clicking
            // the CTA opens the task batch picker (Sprint is batch-gated); the
            // launch-threading describe below overrides this to a non-gated
            // 'custom' flow to exercise the DIRECT runs.start path.
            { id: 'wf-1', project_id: 1, name: 'sprint', spec_json: null, permission_mode: 'default', created_at: '' },
          ]),
        },
      },
      tasks: { list: { query: vi.fn().mockResolvedValue([]) } },
      events: {
        onStuckDetected: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
      approvals: { listPending: { query: vi.fn().mockResolvedValue([]) } },
    },
  },
}));

// panelApi — used by useQuickSession after a quick create.
vi.mock('../../../../services/panelApi', () => ({
  panelApi: {
    createPanel: vi.fn().mockResolvedValue({ id: 'panel-001', sessionId: 'session-quick-001', type: 'claude' }),
    loadPanelsForSession: vi.fn().mockResolvedValue([]),
    setActivePanel: vi.fn().mockResolvedValue(undefined),
    deletePanel: vi.fn().mockResolvedValue(undefined),
  },
}));

// cyboflowApi — pulled in by cyboflowStore.
vi.mock('../../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
  cyboflowApi: { subscribeToStreamEvents: vi.fn(() => vi.fn()), approveRun: vi.fn() },
}));

// ensureSessionForLaunch — return a deterministic session id.
vi.mock('../../../../utils/ensureSessionForLaunch', () => ({
  ensureSessionForLaunch: vi.fn().mockResolvedValue('session-ensured-001'),
}));

// TaskBatchPickerModal — stubbed to a button that reports a fixed selection, so
// the wizard's batch-gate WIRING (open → onPicked → runs.start({ taskIds }) →
// goToSession) is tested in isolation. The modal's own internals are covered by
// its test file.
vi.mock('../../TaskBatchPickerModal', () => ({
  TaskBatchPickerModal: ({ onPicked }: { onPicked: (ids: string[]) => void }) => (
    <button data-testid="mock-batch-pick" onClick={() => onPicked(['IDEA-1', 'IDEA-2'])}>
      pick tasks
    </button>
  ),
}));

// LaunchPromptModal — stubbed to a button that reports a fixed seed prompt, so
// the wizard's Launch seed-prompt gate WIRING (open → onSubmit → runs.start({
// seedPrompt }) → goToSession) is tested in isolation. The modal's own
// internals (disabled-until-text, trimming, Cmd/Ctrl+Enter) are covered by its
// own test file.
vi.mock('../../LaunchPromptModal', () => ({
  LaunchPromptModal: ({ onSubmit }: { onSubmit: (seedPrompt: string) => void }) => (
    <button data-testid="mock-launch-prompt-submit" onClick={() => onSubmit('A recipe app.')}>
      submit seed prompt
    </button>
  ),
}));

// IdeaPickerModal — stubbed to buttons that report a fixed idea id / batch, so
// the wizard's idea-gate WIRING (open → onPicked → runs.start({ ideaId /
// ideaIds }) → goToSession) is tested in isolation. Shared by the Planner AND
// Ship flows (both IDEA-seeded, only Planner gets `multi`). The modal's own
// internals are covered by its test file. `mockIdeaPickerMulti` records the
// `multi` prop each render receives so the Planner-only gating is assertable.
const mockIdeaPickerMulti = vi.hoisted(() => vi.fn());
vi.mock('../../IdeaPickerModal', () => ({
  IdeaPickerModal: ({ onPicked, multi }: { onPicked: (ids: string[], opts?: { separateIdeaIds: string[] }) => void; multi?: boolean }) => {
    mockIdeaPickerMulti(multi);
    return (
      <>
        <button data-testid="mock-idea-pick" onClick={() => onPicked(['IDEA-7'])}>
          pick idea
        </button>
        <button data-testid="mock-idea-pick-batch" onClick={() => onPicked(['IDEA-7', 'IDEA-8'])}>
          pick idea batch
        </button>
      </>
    );
  },
}));

// modelAvailabilityStore — controllable Fable availability (default: usable,
// matching the store's optimistic empty snapshot). Flip
// `modelAvailability.fableUnavailable` to grey Fable out for a test; the global
// beforeEach resets it.
const modelAvailability = vi.hoisted(() => ({ fableUnavailable: false }));
vi.mock('../../../../stores/modelAvailabilityStore', () => ({
  useModelAvailability: () => ({
    isAliasUsable: (alias: string | null | undefined) =>
      !(modelAvailability.fableUnavailable && alias === 'fable'),
    unavailableReason: (alias: string | null | undefined) =>
      modelAvailability.fableUnavailable && alias === 'fable' ? 'Currently unavailable' : null,
  }),
}));

// API wrapper — projects (banner) + sessions.createQuick (quick launch).
vi.mock('../../../../utils/api', () => ({
  API: {
    projects: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [{ id: 1, name: 'Proj', path: '/tmp/p' }] }),
      detectBranch: vi.fn().mockResolvedValue({ success: true, data: 'main' }),
    },
    sessions: {
      createQuick: vi.fn(),
      delete: vi.fn().mockResolvedValue({ success: true }),
    },
    // useQuickSession persists the launch model + fast-mode + effort on the panel.
    claudePanels: {
      setModel: vi.fn().mockResolvedValue({ success: true }),
      setFastMode: vi.fn().mockResolvedValue({ success: true }),
      setEffort: vi.fn().mockResolvedValue({ success: true }),
    },
    // panels.continue — the design kickoff's dispatch target
    // (dispatchQuickSessionInput's non-codex-sdk 'continue' branch: the same
    // panels:continue fresh-start path the composer's first typed message
    // takes; 'initial'/panels:send-input dead-ends on the resume validation
    // for a fresh session — live-smoke finding).
    panels: {
      continue: vi.fn().mockResolvedValue({ success: true }),
    },
    models: {
      // Provider-keyed: only the Codex picker has a discovered catalog here, so
      // Claude keeps rendering exactly its four pinned aliases.
      getCatalog: vi.fn(async (provider: string) =>
        provider === 'codex'
          ? {
              success: true,
              data: {
                models: [{ id: 'gpt-5.4', label: 'GPT-5.4', description: 'Strong coding model', isDefault: true }],
                defaultModel: 'gpt-5.4',
              },
            }
          : { success: true, data: { models: [], defaultModel: null } }),
    },
  },
}));

// Import after mocks so vi.mock hoisting is in effect.
import SessionStartWizard from '../SessionStartWizard';
import { useCyboflowStore } from '../../../../stores/cyboflowStore';
import { useConfigStore } from '../../../../stores/configStore';
import { useNavigationStore } from '../../../../stores/navigationStore';
import { useDesignModeStore } from '../../../../stores/designModeStore';
import { DESIGN_KICKOFF_PROMPT } from '../../design/designKickoff';
import { API } from '../../../../utils/api';
import { trpc } from '../../../../trpc/client';
import { ensureSessionForLaunch } from '../../../../utils/ensureSessionForLaunch';
import type { AppConfig } from '../../../../types/config';
import type { WorkflowRow } from '../../../../../../shared/types/workflows';
import type { RunTypeDefaults, RunTypeDefaultsOp } from '../../../../../../shared/types/sessionDefaults';
import type { ApplyRunTypeDefaultResult } from '../../../../stores/configStore';

const mockRunStart = vi.mocked(trpc.cyboflow.runs.start.mutate);
const mockWorkflowsList = vi.mocked(trpc.cyboflow.workflows.list.query);
const mockCreateQuick = vi.mocked(API.sessions.createQuick);
const mockDeleteSession = vi.mocked(API.sessions.delete);
const mockEnsureSession = vi.mocked(ensureSessionForLaunch);
const mockPanelsContinue = vi.mocked(API.panels.continue);

/** A non-gated custom workflow row (neither planner nor sprint → direct launch). */
const CUSTOM_WORKFLOW_ROW: WorkflowRow = {
  id: 'wf-1',
  project_id: 1,
  name: 'custom',
  workflow_path: null,
  spec_json: '{}',
  permission_mode: 'default',
  created_at: '',
  archived_at: null,
};
/** The Sprint built-in row (batch-gated). */
const SPRINT_WORKFLOW_ROW: WorkflowRow = {
  id: 'wf-1',
  project_id: 1,
  name: 'sprint',
  workflow_path: null,
  spec_json: '{}',
  permission_mode: 'default',
  created_at: '',
  archived_at: null,
};
/** The Planner built-in row (idea-gated, multi-select-eligible — IDEA-009). */
const PLANNER_WORKFLOW_ROW: WorkflowRow = {
  id: 'wf-1',
  project_id: 1,
  name: 'planner',
  workflow_path: null,
  spec_json: '{}',
  permission_mode: 'default',
  created_at: '',
  archived_at: null,
};
/** The Ship built-in row (idea-gated, like the planner). */
const SHIP_WORKFLOW_ROW: WorkflowRow = {
  id: 'wf-1',
  project_id: 1,
  name: 'ship',
  workflow_path: null,
  spec_json: '{}',
  permission_mode: 'default',
  created_at: '',
  archived_at: null,
};
/** The verify-setup built-in row — hidden from the launcher, launched from the Verify Queue. */
const VERIFY_SETUP_WORKFLOW_ROW: WorkflowRow = {
  id: 'wf-verify-setup',
  project_id: 1,
  name: 'verify-setup',
  workflow_path: null,
  spec_json: '{}',
  permission_mode: 'default',
  created_at: '',
  archived_at: null,
};
/** The Launch built-in row (seed-prompt-gated — the interview-driven super-planner). */
const LAUNCH_WORKFLOW_ROW: WorkflowRow = {
  id: 'wf-1',
  project_id: 1,
  name: 'launch',
  workflow_path: null,
  spec_json: '{}',
  permission_mode: 'default',
  created_at: '',
  archived_at: null,
};
/** The Compound built-in row (the Insights CTA preselect target). */
const COMPOUND_WORKFLOW_ROW: WorkflowRow = {
  id: 'wf-compound',
  project_id: 1,
  name: 'compound',
  workflow_path: null,
  spec_json: '{}',
  permission_mode: 'default',
  created_at: '',
  archived_at: null,
};

/**
 * Render the wizard pinned to project 1 with quick offered, and wait for load.
 * Returns the unmount handle so a test that needs a SECOND, differently-seeded
 * render (e.g. both branches of the Ultracode availability floor) can tear the
 * first one down instead of matching two wizards' controls at once.
 */
async function renderLockedWizard(): Promise<() => void> {
  act(() => {
    useNavigationStore.setState({ view: 'wizard', wizardOpts: { lockProjectId: 1, allowQuick: true } });
  });
  const { unmount } = render(<SessionStartWizard />);
  // Wait for the workflow list to resolve (the rows become clickable). getAll,
  // not find/getByTestId: a list of TWO rows (per-workflow-key seeding) is a
  // legitimate fixture and the singular query throws on multiple matches.
  await waitFor(() => expect(screen.getAllByTestId('workflow-list-row').length).toBeGreaterThan(0));
  return unmount;
}

/** Click the workflow row → auto-advances to ③ Configure. */
async function selectWorkflowAndConfigure(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('workflow-list-row'));
  });
  await screen.findByTestId('wizard-step3');
}

/** Click the quick card → auto-advances to ③ Configure. */
async function selectQuickAndConfigure(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('quick-session-card'));
  });
  await screen.findByTestId('wizard-step3');
}

/** Click the Ultracode card → auto-advances to ③ Configure. */
async function selectUltracodeAndConfigure(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('ultracode-card'));
  });
  await screen.findByTestId('wizard-step3');
}

/** Click the Design card → auto-advances to ③ Configure. */
async function selectDesignAndConfigure(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('design-card'));
  });
  await screen.findByTestId('wizard-step3');
}

/**
 * Click the workflow row carrying `slashCommand` (e.g. '/compound') →
 * auto-advances to ③ Configure. The single-row helper above can't disambiguate
 * a list of two, which the per-workflow-key seeding tests need.
 */
async function selectWorkflowRowAndConfigure(slashCommand: string): Promise<void> {
  const row = screen
    .getAllByTestId('workflow-list-row')
    .find((el) => (el.textContent ?? '').includes(slashCommand));
  if (row === undefined) throw new Error(`no workflow row for ${slashCommand}`);
  await act(async () => {
    fireEvent.click(row);
  });
  await screen.findByTestId('wizard-step3');
}

/** Go back to ② Workflow from ③ Configure. */
async function backToWorkflow(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('wizard-back-to-workflow'));
  });
}

/** The Claude model picker's current value on ③. */
function claudeModelValue(): string {
  return (screen.getByLabelText('Select Claude model') as HTMLSelectElement).value;
}

/** The reasoning-effort select's current value on ③ ('' = provider default). */
function effortValue(): string {
  return (screen.getByTestId('wizard-effort-select') as HTMLSelectElement).value;
}

/** Change the Claude model on ③ (a real user pick → setByUser). */
async function chooseModel(model: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Select Claude model'), { target: { value: model } });
  });
}

/** Change the agent runtime on ③. */
async function chooseRuntime(runtime: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Select agent runtime'), { target: { value: runtime } });
  });
}

/** The agent-runtime picker's current value on ③. */
function runtimeValue(): string {
  return (screen.getByLabelText('Select agent runtime') as HTMLSelectElement).value;
}

/**
 * The permission mode currently shown as selected on ③. The selector is a group
 * of buttons, so "selected" is `aria-pressed`, not a select value.
 */
function pressedPermissionLabel(): string | null {
  const pressed = screen
    .getAllByRole('button')
    .find(
      (b) =>
        (b.getAttribute('aria-label') ?? '').startsWith('Permission mode: ') &&
        b.getAttribute('aria-pressed') === 'true',
    );
  return pressed?.getAttribute('aria-label')?.replace('Permission mode: ', '') ?? null;
}

/** Click a permission-mode option on ③ (a real user pick → setByUser). */
async function choosePermission(label: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByLabelText(`Permission mode: ${label}`));
  });
}

/**
 * Install a `runTypeDefaults` map on the config store. The wizard reads it
 * reactively (a Settings edit must re-seed an open, untouched wizard), so this
 * doubles as the "the stored default changed under us" driver.
 */
function setRunTypeDefaults(defaults: Record<string, RunTypeDefaults>): void {
  act(() => {
    useConfigStore.setState({
      config: { runTypeDefaults: defaults } as unknown as AppConfig,
    });
  });
}

beforeEach(() => {
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
    useConfigStore.setState({ config: null });
    // Fullscreen design surface state (design-mode.md v0.5) — never restored
    // across app restart, so tests start from the same "no active surface"
    // baseline the real app does.
    useDesignModeStore.setState({ activeDesignSessionId: null });
    mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: false });
  });
  mockRunStart.mockClear();
  mockCreateQuick.mockClear();
  mockDeleteSession.mockClear();
  mockEnsureSession.mockClear();
  mockPanelsContinue.mockClear();
  mockDeleteSession.mockResolvedValue({ success: true });
  modelAvailability.fableUnavailable = false;
  mockCreateQuick.mockResolvedValue({
    success: true,
    data: { jobId: 'job-001', sessionId: 'session-quick-001', worktreePath: '/tmp/quick-wt', runId: 'run-quick-001' },
  });
});

afterEach(() => {
  useConfigStore.setState({ config: null });
});

// ---------------------------------------------------------------------------
// Step navigation
// ---------------------------------------------------------------------------
describe('SessionStartWizard — step ③ navigation', () => {
  it('opens on ② Workflow without auto-advancing the default pre-selection', async () => {
    await renderLockedWizard();
    // Even though 'sprint' is pre-selected, the wizard must NOT jump to ③ on load.
    expect(screen.getByTestId('workflow-list-row')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-step3')).toBeNull();
    // No launch CTA on ② — it lives on ③.
    expect(screen.queryByTestId('wizard-cta')).toBeNull();
  });

  it('auto-advances ② → ③ on workflow selection, and supports back', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();
    expect(screen.getByTestId('wizard-step3')).toBeInTheDocument();
    // The launch CTA now lives on ③.
    expect(screen.getByTestId('wizard-cta')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-back-to-workflow'));
    });
    expect(screen.queryByTestId('wizard-step3')).toBeNull();
    expect(screen.getByTestId('workflow-list-row')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Adaptive rendering
// ---------------------------------------------------------------------------
describe('SessionStartWizard — step ③ adaptive controls', () => {
  it('shows substrate + blueprint editor for a WORKFLOW selection', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();
    const runtimeSelect = screen.getByLabelText('Select agent runtime');
    const modelSelect = screen.getByLabelText('Select Claude model');
    expect(runtimeSelect).toBeInTheDocument();
    expect(runtimeSelect.compareDocumentPosition(modelSelect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('option', { name: /^Codex SDK$/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Codex \(CLI\)/i })).toBeDisabled();
    expect(screen.getByTestId('wizard-edit-flow')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-new-flow')).toBeInTheDocument();
    // Permission selector + summary always present.
    expect(screen.getByLabelText('Permission mode: Auto')).toBeInTheDocument();
    expect(screen.getByText('Native Claude classifier')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-launch-summary')).toBeInTheDocument();
  });

  it('shows substrate but hides the blueprint editor for a QUICK selection', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // Quick sessions can launch both structured Codex SDK chat and Codex PTY;
    // workflows keep Codex disabled until workflow compatibility ships.
    expect(screen.getByLabelText('Select agent runtime')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Codex SDK/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Codex \(CLI\)/i })).not.toBeDisabled();
    expect(screen.queryByTestId('wizard-edit-flow')).toBeNull();
    expect(screen.queryByTestId('wizard-new-flow')).toBeNull();
    // Permission selector + summary still present.
    expect(screen.getByLabelText('Permission mode: Auto')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-launch-summary')).toBeInTheDocument();
  });

  it('shows the Advanced (MCP/plugin) disclosure for a QUICK + SDK selection', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();
    // Default substrate is SDK — the MCP deny-list is enforced at the SDK spawn,
    // so the Advanced controls are offered.
    expect(screen.getByTestId('wizard-advanced-toggle')).toBeInTheDocument();
  });

  it('KEEPS the Advanced disclosure when the QUICK substrate is switched to Interactive', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();
    expect(screen.getByTestId('wizard-advanced-toggle')).toBeInTheDocument();

    // Both substrates now enforce the MCP deny / plugin allow selection (SDK:
    // strictMcpConfig + disallowedTools; interactive: --disallowed-tools +
    // disabledMcpjsonServers + enabledPlugins via --settings), so the Advanced
    // controls stay visible when Interactive is selected.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), {
        target: { value: 'claude-interactive' },
      });
    });
    expect(screen.getByTestId('wizard-advanced-toggle')).toBeInTheDocument();
  });

  it('distinguishes Codex SDK auto-review from PTY Auto and omits unsupported MCP/plugin controls', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), {
        target: { value: 'codex-sdk' },
      });
    });
    expect(screen.getByText('Workspace writes · Codex auto-reviews')).toBeInTheDocument();
    expect(screen.getByText(/other requested approvals use the Cyboflow review queue/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), {
        target: { value: 'codex-pty' },
      });
    });

    expect(screen.getByText('Currently same as Allow edits')).toBeInTheDocument();
    expect(screen.getByText(/prompts appear in its terminal/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-advanced-toggle'));
    });
    expect(screen.queryByText('MCP servers')).toBeNull();
    expect(screen.queryByText('Plugins')).toBeNull();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
  });
});

describe('SessionStartWizard — OMP Fleet runtime controls', () => {
  it('hides the Claude model picker + reasoning-effort select when OMP Fleet is selected', async () => {
    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    // The merged provider registry floors an absent `omp` key to DISABLED (the
    // back-branch defaulted it enabled, which is why this seed used to be
    // unnecessary). Without it the picker snaps a fleet selection back to a
    // default-enabled runtime and the controls under test never hide.
    act(() => {
      useConfigStore.setState({
        config: { agentProviderAccess: { claude: true, codex: true, omp: true } } as unknown as AppConfig,
      });
    });
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), {
        target: { value: 'omp-fleet' },
      });
    });

    // The Claude model + reasoning-effort controls are Claude/Codex-scoped and
    // must not render for OMP (which runs on the producer default model).
    expect(screen.queryByLabelText('Select Claude model')).toBeNull();
    expect(screen.queryByLabelText('Select reasoning effort')).toBeNull();
    // The launch summary labels the runtime honestly (shared AGENT_RUNTIME_LABELS
    // wording — sentence case, same family as 'OMP terminal').
    expect(screen.getByTestId('wizard-launch-summary')).toHaveTextContent('OMP fleet');
  });
});

// ---------------------------------------------------------------------------
// Workspace tri-state (quick only) — the wizard's Advanced "Workspace" control
// pins where a quick session's working tree lives ('inherit' = global default,
// 'worktree', or 'in-place'). Both substrates support in-place (the interactive
// gate rides the inline --settings flag), so the option is never disabled and
// survives a substrate flip. The choice threads into createQuick.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — Workspace tri-state (quick)', () => {
  it('renders the Workspace tri-state (default inherit) inside quick Advanced', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // The tri-state lives in the collapsed Advanced section — expand it first.
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-advanced-toggle'));
    });

    expect(screen.getByTestId('wizard-worktree-inherit')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-worktree-worktree')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-worktree-inplace')).toBeInTheDocument();
    // Default selection is 'inherit' (launch stays byte-identical).
    expect(screen.getByTestId('wizard-worktree-inherit')).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps the in-place option enabled under the interactive substrate (inline --settings gate)', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-advanced-toggle'));
    });

    // SDK default → in-place is selectable.
    expect(screen.getByTestId('wizard-worktree-inplace')).not.toBeDisabled();

    // Interactive substrate → still selectable (no SDK-only constraint).
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), {
        target: { value: 'claude-interactive' },
      });
    });
    expect(screen.getByTestId('wizard-worktree-inplace')).not.toBeDisabled();
  });

  it('threads worktreeMode:"in-place" into a quick launch when selected', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-advanced-toggle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-worktree-inplace'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, worktreeMode: 'in-place' }),
    );
  });

  it('preserves an in-place override across a substrate flip to interactive (threads worktreeMode into the launch)', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-advanced-toggle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-worktree-inplace'));
    });
    expect(screen.getByTestId('wizard-worktree-inplace')).toHaveAttribute('aria-checked', 'true');

    // Flipping to interactive no longer resets the choice — in-place works there.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), {
        target: { value: 'claude-interactive' },
      });
    });
    expect(screen.getByTestId('wizard-worktree-inplace')).toHaveAttribute('aria-checked', 'true');

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockCreateQuick.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ worktreeMode: 'in-place', substrate: 'interactive' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Launch threading
// ---------------------------------------------------------------------------
describe('SessionStartWizard — step ③ launch threading', () => {
  // These tests exercise the DIRECT runs.start path, so use a non-gated custom
  // flow (the default 'sprint' is batch-gated and would open the picker instead).
  beforeEach(() => {
    mockWorkflowsList.mockResolvedValue([CUSTOM_WORKFLOW_ROW]);
  });

  it('threads default substrate + permission into a workflow launch', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        projectId: 1,
        sessionId: 'session-ensured-001',
        substrate: 'sdk',
        agentProvider: 'claude',
        agentRuntime: 'claude-sdk',
        permissionMode: 'default',
      }),
    );
  });

  it('shows the model picker for a workflow launch (default Opus, no fast mode) and threads model', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    // The model picker is now shown for WORKFLOW launches too, defaulting to Opus;
    // fast mode stays QUICK-only so it must NOT appear here.
    const modelSelect = screen.getByLabelText('Select Claude model') as HTMLSelectElement;
    expect(modelSelect.value).toBe('opus');
    expect(screen.queryByTestId('wizard-fast-mode-row')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    // The default model rides runs.start as `model` (migration 037).
    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ model: 'opus' }));
  });

  it('threads an explicit per-run model override into a workflow launch', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select Claude model'), { target: { value: 'sonnet' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ model: 'sonnet' }));
  });

  it('omits evalEnabled when the Quality eval control is left on "Use global setting"', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    // The Advanced section is collapsed by default — the control is not yet mounted.
    expect(screen.queryByTestId('wizard-eval-off')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    // Default 'inherit' → the field is not sent, so the run inherits the global toggle.
    expect(mockRunStart).toHaveBeenCalledOnce();
    const startArg = mockRunStart.mock.calls[0][0] as Record<string, unknown>;
    expect(startArg).not.toHaveProperty('evalEnabled');
  });

  it('threads evalEnabled=false when the Quality eval override is set to Off (Advanced)', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-workflow-advanced-toggle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-eval-off'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ evalEnabled: false }));
  });

  it('threads evalEnabled=true when the Quality eval override is set to On (Advanced)', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-workflow-advanced-toggle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-eval-on'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ evalEnabled: true }));
  });

  it('omits verifyEnabled when the Visual verification control is left on "Use global setting"', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    // The Advanced section is collapsed by default — the control is not yet mounted.
    expect(screen.queryByTestId('wizard-verify-off')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    // Default 'inherit' → the field is not sent, so the run inherits the global toggle.
    expect(mockRunStart).toHaveBeenCalledOnce();
    const startArg = mockRunStart.mock.calls[0][0] as Record<string, unknown>;
    expect(startArg).not.toHaveProperty('verifyEnabled');
  });

  it('threads verifyEnabled=false when the Visual verification override is set to Off (Advanced)', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-workflow-advanced-toggle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-verify-off'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ verifyEnabled: false }));
  });

  it('threads verifyEnabled=true when the Visual verification override is set to On (Advanced)', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-workflow-advanced-toggle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-verify-on'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ verifyEnabled: true }));
  });

  it('always forces a NEW session — never absorbs the selected quick session', async () => {
    // Regression: the wizard IS the explicit "Start a new session" surface, so it
    // must call ensureSessionForLaunch with forceNew:true. Without this it silently
    // reused whatever quick session was selected, absorbing it into the new run.
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockEnsureSession).toHaveBeenCalledWith(1, {
      forceNew: true,
      agentProvider: 'claude',
      agentRuntime: 'claude-sdk',
      agentModel: 'opus',
    });
  });

  it('threads an explicit per-run substrate + permission override', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Permission mode: Auto'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), { target: { value: 'claude-interactive' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        substrate: 'interactive',
        agentProvider: 'claude',
        agentRuntime: 'claude-interactive',
        permissionMode: 'auto',
      }),
    );
  });

  it('selects and launches the Codex SDK workflow runtime', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    const runtimeSelect = screen.getByLabelText('Select agent runtime') as HTMLSelectElement;
    expect(screen.getByRole('option', { name: /^Codex SDK$/i })).not.toBeDisabled();
    await act(async () => {
      fireEvent.change(runtimeSelect, { target: { value: 'codex-sdk' } });
    });

    expect(screen.getByLabelText('Select Codex model')).toBeInTheDocument();
    expect(screen.queryByLabelText('Select Claude model')).toBeNull();
    expect(screen.getByTestId('wizard-launch-summary')).toHaveTextContent('Codex SDK');

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select Codex model'), {
        target: { value: 'gpt-5.4' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    await waitFor(() => {
      expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({
        agentProvider: 'codex',
        agentRuntime: 'codex-sdk',
        model: 'gpt-5.4',
      }));
    });
    expect(mockEnsureSession).toHaveBeenCalled();
  });

  it('shows the OMP runtime label (not the Claude SDK default) in the launch summary', async () => {
    // OMP is absent⇒disabled (AGENT_PROVIDER_REGISTRY.omp.defaultEnabled), so
    // the picker only offers it once the access toggle is on.
    act(() => {
      useConfigStore.setState({
        config: { agentProviderAccess: { omp: true } } as unknown as AppConfig,
      });
    });
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    const runtimeSelect = screen.getByLabelText('Select agent runtime') as HTMLSelectElement;
    expect(screen.getByRole('option', { name: /^OMP$/i })).not.toBeDisabled();
    await act(async () => {
      fireEvent.change(runtimeSelect, { target: { value: 'omp-sdk' } });
    });

    expect(screen.getByTestId('wizard-launch-summary')).toHaveTextContent('OMP');
    expect(screen.getByTestId('wizard-launch-summary')).not.toHaveTextContent('Claude SDK');
  });

  it('seeds the permission selector from the global default', async () => {
    act(() => {
      useConfigStore.setState({ config: { defaultAgentPermissionMode: 'dontAsk' } as unknown as AppConfig });
    });
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'dontAsk' }));
  });

  it('threads the chosen agentPermissionMode into a quick-session launch', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Permission mode: Don't ask"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).not.toHaveBeenCalled();
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, agentPermissionMode: 'dontAsk' }),
    );
  });

  // CyboflowRoot takes navigationStore.activeProjectId as its `projectId` prop and
  // gates the ENTIRE quick-session surface (QuickSessionCanvas + TerminalDock +
  // dock tabs) on it being non-null. Nothing on the way into this wizard sets it,
  // so without this stamp a first-run user — who has never clicked a project or
  // session in the sidebar — landed on the bare panel fallback: no canvas, no dock.
  it('stamps activeProjectId before navigating on a quick-session launch', async () => {
    act(() => {
      useNavigationStore.setState({ activeProjectId: null });
    });
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(useNavigationStore.getState().activeProjectId).toBe(1);
    expect(useNavigationStore.getState().view).toBe('session');
  });

  it('threads the chosen substrate into a quick-session launch', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), { target: { value: 'claude-interactive' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).not.toHaveBeenCalled();
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        substrate: 'interactive',
        agentProvider: 'claude',
        agentRuntime: 'claude-interactive',
      }),
    );
  });

  it('does not carry Codex PTY from quick configure into a workflow launch', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), { target: { value: 'codex-pty' } });
    });
    expect(screen.getByLabelText('Select Codex model')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-back-to-workflow'));
    });
    await selectWorkflowAndConfigure();

    const runtimeSelect = screen.getByLabelText('Select agent runtime') as HTMLSelectElement;
    await waitFor(() => expect(runtimeSelect.value).toBe('claude-sdk'));

    expect(mockEnsureSession).not.toHaveBeenCalled();
    expect(mockRunStart).not.toHaveBeenCalled();
    expect(mockCreateQuick).not.toHaveBeenCalled();
  });

  it('defaults the model to Opus, surfaces the fast-mode toggle (off), and threads both on launch', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // Model dropdown defaults to Opus; the Opus-only fast-mode toggle is present
    // and OFF by default.
    const modelSelect = screen.getByLabelText('Select Claude model') as HTMLSelectElement;
    expect(modelSelect.value).toBe('opus');
    expect(screen.getByTestId('wizard-fast-mode-row')).toBeInTheDocument();
    const fastToggle = screen.getByLabelText('Fast mode');
    expect(fastToggle).toHaveAttribute('aria-checked', 'false');

    // Turn fast mode ON, then launch — both ride the request as claudeConfig.
    await act(async () => {
      fireEvent.click(fastToggle);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, claudeConfig: { model: 'opus', fastMode: true } }),
    );
  });

  it('hides fast mode for a non-Opus model and never requests it', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select Claude model'), { target: { value: 'sonnet' } });
    });
    // Fast mode is Opus-only — the toggle disappears for Sonnet.
    expect(screen.queryByTestId('wizard-fast-mode-row')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, claudeConfig: { model: 'sonnet', fastMode: false } }),
    );
  });

  it('shows the reasoning-effort select for a Claude quick session and threads the choice on launch', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // IDEA-029: the effort select is Claude-quick-only (Codex quick + Ultracode
    // emit no --effort flag, so the control is gated out there).
    const effortSelect = screen.getByTestId('wizard-effort-select') as HTMLSelectElement;
    expect(effortSelect.value).toBe(''); // 'Default' — no explicit selection

    await act(async () => {
      fireEvent.change(effortSelect, { target: { value: 'high' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        claudeConfig: { model: 'opus', fastMode: false, reasoningEffort: 'high' },
      }),
    );
  });

  it('shows the reasoning-effort select for a codex-sdk quick session (Codex scale) and threads it via setEffort', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // Present under the default Claude SDK runtime...
    expect(screen.getByTestId('wizard-effort-select')).toBeInTheDocument();

    // ...and STILL present once the runtime flips to codex-sdk (IDEA-029: the
    // app-server turn carries `effort`). The runtime flip clears the prior Claude
    // pick (scales differ), so the select resets to 'Default', now on the Codex
    // scale — which exposes the Codex-only 'minimal' level.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), { target: { value: 'codex-sdk' } });
    });
    const effortSelect = screen.getByTestId('wizard-effort-select') as HTMLSelectElement;
    expect(effortSelect.value).toBe(''); // reset to 'Default' on the runtime flip
    expect(screen.getByRole('option', { name: 'minimal' })).toBeInTheDocument(); // Codex-only level

    await act(async () => {
      fireEvent.change(effortSelect, { target: { value: 'minimal' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    // codex-sdk carries effort via panel-settings persistence (setEffort), NOT
    // claudeConfig (create-quick reads claudeConfig only for the Claude provider).
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, agentProvider: 'codex', agentRuntime: 'codex-sdk' }),
    );
    expect(mockCreateQuick.mock.calls[0]?.[0]).not.toHaveProperty('claudeConfig');
    expect(vi.mocked(API.claudePanels.setEffort)).toHaveBeenCalledWith('panel-001', 'minimal');
  });

  it('hides the reasoning-effort select for a codex-pty quick session (no turn-options object)', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // Present under the default Claude SDK runtime...
    expect(screen.getByTestId('wizard-effort-select')).toBeInTheDocument();

    // ...gone once the runtime flips to codex-pty — the PTY CLI emits no effort flag.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), { target: { value: 'codex-pty' } });
    });
    expect(screen.queryByTestId('wizard-effort-select')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mixed-provider retry prompt (Phase 2 slice D2) — a launch that fails with
// MixedProviderOrchestratedError (a step pinned to Codex under orchestrated
// execution) must NOT surface a raw launch error. Instead the wizard offers a
// confirm prompt to retry the SAME launch with executionModel forced to
// 'programmatic'. Any other error keeps the ordinary launch-error path.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — mixed-provider retry prompt', () => {
  beforeEach(() => {
    mockWorkflowsList.mockResolvedValue([CUSTOM_WORKFLOW_ROW]);
  });

  it('shows the confirm prompt (no raw error) when the launch fails with the mixed-provider error', async () => {
    mockRunStart.mockRejectedValueOnce(new Error('[MIXED_PROVIDER_REQUIRES_PROGRAMMATIC] This workflow runs one or more steps on Codex, which requires programmatic execution.'));
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(screen.getByTestId('mixed-provider-switch-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('mixed-provider-switch-cancel')).toBeInTheDocument();
    expect(screen.getByTestId('mixed-provider-switch-prompt')).toHaveClass('sticky');
    expect(screen.getByTestId('wizard-cta')).toBeDisabled();
    // No raw launch error rendered.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockRunStart).toHaveBeenCalledOnce();
  });

  it('retries the same launch with executionModel:"programmatic" on confirm', async () => {
    mockRunStart.mockRejectedValueOnce(new Error('[MIXED_PROVIDER_REQUIRES_PROGRAMMATIC] needs programmatic'));
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await screen.findByTestId('mixed-provider-switch-confirm');

    await act(async () => {
      fireEvent.click(screen.getByTestId('mixed-provider-switch-confirm'));
    });

    expect(mockRunStart).toHaveBeenCalledTimes(2);
    expect(mockEnsureSession).toHaveBeenCalledOnce();
    expect(mockRunStart.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ sessionId: 'session-ensured-001' }),
    );
    expect(mockRunStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', executionModel: 'programmatic' }),
    );
    // The second launch succeeded — the prompt is gone and the session opened.
    expect(screen.queryByTestId('mixed-provider-switch-confirm')).toBeNull();
    expect(useNavigationStore.getState().view).toBe('session');
  });

  it('dismisses the prompt without relaunching on cancel', async () => {
    mockRunStart.mockRejectedValueOnce(new Error('[MIXED_PROVIDER_REQUIRES_PROGRAMMATIC] needs programmatic'));
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await screen.findByTestId('mixed-provider-switch-confirm');

    await act(async () => {
      fireEvent.click(screen.getByTestId('mixed-provider-switch-cancel'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockDeleteSession).toHaveBeenCalledWith('session-ensured-001');
    expect(screen.queryByTestId('mixed-provider-switch-confirm')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the normal launch-error path for a DIFFERENT error', async () => {
    mockRunStart.mockRejectedValueOnce(new Error('boom'));
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(screen.queryByTestId('mixed-provider-switch-confirm')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });

  it('reuses the pre-created session for the Sprint batch retry', async () => {
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW]);
    mockRunStart.mockRejectedValueOnce(new Error('[MIXED_PROVIDER_REQUIRES_PROGRAMMATIC] needs programmatic'));
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-batch-pick'));
    });
    await screen.findByTestId('mixed-provider-switch-confirm');

    await act(async () => {
      fireEvent.click(screen.getByTestId('mixed-provider-switch-confirm'));
    });

    expect(mockEnsureSession).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledTimes(2);
    expect(mockRunStart.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        sessionId: 'session-ensured-001',
        taskIds: ['IDEA-1', 'IDEA-2'],
        executionModel: 'programmatic',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Ultracode configure + launch — the Ultracode card shares the quick session's
// Configure controls (model picker + Advanced MCP/plugin disclosure) but pins
// the interactive substrate (no selector) and defaults the model to Fable when
// the availability snapshot says it's usable.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — Ultracode configure + launch', () => {
  it('shows the model picker (default Fable) + Advanced disclosure, hides substrate + fast mode', async () => {
    await renderLockedWizard();
    await selectUltracodeAndConfigure();

    // Model picker defaults to Fable (available in this test) and appears in the
    // launch summary; fast mode stays QUICK-only even though it's a quick-shaped
    // launch.
    const modelSelect = screen.getByLabelText('Select Claude model') as HTMLSelectElement;
    expect(modelSelect.value).toBe('fable');
    expect(screen.queryByTestId('wizard-fast-mode-row')).toBeNull();

    // Substrate is pinned to interactive — no selector.
    expect(screen.queryByLabelText('Select agent runtime')).toBeNull();

    // Advanced (MCP/plugin) disclosure is offered, same as a quick launch.
    expect(screen.getByTestId('wizard-advanced-toggle')).toBeInTheDocument();
    // No blueprint editor (nothing to edit).
    expect(screen.queryByTestId('wizard-edit-flow')).toBeNull();
  });

  it('threads model + interactive substrate + ultracode effort into createQuick', async () => {
    await renderLockedWizard();
    await selectUltracodeAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).not.toHaveBeenCalled();
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        substrate: 'interactive',
        agentProvider: 'claude',
        agentRuntime: 'claude-interactive',
        effort: 'ultracode',
        claudeConfig: { model: 'fable', fastMode: false },
      }),
    );
  });

  it('threads an explicit model override into an ultracode launch', async () => {
    await renderLockedWizard();
    await selectUltracodeAndConfigure();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select Claude model'), { target: { value: 'sonnet' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        effort: 'ultracode',
        claudeConfig: { model: 'sonnet', fastMode: false },
      }),
    );
  });

  it('falls back to the Opus default when Fable is unavailable', async () => {
    modelAvailability.fableUnavailable = true;
    await renderLockedWizard();
    await selectUltracodeAndConfigure();

    const modelSelect = screen.getByLabelText('Select Claude model') as HTMLSelectElement;
    expect(modelSelect.value).toBe('opus');
  });

  it('re-seeds per-launcher defaults on card bounce, but never clobbers an explicit choice', async () => {
    await renderLockedWizard();

    // Untouched: ultracode seeds Fable, bouncing back to quick re-seeds Opus.
    await selectUltracodeAndConfigure();
    expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('fable');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-back-to-workflow'));
    });
    await selectQuickAndConfigure();
    expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('opus');

    // Touched: an explicit pick survives a bounce to ultracode.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select Claude model'), { target: { value: 'sonnet' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-back-to-workflow'));
    });
    await selectUltracodeAndConfigure();
    expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('sonnet');
  });
});

// ---------------------------------------------------------------------------
// Per-run-type stored defaults + the seeded-selection latch (TASK-160). The
// model control is driven by useSeededSelection, keyed by the wizard card
// (quick/ultracode share the synthetic 'quick' key, a workflow keys per flow),
// seeded from config.runTypeDefaults with today's floor as the fallback. These
// pin the seams that the refactor could silently regress:
//   - the cross-provider effort RESET still wins over effort seeding;
//   - programmatic family coercion goes through `reseed`, so it never latches
//     the key as touched and reactive re-seeding keeps working;
//   - a stored per-key model default outranks the floor.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — run-type defaults + seeded model selection', () => {
  // The workflows.list mock is module-level and its resolved value PERSISTS
  // across describes, so the two-row fixtures below (per-workflow-key seeding)
  // would otherwise leak into whatever describe runs next. Pin it back to the
  // single default row around every test in here.
  beforeEach(() => {
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW]);
  });
  afterEach(() => {
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW]);
  });

  it('still clears a pending reasoning effort when the runtime flips to Codex', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    const effortSelect = screen.getByTestId('wizard-effort-select') as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(effortSelect, { target: { value: 'high' } });
    });
    expect((screen.getByTestId('wizard-effort-select') as HTMLSelectElement).value).toBe('high');

    // The Claude scale ('high') has no meaning on the Codex turn options — the
    // flip must clear it so a stale cross-provider value can never ride a launch.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), { target: { value: 'codex-sdk' } });
    });
    expect((screen.getByTestId('wizard-effort-select') as HTMLSelectElement).value).toBe('');
  });

  it('lets the runtime-flip effort reset win over the stored quick effort seed', async () => {
    act(() => {
      useConfigStore.setState({
        config: { runTypeDefaults: { quick: { reasoningEffort: 'high' } } } as unknown as AppConfig,
      });
    });
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // Seeded from runTypeDefaults.quick.reasoningEffort...
    expect((screen.getByTestId('wizard-effort-select') as HTMLSelectElement).value).toBe('high');

    // ...and STILL cleared by the provider flip: the seeding effect must not
    // re-apply the stored value on a runtime change (it is not a dependency).
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), { target: { value: 'codex-sdk' } });
    });
    expect((screen.getByTestId('wizard-effort-select') as HTMLSelectElement).value).toBe('');
  });

  it('keeps the model key UNTOUCHED across Codex→Claude→Codex runtime flips, so re-seeding still works', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();
    expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('opus');

    // Codex → Claude → Codex, ZERO interaction with the model control. Each
    // Codex leg coerces the Claude pin onto the Codex family default.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), { target: { value: 'codex-sdk' } });
    });
    expect((screen.getByLabelText('Select Codex model') as HTMLSelectElement).value).toBe('auto');
    // The Claude leg is asserted only as "the Claude picker is back": the Codex
    // family default is 'auto', which isCodexModelFamily does NOT match, so the
    // reverse coercion is a deliberate no-op and 'auto' rides through unchanged
    // — pre-existing behavior, untouched by the seeded-selection refactor.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), { target: { value: 'claude-sdk' } });
    });
    expect(screen.getByLabelText('Select Claude model')).toBeInTheDocument();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), { target: { value: 'codex-sdk' } });
    });
    expect((screen.getByLabelText('Select Codex model') as HTMLSelectElement).value).toBe('auto');

    // The coercions used `reseed`, not `setByUser`, so the 'quick' key is still
    // untouched — bouncing to Ultracode (same key, Fable seed) must re-seed. This
    // also covers the flush where the hook re-seeds AND the effective runtime
    // flips back to Claude in one go: the seed, not the Opus floor, must win.
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-back-to-workflow'));
    });
    await selectUltracodeAndConfigure();
    expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('fable');
  });

  it('seeds the quick card from runTypeDefaults.quick.model instead of the Opus floor', async () => {
    act(() => {
      useConfigStore.setState({
        config: { runTypeDefaults: { quick: { model: 'sonnet' } } } as unknown as AppConfig,
      });
    });
    await renderLockedWizard();
    await selectQuickAndConfigure();

    expect((screen.getByLabelText('Select Claude model') as HTMLSelectElement).value).toBe('sonnet');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: { model: 'sonnet', fastMode: false } }),
    );
  });

  // ── The cross-provider effort reset (the highest-risk contract here) ───────
  // The reset is direction-agnostic: it fires on ANY effective-runtime change,
  // so the Codex→Claude leg must clear just as hard as Claude→Codex. Only the
  // Claude→Codex direction was pinned before; a seeding effect that re-applied
  // on a runtime change would regress the reverse leg silently, letting a
  // Codex-only level ('minimal' does not exist on the Claude scale) ride a
  // Claude launch and be dropped at the spawn seam while the pill showed it.

  it('clears a Codex-scale effort when the runtime flips BACK to Claude (the reset is symmetric)', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await chooseRuntime('codex-sdk');
    await act(async () => {
      fireEvent.change(screen.getByTestId('wizard-effort-select'), { target: { value: 'minimal' } });
    });
    expect(effortValue()).toBe('minimal');

    // 'minimal' is Codex-only — flipping back to a Claude runtime must clear it.
    await chooseRuntime('claude-sdk');
    expect(effortValue()).toBe('');
    // ...and it is not merely invisible-but-set: the Claude scale never offers it.
    expect(screen.queryByRole('option', { name: 'minimal' })).toBeNull();
  });

  it('never resurrects the stored quick effort after a Claude→Codex→Claude round trip', async () => {
    // The seeding effect's deps are [card kind, stored value] ONLY. If the
    // effective runtime were a dep, coming back to Claude would re-apply the
    // stored 'high' and quietly undo the reset the user just triggered.
    setRunTypeDefaults({ quick: { reasoningEffort: 'high' } });
    await renderLockedWizard();
    await selectQuickAndConfigure();
    expect(effortValue()).toBe('high');

    await chooseRuntime('codex-sdk');
    expect(effortValue()).toBe('');
    await chooseRuntime('claude-sdk');
    expect(effortValue()).toBe('');
  });

  it('ignores a stored quick effort that is off the CURRENT provider scale', async () => {
    // 'minimal' is a Codex-only level; under the seeded Claude runtime the spawn
    // seam would drop it, so the control must never show it as active.
    setRunTypeDefaults({ quick: { reasoningEffort: 'minimal' } });
    await renderLockedWizard();
    await selectQuickAndConfigure();

    expect(effortValue()).toBe('');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    // No reasoningEffort rides the launch — claudeConfig carries model+fastMode only.
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: { model: 'opus', fastMode: false } }),
    );
  });

  // ── The touched latch survives programmatic coercion ──────────────────────

  it('still re-seeds the model from a CHANGED stored default after Codex→Claude→Codex flips', async () => {
    // AC4, asserted through observable behavior rather than hook internals: if
    // any of the family coercions had gone through setByUser instead of reseed,
    // the 'quick' key would be latched and this stored-default change would be
    // ignored.
    await renderLockedWizard();
    await selectQuickAndConfigure();
    expect(claudeModelValue()).toBe('opus');

    await chooseRuntime('codex-sdk');
    await chooseRuntime('claude-sdk');
    await chooseRuntime('codex-sdk');
    await chooseRuntime('claude-sdk');

    // Zero interaction with the model control so far → the key is untouched and
    // a Settings edit must re-seed the open wizard.
    setRunTypeDefaults({ quick: { model: 'sonnet' } });
    expect(claudeModelValue()).toBe('sonnet');

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: { model: 'sonnet', fastMode: false } }),
    );
  });

  it('STOPS re-seeding the model once the user picks one, even when the stored default changes', async () => {
    // The non-vacuity twin of the test above: the same stored-default edit that
    // lands on an untouched key must be ignored on a touched one.
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select Claude model'), { target: { value: 'haiku' } });
    });
    setRunTypeDefaults({ quick: { model: 'sonnet' } });

    expect(claudeModelValue()).toBe('haiku');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: { model: 'haiku', fastMode: false } }),
    );
  });

  // ── Byte-identical no-config floors, per card path ────────────────────────

  it('seeds the Ultracode floor from availability ALONE when nothing is configured', async () => {
    // AC2, both branches, config left null: Fable usable → 'fable', greyed out
    // → the plain Opus floor. Two renders because the availability snapshot is
    // read at seed time.
    const unmount = await renderLockedWizard();
    await selectUltracodeAndConfigure();
    expect(claudeModelValue()).toBe('fable');
    expect(useConfigStore.getState().config).toBeNull();
    unmount();

    modelAvailability.fableUnavailable = true;
    await renderLockedWizard();
    await selectUltracodeAndConfigure();
    expect(claudeModelValue()).toBe('opus');
  });

  it("seeds today's exact floor for every card path when nothing is configured", async () => {
    // The four card paths that used to call the old imperative model-seeding
    // callback, walked in one render: quick / ultracode / workflow / design.
    // Only Ultracode leaves Opus.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW]);
    await renderLockedWizard();

    await selectQuickAndConfigure();
    expect(claudeModelValue()).toBe('opus');

    await backToWorkflow();
    await selectUltracodeAndConfigure();
    expect(claudeModelValue()).toBe('fable');

    await backToWorkflow();
    await selectWorkflowAndConfigure();
    expect(claudeModelValue()).toBe('opus');

    await backToWorkflow();
    await selectDesignAndConfigure();
    expect(claudeModelValue()).toBe('opus');

    expect(useConfigStore.getState().config).toBeNull();
  });

  it('lets a stored quick default outrank the Ultracode Fable floor (quick + ultracode share one key)', async () => {
    // Quick and Ultracode both key off the synthetic global 'quick' key, so an
    // explicitly configured default is the user's word on both cards — it must
    // beat the availability-derived Fable floor rather than the other way round.
    setRunTypeDefaults({ quick: { model: 'sonnet' } });
    await renderLockedWizard();

    await selectUltracodeAndConfigure();
    expect(claudeModelValue()).toBe('sonnet');
    await backToWorkflow();
    await selectQuickAndConfigure();
    expect(claudeModelValue()).toBe('sonnet');
  });

  it('keeps the Design card on its OWN key — it never inherits the stored quick default', async () => {
    setRunTypeDefaults({ quick: { model: 'sonnet' } });
    await renderLockedWizard();

    // Quick honours the stored default...
    await selectQuickAndConfigure();
    expect(claudeModelValue()).toBe('sonnet');

    // ...design does not: it is excluded from the stored-defaults surface and
    // stays on the plain Opus floor.
    await backToWorkflow();
    await selectDesignAndConfigure();
    expect(claudeModelValue()).toBe('opus');
  });

  it('degrades a stored CODEX-family default to the Opus floor under a Claude runtime', async () => {
    // A cross-provider stored default is reachable (the key is provider-blind).
    // The seed lands the Codex id, the family-coercion effect immediately
    // reseeds the Claude floor, and — because the hook's seed effect is keyed on
    // [key, seed] and never on `value` — the two settle instead of ping-ponging.
    setRunTypeDefaults({ quick: { model: 'gpt-5.4' } });
    await renderLockedWizard();
    await selectQuickAndConfigure();

    expect(claudeModelValue()).toBe('opus');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: { model: 'opus', fastMode: false } }),
    );
  });

  // ── Per-workflow key isolation ────────────────────────────────────────────

  it('seeds each workflow from its OWN stored default and threads it into runs.start', async () => {
    mockWorkflowsList.mockResolvedValue([CUSTOM_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    setRunTypeDefaults({
      'workflow:wf-1': { model: 'haiku' },
      'workflow:wf-compound': { model: 'sonnet' },
    });
    await renderLockedWizard();

    // Switching the selected flow BEFORE touching the model re-seeds to the new
    // flow's default — the previous flow's value must not ride along.
    await selectWorkflowRowAndConfigure('/custom');
    expect(claudeModelValue()).toBe('haiku');
    await backToWorkflow();
    await selectWorkflowRowAndConfigure('/compound');
    expect(claudeModelValue()).toBe('sonnet');
    await backToWorkflow();
    await selectWorkflowRowAndConfigure('/custom');
    expect(claudeModelValue()).toBe('haiku');

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', model: 'haiku' }),
    );
  });

  it("does not leak one workflow key's user pin onto another workflow", async () => {
    // Nothing configured, so both flows floor to Opus. A pin on /custom is
    // per-key: /compound must still seed Opus, and returning to /custom must
    // restore the pin (each key tracks its own touched value).
    mockWorkflowsList.mockResolvedValue([CUSTOM_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    await renderLockedWizard();

    await selectWorkflowRowAndConfigure('/custom');
    expect(claudeModelValue()).toBe('opus');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select Claude model'), { target: { value: 'haiku' } });
    });

    await backToWorkflow();
    await selectWorkflowRowAndConfigure('/compound');
    expect(claudeModelValue()).toBe('opus');

    await backToWorkflow();
    await selectWorkflowRowAndConfigure('/custom');
    expect(claudeModelValue()).toBe('haiku');
  });
});

// ---------------------------------------------------------------------------
// Seeded Configure controls (SCP-1). The feature's promise is that a run type
// FOLLOWS its saved defaults. The launch payload honoured them, but the
// Configure controls seeded only the model — so permission + runtime displayed
// the GLOBAL defaults, and the next "Save as default" from that screen wrote
// those global values back over the stored ones. That second-order effect is
// the real damage: the feature lost data on ordinary use.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — Configure controls seed from the stored per-type default', () => {
  const mockApplyRunTypeDefault = vi.fn(
    async (_key: string, _op: RunTypeDefaultsOp): Promise<ApplyRunTypeDefaultResult> => ({
      ok: true,
      previous: null,
    }),
  );

  beforeEach(() => {
    mockApplyRunTypeDefault.mockClear();
    mockApplyRunTypeDefault.mockResolvedValue({ ok: true, previous: null });
    mockWorkflowsList.mockResolvedValue([CUSTOM_WORKFLOW_ROW]);
    act(() => {
      useConfigStore.setState({ applyRunTypeDefault: mockApplyRunTypeDefault });
    });
  });
  afterEach(() => {
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW]);
  });

  /**
   * Install a config with BOTH a global permission default and a runTypeDefaults
   * map, so "seeded from the stored per-type value" and "seeded from the global"
   * are distinguishable rather than coincidentally equal.
   */
  function setConfig(
    runTypeDefaults: Record<string, RunTypeDefaults>,
    globals?: { defaultAgentPermissionMode?: string; quickSessionDefaultSubstrate?: string },
  ): void {
    act(() => {
      useConfigStore.setState({
        config: { runTypeDefaults, ...globals } as unknown as AppConfig,
      });
    });
  }

  // ── AC1: every control seeds, with no user interaction ───────────────────

  it('seeds model, permission mode AND runtime from the stored workflow default', async () => {
    setConfig(
      {
        'workflow:wf-1': {
          model: 'sonnet',
          permissionMode: 'auto',
          agentRuntime: 'claude-interactive',
        },
      },
      // Deliberately DIFFERENT from the stored values: if a control fell back to
      // the global rung the assertions below would read 'dontAsk' / 'claude-sdk'.
      { defaultAgentPermissionMode: 'dontAsk' },
    );
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    expect(claudeModelValue()).toBe('sonnet');
    expect(pressedPermissionLabel()).toBe('Auto');
    expect(runtimeValue()).toBe('claude-interactive');
  });

  it('threads the seeded (untouched) controls into the launch payload', async () => {
    setConfig(
      {
        'workflow:wf-1': {
          model: 'sonnet',
          permissionMode: 'auto',
          agentRuntime: 'claude-interactive',
        },
      },
      { defaultAgentPermissionMode: 'dontAsk' },
    );
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'sonnet',
        permissionMode: 'auto',
        agentRuntime: 'claude-interactive',
        // Derived FROM the runtime, never resolved independently — that is what
        // keeps a stored 'claude-interactive' from being paired with an 'sdk'
        // substrate floor.
        substrate: 'interactive',
      }),
    );
  });

  // ── AC2: round-trip integrity — THE data-loss case ───────────────────────

  // The defect in one test: seed from a stored default, edit ONE knob, hit "Save
  // as default". Before the fix the permission/runtime controls showed the
  // global values, so this write silently replaced the user's stored per-type
  // default with them. (The CTA is dirty-gated, hence the one real edit — every
  // OTHER control stays untouched, which is what this pins.)
  it('writes back what was STORED for the untouched controls, not the global defaults', async () => {
    setConfig(
      {
        'workflow:wf-1': {
          model: 'sonnet',
          permissionMode: 'auto',
          agentRuntime: 'claude-interactive',
        },
      },
      { defaultAgentPermissionMode: 'dontAsk' },
    );
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    // One real edit reveals the CTA; permission + runtime stay seeded from the
    // stored entry.
    await chooseModel('haiku');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-default'));
    });

    expect(mockApplyRunTypeDefault).toHaveBeenCalledOnce();
    expect(mockApplyRunTypeDefault).toHaveBeenCalledWith('workflow:wf-1', {
      kind: 'merge',
      value: {
        model: 'haiku',
        permissionMode: 'auto',
        agentRuntime: 'claude-interactive',
        // The stored entry carried no substrate (picking a runtime in Settings
        // CLEARS a now-mismatched one); the runtime OWNS it, so writing the
        // implied 'interactive' is equivalent, never contradictory.
        substrate: 'interactive',
      },
    });
    // The global values must appear nowhere in the written patch.
    const [, op] = mockApplyRunTypeDefault.mock.calls[0];
    expect(op).not.toEqual(
      expect.objectContaining({
        value: expect.objectContaining({ permissionMode: 'dontAsk' }),
      }),
    );
  });

  it('round-trips the quick card, including its stored reasoning effort', async () => {
    setConfig(
      {
        quick: {
          model: 'haiku',
          permissionMode: 'acceptEdits',
          agentRuntime: 'claude-sdk',
          reasoningEffort: 'high',
        },
      },
      { defaultAgentPermissionMode: 'dontAsk', quickSessionDefaultSubstrate: 'interactive' },
    );
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // Seeded — note the runtime is the STORED 'claude-sdk', not the
    // quick-session substrate preference ('interactive') it would otherwise take.
    expect(claudeModelValue()).toBe('haiku');
    expect(pressedPermissionLabel()).toBe('Allow edits');
    expect(runtimeValue()).toBe('claude-sdk');
    expect(effortValue()).toBe('high');

    // The CTA is dirty-gated, so move ONE control (the model) off its seed; the
    // permission, runtime and effort round-trip untouched.
    await chooseModel('sonnet');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-default'));
    });
    expect(mockApplyRunTypeDefault).toHaveBeenCalledWith('quick', {
      kind: 'merge',
      value: {
        model: 'sonnet',
        permissionMode: 'acceptEdits',
        agentRuntime: 'claude-sdk',
        substrate: 'sdk',
        reasoningEffort: 'high',
      },
    });
  });

  // DES-6 — a stored quick substrate with NO accompanying runtime (reachable
  // from Settings: pick a substrate, then set Agent runtime back to "Follow
  // defaults", which clears `agentRuntime` and leaves `substrate` standing).
  // `useQuickSession.startWithDefaults` honored it; this surface fed the GLOBAL
  // preference into the resolver's `agentRuntime` rung — which OUTRANKS a stored
  // substrate — and then re-derived the substrate back off that runtime, so the
  // same config launched a different transport here than from the shortcut.
  it('honors a stored quick substrate with no runtime over the global preference', async () => {
    setConfig(
      { quick: { substrate: 'interactive' } },
      // Deliberately the OPPOSITE, so "stored wins" is distinguishable.
      { quickSessionDefaultSubstrate: 'sdk' },
    );
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // The picker seeds to the runtime that OWNS the resolved transport, so the
    // screen shows what the launch will actually do.
    expect(runtimeValue()).toBe('claude-interactive');

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        substrate: 'interactive',
        agentRuntime: 'claude-interactive',
        agentProvider: 'claude',
      }),
    );
  });

  /**
   * Deliberate pin for the seed's no-stored-runtime fallback.
   *
   * 'codex-exec' is the headless exec runtime — never offered by any picker, but
   * reachable via a hand-edited config. It used to seed NOTHING, so the control
   * fell through to `useSeededSelection`'s type-level fallback
   * (`DEFAULT_SESSION_AGENT_RUNTIME`) and the quick card launched on 'sdk' while
   * the resolver — and `useQuickSession.startWithDefaults`, which drops the
   * unlaunchable runtime and keeps the resolved substrate — said 'interactive'.
   * It now degrades to the runtime that OWNS the resolved substrate, so the two
   * seams agree on the transport for the same config. Pinned rather than left to
   * chance: it is a genuine behavior change, and the next person to touch this
   * fallback should have to decide against it explicitly.
   */
  it("degrades a stored, unlaunchable 'codex-exec' to the resolved substrate's runtime", async () => {
    setConfig(
      { quick: { agentRuntime: 'codex-exec' } },
      { quickSessionDefaultSubstrate: 'interactive' },
    );
    await renderLockedWizard();
    await selectQuickAndConfigure();

    expect(runtimeValue()).toBe('claude-interactive');

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ substrate: 'interactive', agentRuntime: 'claude-interactive' }),
    );
  });

  // ── AC3: switching the selected workflow re-seeds, with no leak ──────────

  it('re-seeds every control when the selected workflow changes (no leak from the prior flow)', async () => {
    mockWorkflowsList.mockResolvedValue([CUSTOM_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    setConfig({
      'workflow:wf-1': {
        model: 'haiku',
        permissionMode: 'auto',
        agentRuntime: 'claude-interactive',
      },
      'workflow:wf-compound': {
        model: 'sonnet',
        permissionMode: 'acceptEdits',
        agentRuntime: 'claude-sdk',
      },
    });
    await renderLockedWizard();

    await selectWorkflowRowAndConfigure('/custom');
    expect(claudeModelValue()).toBe('haiku');
    expect(pressedPermissionLabel()).toBe('Auto');
    expect(runtimeValue()).toBe('claude-interactive');

    await backToWorkflow();
    await selectWorkflowRowAndConfigure('/compound');
    expect(claudeModelValue()).toBe('sonnet');
    expect(pressedPermissionLabel()).toBe('Allow edits');
    expect(runtimeValue()).toBe('claude-sdk');

    // …and back: each key still resolves its OWN stored entry.
    await backToWorkflow();
    await selectWorkflowRowAndConfigure('/custom');
    expect(pressedPermissionLabel()).toBe('Auto');
    expect(runtimeValue()).toBe('claude-interactive');
  });

  // ── AC4: a user edit wins and survives a re-render ───────────────────────

  it('lets a user pick beat the stored default and survive a later Settings change', async () => {
    setConfig({
      'workflow:wf-1': { permissionMode: 'auto', agentRuntime: 'claude-interactive' },
    });
    await renderLockedWizard();
    await selectWorkflowAndConfigure();
    expect(pressedPermissionLabel()).toBe('Auto');

    await choosePermission("Don't ask");
    await chooseRuntime('claude-sdk');

    // A Settings edit re-seeds only UNTOUCHED controls — the explicit picks stand.
    setRunTypeDefaults({
      'workflow:wf-1': { model: 'haiku', permissionMode: 'default', agentRuntime: 'codex-sdk' },
    });
    expect(pressedPermissionLabel()).toBe("Don't ask");
    expect(runtimeValue()).toBe('claude-sdk');
    // The untouched model control DID pick the change up.
    expect(claudeModelValue()).toBe('haiku');
  });

  // ── AC5: a runtime-family round trip must not latch anything touched ─────

  it('leaves the model + permission keys UNTOUCHED across a Codex→Claude runtime round trip', async () => {
    // Every programmatic coercion the flip triggers goes through `reseed`. If any
    // of them used `setByUser`, the key would latch and the stored-default change
    // below would be ignored for the rest of the mount.
    setConfig({ 'workflow:wf-1': { permissionMode: 'auto' } });
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await chooseRuntime('codex-sdk');
    await chooseRuntime('claude-sdk');

    setRunTypeDefaults({
      'workflow:wf-1': { model: 'sonnet', permissionMode: 'acceptEdits' },
    });
    expect(claudeModelValue()).toBe('sonnet');
    expect(pressedPermissionLabel()).toBe('Allow edits');
  });

  // ── AC7: nothing configured ⇒ byte-identical to the previous behaviour ───

  it('with NOTHING configured, every control seeds exactly as before', async () => {
    expect(useConfigStore.getState().config).toBeNull();
    await renderLockedWizard();

    // Workflow: Opus floor, the 'default' permission floor, the SDK runtime.
    await selectWorkflowAndConfigure();
    expect(claudeModelValue()).toBe('opus');
    expect(pressedPermissionLabel()).toBe('Ask before edits');
    expect(runtimeValue()).toBe('claude-sdk');

    // Quick: same model/permission floors, but the quick-session substrate
    // preference (absent ⇒ 'interactive') projected onto a Claude runtime.
    await backToWorkflow();
    await selectQuickAndConfigure();
    expect(claudeModelValue()).toBe('opus');
    expect(pressedPermissionLabel()).toBe('Ask before edits');
    expect(runtimeValue()).toBe('claude-interactive');
    expect(effortValue()).toBe('');
  });

  it("with NOTHING configured, the Ultracode card keeps its fable-when-usable / opus floor", async () => {
    expect(useConfigStore.getState().config).toBeNull();
    const unmount = await renderLockedWizard();
    await selectUltracodeAndConfigure();
    expect(claudeModelValue()).toBe('fable');
    // Ultracode hides the runtime picker (it always runs the interactive PTY).
    expect(screen.queryByLabelText('Select agent runtime')).toBeNull();
    expect(pressedPermissionLabel()).toBe('Ask before edits');

    // Fable greyed out ⇒ the Opus floor, unchanged.
    act(() => unmount());
    modelAvailability.fableUnavailable = true;
    await renderLockedWizard();
    await selectUltracodeAndConfigure();
    expect(claudeModelValue()).toBe('opus');
  });

  // ── AC8: the design card is outside the stored-defaults surface ──────────

  it('leaves the Design card unaffected by a stored default', async () => {
    setConfig(
      {
        // Both a quick entry (design must not inherit it) and a hand-written
        // 'design' entry (design has no save CTA, so this can only come from an
        // edited config — it must not steer the hard-pinned SDK runtime).
        quick: { model: 'sonnet', permissionMode: 'auto', agentRuntime: 'claude-interactive' },
        design: { agentRuntime: 'codex-sdk' },
      },
      { defaultAgentPermissionMode: 'acceptEdits' },
    );
    await renderLockedWizard();
    await selectDesignAndConfigure();

    // Plain Opus floor + the GLOBAL permission default, and no runtime picker at
    // all (design is hard-pinned to the Claude SDK substrate).
    expect(claudeModelValue()).toBe('opus');
    expect(pressedPermissionLabel()).toBe('Allow edits');
    expect(screen.queryByLabelText('Select agent runtime')).toBeNull();
    // No save CTA: design is excluded from the stored-defaults surface.
    expect(screen.queryByTestId('wizard-save-default')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// "Save as default" CTA + Undo (TASK-157) — a PERSISTENT affordance at the
// bottom of the Configure card, independent of launching in both directions.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — "Save as default" CTA + Undo (TASK-157)', () => {
  /**
   * Stand-in for the config store's `applyRunTypeDefault` action. The wizard
   * reads it off the store (never API.config directly), so swapping the action
   * itself both records the exact op written and lets a test stage the
   * `previous` entry the real IPC would return.
   */
  const mockApplyRunTypeDefault = vi.fn(
    async (_key: string, _op: RunTypeDefaultsOp): Promise<ApplyRunTypeDefaultResult> => ({
      ok: true,
      previous: null,
    }),
  );

  /** A promise the test resolves by hand, so overlapping writes are deterministic. */
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    mockApplyRunTypeDefault.mockClear();
    mockApplyRunTypeDefault.mockResolvedValue({ ok: true, previous: null });
    // Non-gated custom flow so the workflow card reaches ③ and (for the
    // side-effect-only proof) launches directly via runs.start.
    mockWorkflowsList.mockResolvedValue([CUSTOM_WORKFLOW_ROW]);
    act(() => {
      useConfigStore.setState({ applyRunTypeDefault: mockApplyRunTypeDefault });
    });
  });

  it('renders NO CTA on the workflow card until a control leaves its seeded value', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    // Nothing stored, nothing touched ⇒ nothing to save.
    expect(screen.queryByTestId('wizard-save-default')).toBeNull();
    // The launch surface itself is unaffected.
    expect(screen.getByTestId('wizard-launch-summary')).toBeInTheDocument();

    await chooseModel('sonnet');
    const saveBtn = screen.getByTestId('wizard-save-default');
    expect(saveBtn).toHaveTextContent('Save as default for Custom');
    expect(saveBtn).toBeEnabled();
    // The shared secondary Button — not the former inline text link.
    expect(saveBtn).toHaveClass('bg-surface-secondary');
    expect(saveBtn).not.toHaveClass('underline');
  });

  // The case a naive `isTouched` implementation gets wrong: `setByUser` latches
  // on ANY pick, including one that lands back on the seeded value — which would
  // strand the CTA on screen with nothing to write.
  it('hides the CTA again when a change is reverted to the seeded value', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await chooseModel('sonnet');
    expect(screen.getByTestId('wizard-save-default')).toBeInTheDocument();
    await chooseModel('opus');
    expect(screen.queryByTestId('wizard-save-default')).toBeNull();

    await choosePermission("Don't ask");
    expect(screen.getByTestId('wizard-save-default')).toBeInTheDocument();
    await choosePermission('Ask before edits');
    expect(screen.queryByTestId('wizard-save-default')).toBeNull();

    await chooseRuntime('claude-interactive');
    expect(screen.getByTestId('wizard-save-default')).toBeInTheDocument();
    await chooseRuntime('claude-sdk');
    expect(screen.queryByTestId('wizard-save-default')).toBeNull();
  });

  it('renders NO CTA for a card whose stored default the untouched controls already show', async () => {
    act(() => {
      useConfigStore.setState({
        config: {
          runTypeDefaults: {
            'workflow:wf-1': {
              model: 'haiku',
              permissionMode: 'auto',
              agentRuntime: 'claude-interactive',
              substrate: 'interactive',
            },
          },
        } as unknown as AppConfig,
        applyRunTypeDefault: mockApplyRunTypeDefault,
      });
    });
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    // Seeded straight from the stored entry ⇒ nothing to save.
    expect(claudeModelValue()).toBe('haiku');
    expect(runtimeValue()).toBe('claude-interactive');
    expect(screen.queryByTestId('wizard-save-default')).toBeNull();
  });

  it('writes model + permission + runtime/substrate under the workflow key WITHOUT launching', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await chooseModel('sonnet');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-default'));
    });

    expect(mockApplyRunTypeDefault).toHaveBeenCalledOnce();
    expect(mockApplyRunTypeDefault).toHaveBeenCalledWith('workflow:wf-1', {
      kind: 'merge',
      value: {
        model: 'sonnet',
        permissionMode: 'default',
        agentRuntime: 'claude-sdk',
        substrate: 'sdk',
      },
    });
    // Independence: saving is NOT a launch.
    expect(mockRunStart).not.toHaveBeenCalled();
    expect(mockCreateQuick).not.toHaveBeenCalled();
    expect(await screen.findByTestId('session-action-toast')).toHaveTextContent(
      'Saved as default for Custom',
    );
  });

  it("writes the quick card under the synthetic 'quick' key, INCLUDING reasoningEffort", async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // Pick a non-default effort so the captured value is unambiguous. On the
    // quick key effort is part of the saved field set, so this alone is enough
    // to reveal the CTA.
    expect(screen.queryByTestId('wizard-save-default')).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByTestId('wizard-effort-select'), { target: { value: 'high' } });
    });
    expect(screen.getByTestId('wizard-save-default')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-default'));
    });

    expect(screen.getByTestId('wizard-save-default')).toHaveTextContent(
      'Save as default for Quick sessions',
    );
    expect(mockApplyRunTypeDefault).toHaveBeenCalledWith('quick', {
      kind: 'merge',
      value: {
        model: 'opus',
        permissionMode: 'default',
        // Quick seeds the interactive PTY runtime from the (absent) global
        // quick-session substrate preference, which floors to 'interactive'.
        agentRuntime: 'claude-interactive',
        substrate: 'interactive',
        reasoningEffort: 'high',
      },
    });
    expect(mockCreateQuick).not.toHaveBeenCalled();
  });

  // The effort control belongs to the quick key alone. A pick made on the quick
  // card must NOT read as "dirty" on a workflow card, whose saved field set
  // excludes it. (Same provider on both cards here, so the cross-provider reset
  // does not fire and the picked effort genuinely survives the card switch.)
  it('does not count a quick-card effort pick as dirty on a workflow card', async () => {
    act(() => {
      useConfigStore.setState({
        config: { quickSessionDefaultSubstrate: 'sdk' } as unknown as AppConfig,
        applyRunTypeDefault: mockApplyRunTypeDefault,
      });
    });
    await renderLockedWizard();
    await selectQuickAndConfigure();
    expect(runtimeValue()).toBe('claude-sdk');

    await act(async () => {
      fireEvent.change(screen.getByTestId('wizard-effort-select'), { target: { value: 'high' } });
    });
    expect(screen.getByTestId('wizard-save-default')).toBeInTheDocument();

    await backToWorkflow();
    await selectWorkflowAndConfigure();
    expect(runtimeValue()).toBe('claude-sdk');
    expect(screen.queryByTestId('wizard-save-default')).toBeNull();

    // …and the pick really did survive the card switch (no cross-provider reset
    // fired), so the assertion above was about the EXCLUSION, not a cleared value.
    await backToWorkflow();
    await selectQuickAndConfigure();
    expect(effortValue()).toBe('high');
    expect(screen.getByTestId('wizard-save-default')).toBeInTheDocument();
  });

  it("sends reasoningEffort: null from the quick card's 'Default' option (clears a stored effort)", async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    // Untouched select — '' means "provider default", i.e. no explicit pin.
    expect(effortValue()).toBe('');
    // Dirty a DIFFERENT control, so the effort stays at its untouched default.
    await chooseModel('sonnet');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-default'));
    });

    expect(mockApplyRunTypeDefault).toHaveBeenCalledWith(
      'quick',
      expect.objectContaining({
        kind: 'merge',
        value: expect.objectContaining({ reasoningEffort: null }),
      }),
    );
  });

  it("writes the ultracode card under 'quick' but WITHOUT reasoningEffort", async () => {
    await renderLockedWizard();
    await selectUltracodeAndConfigure();

    await chooseModel('sonnet');
    expect(screen.getByTestId('wizard-save-default')).toHaveTextContent(
      'Save as default for Quick sessions',
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-default'));
    });

    expect(mockApplyRunTypeDefault).toHaveBeenCalledOnce();
    const [key, op] = mockApplyRunTypeDefault.mock.calls[0];
    expect(key).toBe('quick');
    expect(op.kind).toBe('merge');
    // Ultracode pins xhigh at spawn and exposes no effort control — writing the
    // field would persist a value the user never chose.
    expect(op.value).not.toHaveProperty('reasoningEffort');
    expect(op.value).toMatchObject({ agentRuntime: 'claude-interactive', substrate: 'interactive' });
  });

  it('renders NO CTA for the design card', async () => {
    await renderLockedWizard();
    await selectDesignAndConfigure();

    expect(screen.getByTestId('wizard-launch-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-save-default')).toBeNull();
  });

  it('writes substrate: null for a Codex runtime so a stale Claude substrate cannot survive', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    // The runtime change is itself the dirty edit that reveals the CTA.
    await chooseRuntime('codex-sdk');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-default'));
    });

    expect(mockApplyRunTypeDefault).toHaveBeenCalledWith(
      'workflow:wf-1',
      expect.objectContaining({
        kind: 'merge',
        value: expect.objectContaining({ agentRuntime: 'codex-sdk', substrate: null }),
      }),
    );
  });

  it('leaves the launch payload byte-identical (side-effect-only)', async () => {
    // Baseline: launch with no save at all. A successful wizard launch latches
    // startInFlightRef and navigates, so the "after" case needs its own mount.
    // Both halves make the same model edit — the one that reveals the CTA.
    const unmount = await renderLockedWizard();
    await selectWorkflowAndConfigure();
    await chooseModel('sonnet');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    const before = mockRunStart.mock.calls[0][0];
    act(() => {
      unmount();
    });

    // Same wizard, but the CTA fires before the launch.
    await renderLockedWizard();
    await selectWorkflowAndConfigure();
    await chooseModel('sonnet');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-default'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    const after = mockRunStart.mock.calls[1][0];

    expect(after).toEqual(before);
  });

  it('Undo DELETES the key ({ kind: replace, value: null }) when no prior default existed', async () => {
    // `{ ok: true, previous: null }` = the write LANDED and the key held nothing
    // — the only outcome that may replay as a deletion.
    mockApplyRunTypeDefault.mockResolvedValue({ ok: true, previous: null });
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await chooseModel('sonnet');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-default'));
    });
    const undoBtn = await screen.findByTestId('session-action-toast-action');
    await act(async () => {
      fireEvent.click(undoBtn);
    });

    expect(mockApplyRunTypeDefault).toHaveBeenCalledTimes(2);
    expect(mockApplyRunTypeDefault).toHaveBeenLastCalledWith('workflow:wf-1', {
      kind: 'replace',
      value: null,
    });
    // Explicitly NOT `value: undefined`, which would leave the write standing.
    expect(mockApplyRunTypeDefault.mock.calls[1][1]).not.toEqual({ kind: 'replace', value: undefined });
    await waitFor(() => expect(screen.queryByTestId('session-action-toast')).toBeNull());
  });

  it('Undo restores the exact prior entry when one existed', async () => {
    const previous: RunTypeDefaults = {
      model: 'sonnet',
      permissionMode: 'auto',
      substrate: 'interactive',
      agentRuntime: 'claude-interactive',
    };
    mockApplyRunTypeDefault.mockResolvedValue({ ok: true, previous });
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await chooseModel('sonnet');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-default'));
    });
    const undoBtn = await screen.findByTestId('session-action-toast-action');
    await act(async () => {
      fireEvent.click(undoBtn);
    });

    expect(mockApplyRunTypeDefault).toHaveBeenLastCalledWith('workflow:wf-1', {
      kind: 'replace',
      value: previous,
    });
  });

  // The visibility rule is seed-based, so the affordance is self-correcting: a
  // confirmed write makes live == seed (nothing left to save), and an Undo puts
  // the old stored entry back, which makes them diverge again.
  it('hides itself after a successful save and comes back after Undo', async () => {
    // Stand in for the real store action: remember what was written and hand
    // back the prior entry as `previous` (what Undo replays).
    let stored: RunTypeDefaults | null = null;
    mockApplyRunTypeDefault.mockImplementation(async (_key, op) => {
      const previous = stored;
      // This card's patch is total for the fixture (no null members), so 'merge'
      // and 'replace' collapse to "this value is now stored".
      stored = op.kind === 'replace' ? op.value : (op.value as RunTypeDefaults);
      return { ok: true, previous };
    });
    /** The post-write `fetchConfig` the real store action performs. */
    function refreshConfig(): void {
      act(() => {
        useConfigStore.setState({
          config: {
            runTypeDefaults: stored === null ? {} : { 'workflow:wf-1': stored },
          } as unknown as AppConfig,
        });
      });
    }
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await chooseModel('sonnet');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-default'));
    });
    refreshConfig();

    // The seed is now the value just stored, so there is nothing left to save.
    expect(screen.queryByTestId('wizard-save-default')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('session-action-toast-action'));
    });
    refreshConfig();

    // Undo deleted the key, so the controls re-seed to the 'opus' floor while the
    // (still-standing) 'sonnet' pick diverges from it again.
    expect(screen.getByTestId('wizard-save-default')).toBeInTheDocument();
  });

  it('a FAILED write shows a failure toast and offers NO Undo (never a deleting replace)', async () => {
    // The data-loss fix: the failed write left the stored default standing, so
    // an Undo replaying `{ kind: 'replace', value: null }` would delete a
    // default this surface never overwrote.
    mockApplyRunTypeDefault.mockResolvedValue({ ok: false, error: 'nope' });
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await chooseModel('sonnet');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-save-default'));
    });

    const toast = await screen.findByTestId('wizard-save-toast');
    expect(toast).toHaveAttribute('data-tone', 'error');
    expect(toast).toHaveTextContent("Couldn't save default for Custom");
    expect(screen.queryByTestId('session-action-toast-action')).toBeNull();
    // The failure tone reaches the actual toast, not just its wrapper — a
    // discarded `tone` prop would render this in the success (green) style.
    expect(screen.getByTestId('session-action-toast')).toHaveClass('bg-status-error');
    expect(mockApplyRunTypeDefault).toHaveBeenCalledOnce();
  });

  it('disables the CTA while a write is in flight and rejects a same-tick double click', async () => {
    const pending = deferred<ApplyRunTypeDefaultResult>();
    mockApplyRunTypeDefault.mockReturnValueOnce(pending.promise);
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await chooseModel('sonnet');
    const saveBtn = screen.getByTestId('wizard-save-default');
    // Two clicks in ONE tick: only the synchronous ref latch can stop the
    // second — `disabled` has not re-rendered yet.
    act(() => {
      fireEvent.click(saveBtn);
      fireEvent.click(saveBtn);
    });
    expect(mockApplyRunTypeDefault).toHaveBeenCalledOnce();
    await waitFor(() => expect(saveBtn).toBeDisabled());

    await act(async () => {
      pending.resolve({ ok: true, previous: { model: 'sonnet' } });
    });
    expect(saveBtn).toBeEnabled();

    // The Undo record belongs to the write that actually landed.
    await act(async () => {
      fireEvent.click(screen.getByTestId('session-action-toast-action'));
    });
    expect(mockApplyRunTypeDefault).toHaveBeenLastCalledWith('workflow:wf-1', {
      kind: 'replace',
      value: { model: 'sonnet' },
    });
  });
});

// ---------------------------------------------------------------------------
// Design idea gate + launch (design-mode.md v0) — Design is idea-bound: the
// CTA does NOT launch directly, it opens the idea picker (single-select, like
// Ship — NOT Planner's multi mode). A confirm fires the SAME useQuickSession
// hook Quick uses, but hard-pinned to the Claude SDK substrate/provider/
// runtime regardless of the wizard's agentRuntime state, with the picked idea
// threaded as the new `designIdeaId` param.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — Design idea gate + launch', () => {
  beforeEach(() => {
    mockIdeaPickerMulti.mockClear();
  });

  it('renders the Design option on step ② alongside Quick/Ultracode', async () => {
    await renderLockedWizard();
    expect(screen.getByTestId('design-card')).toBeInTheDocument();
  });

  it('hides the substrate/runtime picker but keeps the model + permission controls on ③', async () => {
    await renderLockedWizard();
    await selectDesignAndConfigure();

    expect(screen.getByTestId('wizard-cta')).toHaveTextContent('Start design session');
    expect(screen.queryByLabelText('Select agent runtime')).toBeNull();
    expect(screen.getByLabelText('Select Claude model')).toBeInTheDocument();
    expect(screen.getByLabelText('Permission mode: Auto')).toBeInTheDocument();
  });

  it('opens the idea picker (single-select, not a direct launch) when Design is started', async () => {
    await renderLockedWizard();
    await selectDesignAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    // The idea picker is shown, single-select — no launch has fired yet (the
    // gate is freely cancellable, mirroring the Planner/Ship/Sprint gates).
    expect(screen.getByTestId('mock-idea-pick')).toBeInTheDocument();
    expect(mockIdeaPickerMulti).toHaveBeenLastCalledWith(false);
    expect(mockRunStart).not.toHaveBeenCalled();
    expect(mockCreateQuick).not.toHaveBeenCalled();
  });

  it('threads designIdeaId + the hard-pinned SDK substrate into createQuick on confirm', async () => {
    await renderLockedWizard();
    await selectDesignAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-idea-pick'));
    });

    expect(mockRunStart).not.toHaveBeenCalled();
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        substrate: 'sdk',
        agentProvider: 'claude',
        agentRuntime: 'claude-sdk',
        designIdeaId: 'IDEA-7',
      }),
    );
  });

  // Auto-start kickoff + fullscreen-surface entry (design-mode.md v0.5
  // "Auto-start"). useQuickSession is NOT mocked in this file — the real hook
  // runs, so the kickoff surfaces at its actual dispatch target
  // (dispatchQuickSessionInput → API.panels.continue for the SDK 'continue'
  // path, since createQuick's `prompt` field is ignored) rather than as a
  // spy on `startQuickSession` itself.
  it('sends DESIGN_KICKOFF_PROMPT as the first panel input after a design launch', async () => {
    await renderLockedWizard();
    await selectDesignAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-idea-pick'));
    });

    expect(mockPanelsContinue).toHaveBeenCalledWith('panel-001', DESIGN_KICKOFF_PROMPT, undefined, undefined, undefined);
  });

  it('enters the fullscreen design surface for the created session on a design launch', async () => {
    await renderLockedWizard();
    await selectDesignAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-idea-pick'));
    });

    expect(useDesignModeStore.getState().activeDesignSessionId).toBe('session-quick-001');
  });

  it('a non-design quick launch sends no kickoff and never enters the design surface', async () => {
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockCreateQuick).toHaveBeenCalledOnce();
    expect(mockPanelsContinue).not.toHaveBeenCalled();
    expect(useDesignModeStore.getState().activeDesignSessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sprint batch gate (feat/parallel-sprint, single-run lane model) — Sprint is
// not launched directly from the CTA: it opens the task batch picker first, and
// a pick fires runs.start with the picked task ids threaded (ONE session-hosted
// run; the orchestrator agent fans the tasks out). Mirrors the Planner idea gate.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — Sprint batch gate', () => {
  beforeEach(() => {
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW]);
  });

  it('opens the task batch picker (not a direct run) when Sprint is launched', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    // The picker is shown; no run has been launched yet (picker is freely
    // cancellable — the in-flight latch has NOT flipped).
    expect(screen.getByTestId('mock-batch-pick')).toBeInTheDocument();
    expect(mockRunStart).not.toHaveBeenCalled();
  });

  it('fires runs.start (session-hosted) with the picked task ids and navigates to the session', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-batch-pick'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        projectId: 1,
        sessionId: 'session-ensured-001',
        substrate: 'sdk',
        agentProvider: 'claude',
        agentRuntime: 'claude-sdk',
        permissionMode: 'default',
        taskIds: ['IDEA-1', 'IDEA-2'],
      }),
    );
    // The run is nested under its session and the wizard navigates INTO it
    // (same close-out path as any workflow run — not home).
    expect(useCyboflowStore.getState().activeRunId).toBe('run-test-001');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-ensured-001');
    expect(useNavigationStore.getState().view).toBe('session');
  });
});

// ---------------------------------------------------------------------------
// Planner idea gate, multi-select batch (IDEA-009) — Planner is the ONLY flow
// that opens the idea picker in `multi` mode; a single pick still normalizes
// to the singular `ideaId`, while a 2+ pick threads `ideaIds`.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — Planner idea gate, multi-select batch', () => {
  beforeEach(() => {
    mockIdeaPickerMulti.mockClear();
    mockWorkflowsList.mockResolvedValue([PLANNER_WORKFLOW_ROW]);
  });

  it('opens the idea picker in multi mode', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(screen.getByTestId('mock-idea-pick')).toBeInTheDocument();
    expect(mockIdeaPickerMulti).toHaveBeenLastCalledWith(true);
    expect(mockRunStart).not.toHaveBeenCalled();
  });

  it('normalizes a single pick to the singular ideaId', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-idea-pick'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    const startArg = mockRunStart.mock.calls[0][0];
    expect(startArg).toEqual(expect.objectContaining({ workflowId: 'wf-1', ideaId: 'IDEA-7' }));
    expect(startArg).not.toHaveProperty('ideaIds');
  });

  it('threads a 2+ pick as ideaIds', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-idea-pick-batch'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    const startArg = mockRunStart.mock.calls[0][0];
    expect(startArg).toEqual(
      expect.objectContaining({ workflowId: 'wf-1', ideaIds: ['IDEA-7', 'IDEA-8'] }),
    );
    expect(startArg).not.toHaveProperty('ideaId');
  });
});

// ---------------------------------------------------------------------------
// Ship idea gate (feat/ship-workflow) — Ship runs planner ⊕ sprint in one
// continuous run and is IDEA-seeded like the planner: the CTA opens the idea
// picker (NOT the sprint task-batch picker), and a pick fires runs.start with the
// chosen ideaId threaded (NO taskIds — the executable subset is selected later,
// at the in-run approve-plan gate). Mirrors the Planner idea gate.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — Ship idea gate', () => {
  beforeEach(() => {
    mockIdeaPickerMulti.mockClear();
    mockWorkflowsList.mockResolvedValue([SHIP_WORKFLOW_ROW]);
  });

  it('opens the idea picker (NOT the batch picker) when Ship is launched, single-select (NOT multi)', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    // The idea picker is shown — NOT the sprint batch picker — and no run has
    // launched yet (the gate is freely cancellable). Multi-select (IDEA-009) is
    // Planner-only — Ship stays single-select.
    expect(screen.getByTestId('mock-idea-pick')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-batch-pick')).toBeNull();
    expect(mockIdeaPickerMulti).toHaveBeenLastCalledWith(false);
    expect(mockRunStart).not.toHaveBeenCalled();
  });

  it('fires runs.start with the picked ideaId (NO taskIds) and navigates to the session', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-idea-pick'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    const startArg = mockRunStart.mock.calls[0][0];
    expect(startArg).toEqual(
      expect.objectContaining({
        workflowId: 'wf-1',
        projectId: 1,
        sessionId: 'session-ensured-001',
        substrate: 'sdk',
        agentProvider: 'claude',
        agentRuntime: 'claude-sdk',
        permissionMode: 'default',
        ideaId: 'IDEA-7',
      }),
    );
    // Ship is idea-seeded, never batch-seeded — no taskIds threaded.
    expect(startArg).not.toHaveProperty('taskIds');
    // The run is nested under its session and the wizard navigates INTO it.
    expect(useCyboflowStore.getState().activeRunId).toBe('run-test-001');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-ensured-001');
    expect(useNavigationStore.getState().view).toBe('session');
  });
});

// ---------------------------------------------------------------------------
// Launch seed-prompt gate — the interview-driven super-planner needs a
// free-text "what are you building?" answer before its first turn, so the CTA
// opens LaunchPromptModal (NOT the idea picker or batch picker) and a submit
// fires runs.start with the trimmed answer threaded as `seedPrompt`.
// ---------------------------------------------------------------------------
describe('SessionStartWizard — Launch seed-prompt gate', () => {
  beforeEach(() => {
    mockWorkflowsList.mockResolvedValue([LAUNCH_WORKFLOW_ROW]);
  });

  it('opens LaunchPromptModal (not the idea/batch pickers) when Launch is launched', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    // The seed-prompt modal is shown — no run has launched yet (the gate is
    // freely cancellable).
    expect(screen.getByTestId('mock-launch-prompt-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-idea-pick')).toBeNull();
    expect(screen.queryByTestId('mock-batch-pick')).toBeNull();
    expect(mockRunStart).not.toHaveBeenCalled();
  });

  it('fires runs.start with the submitted seedPrompt and navigates to the session', async () => {
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-launch-prompt-submit'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    const startArg = mockRunStart.mock.calls[0][0];
    expect(startArg).toEqual(
      expect.objectContaining({
        workflowId: 'wf-1',
        projectId: 1,
        sessionId: 'session-ensured-001',
        substrate: 'sdk',
        agentProvider: 'claude',
        agentRuntime: 'claude-sdk',
        permissionMode: 'default',
        seedPrompt: 'A recipe app.',
      }),
    );
    // The run is nested under its session and the wizard navigates INTO it.
    expect(useCyboflowStore.getState().activeRunId).toBe('run-test-001');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-ensured-001');
    expect(useNavigationStore.getState().view).toBe('session');
  });
});

// ---------------------------------------------------------------------------
// Workflow preselect — an explicit preselect preselects the matching flow on
// load and auto-advances ② → ③ ONCE. Two kinds: `preselectWorkflowId` (gallery
// Run action, by unambiguous row id, TAKES PRECEDENCE) and `preselectWorkflowName`
// (Insights "Run compounding session" CTA, by built-in name). Contrast with the
// implicit DEFAULT_WORKFLOW_NAME preselect, which only sets selection state (no
// auto-advance).
// ---------------------------------------------------------------------------
describe('SessionStartWizard — workflow preselect', () => {
  it('preselects compound BY NAME and lands directly on ③ Configure', async () => {
    // The list carries both the default (sprint) and the preselect target so we
    // prove the explicit name — not the default — wins and drives the advance.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: { lockProjectId: 1, preselectWorkflowName: 'compound' },
      });
    });
    render(<SessionStartWizard />);

    // The preselect auto-advanced past ② Workflow straight to ③ Configure.
    await screen.findByTestId('wizard-step3');
    expect(screen.getByTestId('wizard-step3')).toBeInTheDocument();
    // The compound flow is the active selection → CTA reads "Run /compound".
    expect(screen.getByTestId('wizard-cta')).toHaveTextContent('Run /compound');
  });

  it('preselects BY ROW ID and lands directly on ③ Configure', async () => {
    // The gallery Run action passes the unambiguous workflow row id. The list
    // carries the default (sprint) plus the target so we prove the id — not the
    // default — wins and drives the auto-advance.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: { lockProjectId: 1, preselectWorkflowId: 'wf-compound' },
      });
    });
    render(<SessionStartWizard />);

    // The id preselect auto-advanced past ② Workflow straight to ③ Configure.
    await screen.findByTestId('wizard-step3');
    expect(screen.getByTestId('wizard-step3')).toBeInTheDocument();
    // The row with id 'wf-compound' (the compound flow) is the active selection.
    expect(screen.getByTestId('wizard-cta')).toHaveTextContent('Run /compound');
  });

  it('takes the row id over a colliding preselectWorkflowName', async () => {
    // When BOTH are set, the unambiguous row id wins: name 'sprint' would resolve
    // to wf-1, but the id 'wf-compound' must select the compound row instead.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: { lockProjectId: 1, preselectWorkflowId: 'wf-compound', preselectWorkflowName: 'sprint' },
      });
    });
    render(<SessionStartWizard />);

    await screen.findByTestId('wizard-step3');
    expect(screen.getByTestId('wizard-cta')).toHaveTextContent('Run /compound');
  });

  it('OMITS a setup flow from the launcher list while still preselecting it by name', async () => {
    // The render site, asserted end to end: verify-setup must not appear among
    // the flow cards (it configures the project rather than doing project
    // work), yet the Verify Queue's CTA — which preselects it BY NAME — must
    // still resolve it and advance. Reverting the filter, or filtering it out
    // of the meta array instead, breaks exactly one of these two.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, VERIFY_SETUP_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({ view: 'wizard', wizardOpts: { lockProjectId: 1 } });
    });
    const { unmount } = render(<SessionStartWizard />);

    await screen.findByTestId('workflow-list-row');
    const listed = screen.getAllByTestId('workflow-list-row').map((el) => el.textContent ?? '');
    expect(listed.some((t) => t.includes('/sprint'))).toBe(true);
    expect(listed.some((t) => t.includes('/verify-setup'))).toBe(false);
    unmount();

    // ...and the hidden row is still reachable by the CTA's by-name preselect.
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: { lockProjectId: 1, preselectWorkflowName: 'verify-setup' },
      });
    });
    render(<SessionStartWizard />);

    await screen.findByTestId('wizard-step3');
    expect(screen.getByTestId('wizard-cta')).toHaveTextContent('Run /verify-setup');
  });

  it('SAYS SO when a requested preselect does not resolve, instead of silently falling back', async () => {
    // The silent fallback to sprint is merely confusing for a flow the user can
    // still find in the list — but for a HIDDEN setup flow it is a dead end,
    // since the list is exactly where it is not.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: { lockProjectId: 1, preselectWorkflowName: 'verify-setup' },
      });
    });
    render(<SessionStartWizard />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /"verify-setup" is not available for this project/i,
    );
  });

  it('does NOT auto-advance the implicit default (sprint) preselect without the opt', async () => {
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({ view: 'wizard', wizardOpts: { lockProjectId: 1 } });
    });
    render(<SessionStartWizard />);

    // The workflow row resolves (sprint is pre-selected) but the wizard stays on
    // ② Workflow — only an explicit preselect (or a user click) advances to ③.
    await screen.findByTestId('workflow-list-row');
    expect(screen.queryByTestId('wizard-step3')).toBeNull();
    expect(screen.queryByTestId('wizard-cta')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Triage-tray finding seed (D4) — the Insights "Run compounding session" CTA
// opens the wizard preselecting `compound` and carrying the human's selected
// finding ids. The wizard threads those ids into runs.start as `findingIds`,
// but ONLY for a compound launch (the seed is compound-only); every other flow
// omits them. substrate / permission still flow from the step-③ controls, and
// the launchRun closure must read the LIVE ids (no stale capture).
// ---------------------------------------------------------------------------
describe('SessionStartWizard — compound finding seed (D4)', () => {
  it('threads selected findingIds into a compound runs.start launch', async () => {
    // Both the default (sprint) + the compound preselect target are present so
    // the name preselect — not the default — wins and auto-advances to ③.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: {
          lockProjectId: 1,
          preselectWorkflowName: 'compound',
          selectedFindingIds: ['finding-1', 'finding-2', 'finding-3'],
        },
      });
    });
    render(<SessionStartWizard />);

    // The preselect lands the user on ③ Configure with compound selected.
    await screen.findByTestId('wizard-step3');
    expect(screen.getByTestId('wizard-cta')).toHaveTextContent('Run /compound');

    // Launch — compound is not gated, so the CTA fires runs.start directly.
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-compound',
        projectId: 1,
        sessionId: 'session-ensured-001',
        // substrate + permission still flow from the step-③ controls.
        substrate: 'sdk',
        agentProvider: 'claude',
        agentRuntime: 'claude-sdk',
        permissionMode: 'default',
        findingIds: ['finding-1', 'finding-2', 'finding-3'],
      }),
    );
  });

  it('surfaces the selected-findings count in the step-③ launch summary', async () => {
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: {
          lockProjectId: 1,
          preselectWorkflowName: 'compound',
          selectedFindingIds: ['finding-1', 'finding-2'],
        },
      });
    });
    render(<SessionStartWizard />);

    await screen.findByTestId('wizard-step3');
    expect(screen.getByTestId('wizard-launch-summary')).toHaveTextContent('2 selected');
  });

  it('threads an explicit per-run substrate + permission override alongside the seed', async () => {
    // Proves the seed object does not break the step-③ control threading — the
    // overridden substrate/permission ride the same conditional-spread mutate.
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: {
          lockProjectId: 1,
          preselectWorkflowName: 'compound',
          selectedFindingIds: ['finding-1'],
        },
      });
    });
    render(<SessionStartWizard />);

    await screen.findByTestId('wizard-step3');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Permission mode: Auto'));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Select agent runtime'), {
        target: { value: 'claude-interactive' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        substrate: 'interactive',
        agentProvider: 'claude',
        agentRuntime: 'claude-interactive',
        permissionMode: 'auto',
        findingIds: ['finding-1'],
      }),
    );
  });

  it('reads the LIVE findingIds (no stale closure) when the opts change after mount', async () => {
    // Stale-closure guard: launchRun lists selectedFindingIds in its useCallback
    // dep array. If opts change while the wizard stays mounted (re-opened with a
    // different selection), the launch must use the UPDATED ids — without the dep
    // the closure would fire runs.start with the FIRST set. Mutating only
    // selectedFindingIds (same preselectWorkflowName) keeps step ③ + the compound
    // selection latched (loadWorkflows does not re-run on this field).
    mockWorkflowsList.mockResolvedValue([SPRINT_WORKFLOW_ROW, COMPOUND_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: {
          lockProjectId: 1,
          preselectWorkflowName: 'compound',
          selectedFindingIds: ['stale-1'],
        },
      });
    });
    render(<SessionStartWizard />);
    await screen.findByTestId('wizard-step3');

    // Re-open with a DIFFERENT selection (same preselect name → no list reload,
    // step ③ + compound selection latched).
    act(() => {
      useNavigationStore.setState({
        wizardOpts: {
          lockProjectId: 1,
          preselectWorkflowName: 'compound',
          selectedFindingIds: ['fresh-1', 'fresh-2'],
        },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({ findingIds: ['fresh-1', 'fresh-2'] }),
    );
  });

  it('does NOT thread findingIds for a NON-compound flow even when ids are carried', async () => {
    // The seed is compound-only: a non-compound launch must omit findingIds even
    // if the wizard was opened with a selection (defensive — the CTA only ever
    // carries ids alongside a compound preselect, but the gate is meta?.name).
    // Preselect the custom flow by its unambiguous row id so we land on ③ with a
    // non-compound selection.
    mockWorkflowsList.mockResolvedValue([CUSTOM_WORKFLOW_ROW]);
    act(() => {
      useNavigationStore.setState({
        view: 'wizard',
        wizardOpts: {
          lockProjectId: 1,
          preselectWorkflowId: 'wf-1',
          selectedFindingIds: ['finding-1', 'finding-2'],
        },
      });
    });
    render(<SessionStartWizard />);

    await screen.findByTestId('wizard-step3');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });

    expect(mockRunStart).toHaveBeenCalledOnce();
    const callArg = mockRunStart.mock.calls[0]?.[0];
    expect(callArg).toEqual(
      expect.objectContaining({ workflowId: 'wf-1', projectId: 1 }),
    );
    // findingIds is conditionally spread off meta?.name==='compound', so a custom
    // flow must never carry it.
    expect(callArg).not.toHaveProperty('findingIds');
    // The launch summary likewise omits the Findings row for a non-compound flow.
    expect(screen.getByTestId('wizard-launch-summary')).not.toHaveTextContent('selected');
  });
});

// ---------------------------------------------------------------------------
// GLOBAL launch defaults — `config.defaultLaunchModel` / `defaultAgentRuntime`,
// the resolver's MIDDLE rung, seeded into every card's Configure controls. ONE
// global runtime, coerced per card: quick/ultracode take the whole session set,
// a workflow card drops what a flow run cannot launch, and design is never
// moved (it is hard-pinned to the Claude SDK substrate).
// ---------------------------------------------------------------------------
describe('SessionStartWizard — global launch defaults (defaultLaunchModel / defaultAgentRuntime)', () => {
  beforeEach(() => {
    // A non-gated custom flow, so the workflow card launches DIRECTLY.
    mockWorkflowsList.mockResolvedValue([CUSTOM_WORKFLOW_ROW]);
  });

  /** Install ONLY the globals a case needs (nothing stored per-run-type). */
  function setGlobals(globals: Partial<AppConfig>): void {
    act(() => {
      useConfigStore.setState({ config: globals as AppConfig });
    });
  }

  it('seeds BOTH cards from the global defaultLaunchModel and launches with it', async () => {
    setGlobals({ defaultLaunchModel: 'sonnet' });
    await renderLockedWizard();

    await selectQuickAndConfigure();
    await waitFor(() => expect(claudeModelValue()).toBe('sonnet'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ claudeConfig: expect.objectContaining({ model: 'sonnet' }) }),
    );

    await backToWorkflow();
    await selectWorkflowAndConfigure();
    await waitFor(() => expect(claudeModelValue()).toBe('sonnet'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ model: 'sonnet' }));
  });

  it('a stored per-run-type model still BEATS the global default', async () => {
    setGlobals({
      defaultLaunchModel: 'sonnet',
      runTypeDefaults: { 'workflow:wf-1': { model: 'haiku' } },
    });
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await waitFor(() => expect(claudeModelValue()).toBe('haiku'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockRunStart).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }));
  });

  // The rung-ordering guard: the global runtime OWNS its transport, so it beats
  // the quick substrate preference (set to the OPPOSITE value here) and the two
  // fields are asserted as a PAIR.
  it('seeds the quick card from the global runtime, substrate and all', async () => {
    setGlobals({
      defaultAgentRuntime: 'claude-interactive',
      quickSessionDefaultSubstrate: 'sdk',
    });
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await waitFor(() => expect(runtimeValue()).toBe('claude-interactive'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRuntime: 'claude-interactive',
        substrate: 'interactive',
        agentProvider: 'claude',
      }),
    );
  });

  it('the quick card ACCEPTS a quick-only global runtime (codex-pty)', async () => {
    setGlobals({ defaultAgentRuntime: 'codex-pty' });
    await renderLockedWizard();
    await selectQuickAndConfigure();

    await waitFor(() => expect(runtimeValue()).toBe('codex-pty'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntime: 'codex-pty', agentProvider: 'codex' }),
    );
  });

  // …and the SAME global, on a workflow card, is dropped rather than blocking
  // the CTA with "Codex PTY is only available for quick sessions."
  it('the workflow card DROPS the quick-only global runtime and still launches on the floor', async () => {
    setGlobals({ defaultAgentRuntime: 'codex-pty' });
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    expect(runtimeValue()).toBe('claude-sdk');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRuntime: 'claude-sdk',
        substrate: 'sdk',
        agentProvider: 'claude',
      }),
    );
  });

  it('a workflow-capable global runtime rides a workflow launch, substrate and all', async () => {
    setGlobals({ defaultAgentRuntime: 'claude-interactive' });
    await renderLockedWizard();
    await selectWorkflowAndConfigure();

    await waitFor(() => expect(runtimeValue()).toBe('claude-interactive'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntime: 'claude-interactive', substrate: 'interactive' }),
    );
  });

  // Design is a security boundary (design-mode.md "Session plumbing"): the MCP
  // scope mechanism that limits a design session's toolset exists only on the
  // SDK path, so NO global may move it off claude-sdk.
  it('the design card ignores the global runtime entirely (stays hard-pinned to the Claude SDK)', async () => {
    setGlobals({ defaultAgentRuntime: 'codex-pty' });
    await renderLockedWizard();
    await selectDesignAndConfigure();

    // The runtime picker is hidden for design, so the LAUNCH is the assertion:
    // through the idea gate, then the createQuick payload.
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-idea-pick'));
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        substrate: 'sdk',
        agentProvider: 'claude',
        agentRuntime: 'claude-sdk',
        designIdeaId: 'IDEA-7',
      }),
    );
  });

  // AC5 — with NEITHER global set the payloads are byte-identical.
  it('REGRESSION: with NEITHER global set both launch payloads are unchanged', async () => {
    setGlobals({ defaultLaunchModel: undefined, defaultAgentRuntime: undefined });
    await renderLockedWizard();

    await selectQuickAndConfigure();
    expect(runtimeValue()).toBe('claude-interactive');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockCreateQuick).toHaveBeenCalledWith({
      prompt: '',
      projectId: 1,
      agentPermissionMode: 'default',
      substrate: 'interactive',
      agentProvider: 'claude',
      agentRuntime: 'claude-interactive',
      claudeConfig: { model: 'opus', fastMode: false },
    });

    await backToWorkflow();
    await selectWorkflowAndConfigure();
    expect(runtimeValue()).toBe('claude-sdk');
    await act(async () => {
      fireEvent.click(screen.getByTestId('wizard-cta'));
    });
    expect(mockRunStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        projectId: 1,
        substrate: 'sdk',
        agentProvider: 'claude',
        agentRuntime: 'claude-sdk',
        permissionMode: 'default',
        model: 'opus',
      }),
    );
  });
});
