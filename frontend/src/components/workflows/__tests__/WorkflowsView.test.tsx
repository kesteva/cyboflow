/**
 * WorkflowsView / GalleryStacked render tests.
 *
 * The workflows store is mocked (mirrors InsightsView.test) so we render against
 * a fixed snapshot without a live tRPC connection. CreateProjectDialog is
 * stubbed to an inert marker so the no-projects CTA renders without the real
 * dialog's project-load effects.
 *
 * Behaviors verified:
 *   1. Renders both gallery sections with count pills sourced from the store
 *      (EXCLUDING the dashed New card).
 *   2. Shows the first-load skeleton when loading && !initialized.
 *   3. Surfaces a NON-FATAL error banner (with a Retry control) while still
 *      rendering the gallery.
 *   4. AgentCard shows the read-only "inherits run model" chip and renders NO
 *      model-picker control.
 *   5. The Agents section feature-gates to an empty-state when no agents.
 *   6. The no-projects probe drives the create-project CTA.
 *   7. The Plugins section folds a plugin's per-project install records into
 *      one card, with an install count + user-scope hint on the fan-out.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '../../../types/project';
import type { WorkflowDefinition } from '../../../../../shared/types/workflows';
import type {
  WorkflowGalleryEntry,
  AgentGalleryEntry,
} from '../../../stores/workflowsStore';
import type { McpEntry, PluginEntry } from '../../../../../shared/types/integrations';
import { wfMeta } from '../wfMeta';
import type { WorkflowEditorModalProps } from '../../cyboflow/WorkflowEditorModal';

// ---------------------------------------------------------------------------
// Mutable store snapshot shared with the mock factory.
// ---------------------------------------------------------------------------

let mockInitialized = true;
let mockLoading = false;
let mockError: string | null = null;
let mockProjectFilter: number | null = null;
let mockShowArchived = false;
let mockWorkflows: WorkflowGalleryEntry[] = [];
let mockAgents: AgentGalleryEntry[] = [];
let mockMcps: McpEntry[] = [];
let mockPlugins: PluginEntry[] = [];

const mockInit = vi.fn(async () => {});
const mockRefresh = vi.fn(async () => {});
const mockSetProjectFilter = vi.fn(async () => {});
const mockToggleShowArchived = vi.fn(async () => {});

function snapshot() {
  return {
    initialized: mockInitialized,
    loading: mockLoading,
    error: mockError,
    projectFilter: mockProjectFilter,
    showArchived: mockShowArchived,
    workflows: mockWorkflows,
    agents: mockAgents,
    mcps: mockMcps,
    plugins: mockPlugins,
    init: mockInit,
    refresh: mockRefresh,
    setProjectFilter: mockSetProjectFilter,
    toggleShowArchived: mockToggleShowArchived,
  };
}

vi.mock('../../../stores/workflowsStore', async (importOriginal) => {
  // Keep the real pure helpers/types; only replace the hook.
  const actual = await importOriginal<typeof import('../../../stores/workflowsStore')>();
  const useWorkflowsStore = (selector: (s: ReturnType<typeof snapshot>) => unknown) =>
    selector(snapshot());
  useWorkflowsStore.getState = () => snapshot();
  return { ...actual, useWorkflowsStore };
});

// ---------------------------------------------------------------------------
// API mock — drives the project-count probe + the filter's project load.
// ---------------------------------------------------------------------------

let mockGetAll: () => Promise<{ success: boolean; data?: Project[]; error?: string }> = async () => ({
  success: true,
  data: [{ id: 1, name: 'Acme', path: '/tmp/acme', active: true, created_at: '', updated_at: '' }],
});

vi.mock('../../../utils/api', () => ({
  API: {
    projects: {
      getAll: () => mockGetAll(),
    },
  },
}));

// Inert CreateProjectDialog so the no-projects CTA renders without real effects.
vi.mock('../../CreateProjectDialog', () => ({
  CreateProjectDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="create-project-dialog" /> : null,
}));

// ---------------------------------------------------------------------------
// Mocks for the P4 card-action wiring (nav, tRPC, the hosted modals).
// ---------------------------------------------------------------------------

const mockGoToWizard = vi.fn();
vi.mock('../../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ goToWizard: mockGoToWizard }) },
}));

const mockCreateCustom = vi.fn(async (_args: unknown) => ({ id: 'wf-copy' }));
const mockDelete = vi.fn(async (_args: unknown) => ({ ok: true as const }));
const mockArchive = vi.fn(async (_args: unknown) => ({ ok: true as const }));
const mockUnarchive = vi.fn(async (_args: unknown) => ({ ok: true as const }));
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      workflows: {
        createCustom: { mutate: (args: unknown) => mockCreateCustom(args) },
        delete: { mutate: (args: unknown) => mockDelete(args) },
        archive: { mutate: (args: unknown) => mockArchive(args) },
        unarchive: { mutate: (args: unknown) => mockUnarchive(args) },
      },
    },
  },
}));

// Inert modals — only render markers when open; never touch tRPC at mount.
// The WorkflowEditorModal mock ALSO captures the props WorkflowsView passes it
// (TASK-220: `onSaved`'s second arg is the "where did it land" scope note) so
// tests can invoke callbacks directly without driving the real editor's UI.
let mockEditorProps: WorkflowEditorModalProps | null = null;
vi.mock('../../cyboflow/WorkflowEditorModal', () => ({
  WorkflowEditorModal: (props: WorkflowEditorModalProps) => {
    mockEditorProps = props;
    return props.isOpen ? <div data-testid="wf-editor-modal" /> : null;
  },
}));
vi.mock('../../cyboflow/agents/AgentEditorModal', () => ({
  AgentEditorModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="agent-editor-modal" /> : null,
}));
vi.mock('../GalleryNew', () => ({
  GalleryNew: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="gallery-new-modal" /> : null,
}));

import { WorkflowsView } from '../WorkflowsView';
import { GalleryStacked } from '../GalleryStacked';
import { AgentCard } from '../AgentCard';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildDefinition(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'planner',
    phases: [
      {
        id: 'plan',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [
          { id: 's1', name: 'Draft', agent: 'planner', mcps: [], retries: 0 },
          { id: 's2', name: 'Gate', agent: 'human', mcps: [], retries: 0, human: true },
        ],
      },
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [{ id: 's3', name: 'Build', agent: 'executor', mcps: [], retries: 1 }],
      },
    ],
    ...over,
  };
}

function buildWorkflowEntry(over: Partial<WorkflowGalleryEntry> = {}): WorkflowGalleryEntry {
  const definition = over.definition ?? buildDefinition();
  return {
    row: {
      id: 'wf-planner',
      project_id: 1,
      name: 'Planner',
      workflow_path: null,
      permission_mode: 'default',
      spec_json: '{}',
      tuning_level: 'standard',
      runtime_mix: 'claude',
      created_at: '2026-06-10T00:00:00.000Z',
      archived_at: null,
    },
    definition,
    meta: wfMeta(definition),
    lastUsedAt: null,
    projectName: 'Acme',
    ...over,
  };
}

function buildAgentEntry(over: Partial<AgentGalleryEntry> = {}): AgentGalleryEntry {
  return {
    id: 'executor',
    name: 'Executor',
    role: 'execute',
    description: 'Implements the planned changes.',
    tools: ['Read', 'Edit', 'Bash'],
    isCustom: false,
    isOverride: false,
    tokensEstimate: null,
    model: 'inherits run model',
    ...over,
  };
}

function buildMcpEntry(over: Partial<McpEntry> = {}): McpEntry {
  return {
    name: 'peekaboo',
    transport: 'stdio',
    url: null,
    command: 'npx',
    args: [],
    scope: 'global',
    ...over,
  };
}

function buildPluginEntry(over: Partial<PluginEntry> = {}): PluginEntry {
  return {
    id: 'frontend-design@claude-plugins-official',
    name: 'frontend-design',
    marketplace: 'claude-plugins-official',
    scope: 'user',
    version: 'unknown',
    enabled: true,
    lastUpdated: null,
    projectPath: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEditorProps = null;
  mockInitialized = true;
  mockLoading = false;
  mockError = null;
  mockProjectFilter = null;
  mockShowArchived = false;
  mockWorkflows = [buildWorkflowEntry()];
  mockAgents = [buildAgentEntry()];
  mockMcps = [];
  mockPlugins = [];
  mockGetAll = async () => ({
    success: true,
    data: [{ id: 1, name: 'Acme', path: '/tmp/acme', active: true, created_at: '', updated_at: '' }],
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowsView', () => {
  it('calls the store init() once on mount', async () => {
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it('renders both sections with count pills from the store (excluding the New card)', async () => {
    mockWorkflows = [buildWorkflowEntry(), buildWorkflowEntry({ row: { ...buildWorkflowEntry().row, id: 'wf-2', name: 'Sprint' } })];
    mockAgents = [buildAgentEntry(), buildAgentEntry({ id: 'verifier', name: 'Verifier' })];
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());
    // Pills equal the real entry counts, NOT counting the dashed New card.
    expect(screen.getByTestId('gallery-section-workflows-count')).toHaveTextContent('2');
    expect(screen.getByTestId('gallery-section-agents-count')).toHaveTextContent('2');
    // The New cards are present (so the pill genuinely excludes them).
    expect(screen.getByTestId('new-workflow-card')).toBeInTheDocument();
    expect(screen.getByTestId('new-agent-card')).toBeInTheDocument();
  });

  it('shows the first-load skeleton when loading && !initialized', async () => {
    mockInitialized = false;
    mockLoading = true;
    render(<WorkflowsView />);
    expect(screen.getByTestId('workflows-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('gallery-stacked')).not.toBeInTheDocument();
    // Let the async project-count probe settle so its state update is flushed
    // inside act() (the skeleton persists because loading && !initialized holds).
    await waitFor(() => expect(screen.getByTestId('workflows-loading')).toBeInTheDocument());
  });

  it('surfaces a non-fatal error banner with a Retry control while rendering the gallery', async () => {
    mockError = 'network down';
    render(<WorkflowsView />);
    const banner = await screen.findByTestId('workflows-error');
    expect(banner).toHaveTextContent(/network down/);
    expect(screen.getByTestId('workflows-retry')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument();
  });

  it('drives the create-project CTA when no projects exist', async () => {
    mockGetAll = async () => ({ success: true, data: [] });
    render(<WorkflowsView />);
    expect(await screen.findByTestId('workflows-no-projects')).toBeInTheDocument();
    expect(screen.queryByTestId('gallery-stacked')).not.toBeInTheDocument();
  });
});

describe('GalleryStacked', () => {
  it('feature-gates the Agents section to an empty-state when no agents', () => {
    render(
      <GalleryStacked
        workflows={[buildWorkflowEntry()]}
        agents={[]}
        mcps={[]}
        plugins={[]}
        showProjectChip={false}
        agentsUnavailable={true}
      />,
    );
    expect(screen.getByTestId('gallery-agents-empty')).toBeInTheDocument();
    // Pill reads 0 and no agent card renders, but the New-agent card stays.
    expect(screen.getByTestId('gallery-section-agents-count')).toHaveTextContent('0');
    expect(screen.getByTestId('new-agent-card')).toBeInTheDocument();
  });

  it('shows the owning-project chip only in the all-projects view', () => {
    const { rerender } = render(
      <GalleryStacked workflows={[buildWorkflowEntry()]} agents={[]} mcps={[]} plugins={[]} showProjectChip={true} agentsUnavailable={true} />,
    );
    expect(screen.getByTestId('workflow-card-project-chip')).toHaveTextContent('Acme');
    rerender(
      <GalleryStacked workflows={[buildWorkflowEntry()]} agents={[]} mcps={[]} plugins={[]} showProjectChip={false} agentsUnavailable={true} />,
    );
    expect(screen.queryByTestId('workflow-card-project-chip')).not.toBeInTheDocument();
  });

  it('renders read-only MCPs + Plugins sections with count pills and cards', () => {
    render(
      <GalleryStacked
        workflows={[buildWorkflowEntry()]}
        agents={[]}
        mcps={[buildMcpEntry(), buildMcpEntry({ name: 'fal-ai', transport: 'http', url: 'https://mcp.fal.ai/mcp', command: null })]}
        plugins={[buildPluginEntry()]}
        showProjectChip={false}
        agentsUnavailable={true}
      />,
    );
    expect(screen.getByTestId('gallery-section-mcps')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-section-mcps-count')).toHaveTextContent('2');
    expect(screen.getByTestId('mcp-card-peekaboo')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-card-fal-ai')).toBeInTheDocument();

    expect(screen.getByTestId('gallery-section-plugins')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-section-plugins-count')).toHaveTextContent('1');
    expect(screen.getByTestId('plugin-card-frontend-design')).toBeInTheDocument();
    // Read-only — no Edit/New affordance in either section.
    expect(screen.queryByTestId('mcp-card-edit-peekaboo')).not.toBeInTheDocument();
  });

  it('folds a plugin\'s per-worktree install records into ONE card with a scope hint', () => {
    // Mirrors the real catalogue: one id installed at local scope in each
    // worktree of a repo, which previously rendered one identical card each.
    const worktreeInstalls = ['a', 'b', 'c', 'd'].map((wt) =>
      buildPluginEntry({
        id: 'soloflow-dev@soloflow',
        name: 'soloflow-dev',
        marketplace: 'soloflow',
        scope: 'local',
        version: '0.11.0',
        projectPath: `/repo/worktrees/${wt}`,
      }),
    );
    render(
      <GalleryStacked
        workflows={[buildWorkflowEntry()]}
        agents={[]}
        mcps={[]}
        plugins={[buildPluginEntry(), ...worktreeInstalls]}
        showProjectChip={false}
        agentsUnavailable={true}
      />,
    );
    // Two ids -> two cards, not five.
    expect(screen.getByTestId('gallery-section-plugins-count')).toHaveTextContent('2');
    expect(screen.getAllByTestId('plugin-card-soloflow-dev')).toHaveLength(1);
    expect(screen.getByTestId('plugin-card-soloflow-dev-installs')).toHaveTextContent('4');
    expect(screen.getByTestId('plugin-card-soloflow-dev-scope-hint')).toHaveTextContent(
      /4 project installs/,
    );
  });

  it('shows no install count or scope hint for a single user-scope install', () => {
    render(
      <GalleryStacked
        workflows={[buildWorkflowEntry()]}
        agents={[]}
        mcps={[]}
        plugins={[buildPluginEntry()]}
        showProjectChip={false}
        agentsUnavailable={true}
      />,
    );
    expect(screen.queryByTestId('plugin-card-frontend-design-installs')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('plugin-card-frontend-design-scope-hint'),
    ).not.toBeInTheDocument();
  });

  it('shows empty-states for the MCPs + Plugins sections when both are empty', () => {
    render(
      <GalleryStacked
        workflows={[buildWorkflowEntry()]}
        agents={[]}
        mcps={[]}
        plugins={[]}
        showProjectChip={false}
        agentsUnavailable={true}
      />,
    );
    expect(screen.getByTestId('gallery-mcps-empty')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-plugins-empty')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-section-mcps-count')).toHaveTextContent('0');
    expect(screen.getByTestId('gallery-section-plugins-count')).toHaveTextContent('0');
  });
});

describe('AgentCard', () => {
  it('renders the bare agent key, not the cyboflow- prefixed name', () => {
    // The store carries a prefixed `name` (e.g. cyboflow-context) but the card
    // shows the bare key (entry.id) — the prefix is dispatch-only noise here.
    render(<AgentCard entry={buildAgentEntry({ id: 'context', name: 'cyboflow-context' })} />);
    const title = screen.getByTestId('agent-card-context');
    expect(title).toHaveTextContent('context');
    expect(title).not.toHaveTextContent('cyboflow-context');
  });

  it('shows the read-only "inherits run model" chip and no model picker', () => {
    render(<AgentCard entry={buildAgentEntry()} />);
    expect(screen.getByTestId('agent-card-model-chip')).toHaveTextContent('inherits run model');
    // No interactive model-selection control exists on the card.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows tools count as "N of 8" and omits tokens when the estimate is null', () => {
    render(<AgentCard entry={buildAgentEntry({ tools: ['Read', 'Edit', 'Bash'], tokensEstimate: null })} />);
    expect(screen.getByText(/of/)).toBeInTheDocument();
    expect(screen.queryByTestId('agent-card-tokens')).not.toBeInTheDocument();
  });

  it('renders the token estimate when present', () => {
    render(<AgentCard entry={buildAgentEntry({ tokensEstimate: 12500 })} />);
    expect(screen.getByTestId('agent-card-tokens')).toBeInTheDocument();
  });
});

describe('WorkflowsView card-action wiring (P4)', () => {
  it('Run preselects the wizard BY ROW ID, locked to the card project', async () => {
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('workflow-card-run-wf-planner'));
    expect(mockGoToWizard).toHaveBeenCalledTimes(1);
    expect(mockGoToWizard).toHaveBeenCalledWith({ lockProjectId: 1, preselectWorkflowId: 'wf-planner' });
  });

  it('Duplicate calls createCustom with a -copy name then refreshes the store', async () => {
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('workflow-card-duplicate-wf-planner'));
    await waitFor(() => expect(mockCreateCustom).toHaveBeenCalledTimes(1));
    expect(mockCreateCustom).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, name: 'Planner-copy', permissionMode: 'default' }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('Duplicate is guarded by a synchronous in-flight latch (two rapid clicks create once)', async () => {
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());
    const btn = screen.getByTestId('workflow-card-duplicate-wf-planner');
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(mockCreateCustom).toHaveBeenCalledTimes(1));
  });
});

describe('WorkflowsView delete-workflow wiring', () => {
  it('Delete opens a confirm dialog; confirming calls workflows.delete then refreshes and closes', async () => {
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());

    // The default fixture card ('Planner', non-built-in name) offers Delete.
    fireEvent.click(screen.getByTestId('workflow-card-delete-wf-planner'));
    expect(screen.getByTestId('workflow-delete-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('workflow-delete-confirm'));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith({ workflowId: 'wf-planner' }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    // The dialog closes on success.
    await waitFor(() =>
      expect(screen.queryByTestId('workflow-delete-dialog')).not.toBeInTheDocument(),
    );
  });

  it('surfaces a delete failure inline and keeps the dialog open (no refresh)', async () => {
    mockDelete.mockRejectedValueOnce(
      new Error('workflow wf-planner has run history (2 run(s)); refusing to delete'),
    );
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('workflow-card-delete-wf-planner'));
    fireEvent.click(screen.getByTestId('workflow-delete-confirm'));

    const err = await screen.findByTestId('workflow-delete-error');
    expect(err).toHaveTextContent('run history');
    // Dialog stays open and the store is NOT refreshed on failure.
    expect(screen.getByTestId('workflow-delete-dialog')).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('Cancel closes the dialog without calling delete', async () => {
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('workflow-card-delete-wf-planner'));
    fireEvent.click(screen.getByTestId('workflow-delete-cancel'));
    expect(screen.queryByTestId('workflow-delete-dialog')).not.toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('WorkflowsView archive/unarchive wiring', () => {
  it('Archive fires directly (no dialog) and calls workflows.archive then refreshes', async () => {
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('workflow-card-archive-wf-planner'));
    await waitFor(() => expect(mockArchive).toHaveBeenCalledWith({ workflowId: 'wf-planner' }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    // No confirm dialog was ever shown for Archive.
    expect(screen.queryByTestId('workflow-delete-dialog')).not.toBeInTheDocument();
  });

  it('Unarchive fires directly and calls workflows.unarchive then refreshes', async () => {
    mockWorkflows = [
      buildWorkflowEntry({
        row: { ...buildWorkflowEntry().row, archived_at: '2026-06-12T00:00:00.000Z' },
      }),
    ];
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('workflow-card-unarchive-wf-planner'));
    await waitFor(() => expect(mockUnarchive).toHaveBeenCalledWith({ workflowId: 'wf-planner' }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  });

  it('an Archive failure surfaces via the error store instead of failing silently (rvw_67cf8ae9)', async () => {
    const { useErrorStore } = await import('../../../stores/errorStore');
    useErrorStore.getState().clearError();
    mockArchive.mockRejectedValueOnce(new Error('network hiccup'));
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('workflow-card-archive-wf-planner'));
    await waitFor(() =>
      expect(useErrorStore.getState().currentError).toMatchObject({
        title: 'Archive failed',
        error: 'network hiccup',
      }),
    );
    // Archive is best-effort — the store is NOT refreshed on failure.
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('an Unarchive failure surfaces via the error store instead of failing silently (rvw_67cf8ae9)', async () => {
    mockWorkflows = [
      buildWorkflowEntry({
        row: { ...buildWorkflowEntry().row, archived_at: '2026-06-12T00:00:00.000Z' },
      }),
    ];
    const { useErrorStore } = await import('../../../stores/errorStore');
    useErrorStore.getState().clearError();
    mockUnarchive.mockRejectedValueOnce(new Error('network hiccup'));
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('workflow-card-unarchive-wf-planner'));
    await waitFor(() =>
      expect(useErrorStore.getState().currentError).toMatchObject({
        title: 'Unarchive failed',
        error: 'network hiccup',
      }),
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('the "Show archived" toggle reflects showArchived and calls toggleShowArchived on click', async () => {
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());

    const toggle = screen.getByTestId('workflows-show-archived-toggle');
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(mockToggleShowArchived).toHaveBeenCalledTimes(1);
  });
});

describe('WorkflowsView — "save as new flow" landing toast (TASK-220)', () => {
  /** Open the editor for the default 'Planner' card and grab its captured props. */
  async function openEditor(): Promise<WorkflowEditorModalProps> {
    render(<WorkflowsView />);
    await waitFor(() => expect(screen.getByTestId('gallery-stacked')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('workflow-card-edit-wf-planner'));
    await waitFor(() => expect(screen.getByTestId('wf-editor-modal')).toBeInTheDocument());
    if (mockEditorProps === null) throw new Error('WorkflowEditorModal did not receive props');
    return mockEditorProps;
  }

  it('surfaces a scope-naming toast when onSaved carries a "save as new" note, and closes the editor', async () => {
    const editorProps = await openEditor();

    act(() => {
      editorProps.onSaved?.('wf-new-id', 'Saved “Speedboat” as a new flow (Global).');
    });

    // The editor modal closes (wfEditor reset)...
    await waitFor(() => expect(screen.queryByTestId('wf-editor-modal')).not.toBeInTheDocument());
    // ...and the toast names exactly where the new flow landed.
    const toast = await screen.findByTestId('session-action-toast');
    expect(toast).toHaveTextContent('Saved “Speedboat” as a new flow (Global).');
    // The gallery still refreshes on every save.
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('shows no toast for a save with no scope note (overwrite / reset / project-copy fork)', async () => {
    const editorProps = await openEditor();

    act(() => {
      editorProps.onSaved?.('wf-planner');
    });

    await waitFor(() => expect(screen.queryByTestId('wf-editor-modal')).not.toBeInTheDocument());
    expect(screen.queryByTestId('session-action-toast')).not.toBeInTheDocument();
    expect(mockRefresh).toHaveBeenCalled();
  });
});
