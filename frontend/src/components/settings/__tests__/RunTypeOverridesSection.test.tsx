/**
 * RunTypeOverridesSection — the per-run-type override list + detail screen that
 * hangs below "Global defaults" in Settings → AI → Session settings.
 *
 * These tests run against the REAL `configStore` over an in-memory fake of the
 * `config:*` IPC surface whose `applyRunTypeDefault` reimplements ConfigManager's
 * merge/replace rules (which are themselves pinned by
 * `main/src/services/__tests__/configManagerRunTypeDefaults.test.ts`). That is
 * what lets the merge-to-empty contract be exercised END TO END — component →
 * store → IPC → refetch → re-render — instead of stopping at a spy.
 *
 * The workflow inventory is faked at the `trpc.cyboflow.workflows.list` +
 * `API.projects.getAll` layer (mirroring `TrackerIntegrationSection.test.tsx`),
 * NOT via `workflowsStore` — the component under test deliberately never
 * touches that shared, filterable store (COR-3). `data-workflows-loaded` on the
 * section is the deterministic "the async fan-out settled" signal every helper
 * below waits on, since the synthetic quick row renders regardless of fetch
 * state and so cannot be used to detect settlement.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { AppConfig } from '../../../types/config';
import type { Project } from '../../../types/project';
import type { WorkflowRow } from '../../../../../shared/types/workflows';
import type {
  RunTypeDefaults,
  RunTypeDefaultsOp,
} from '../../../../../shared/types/sessionDefaults';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function wfRow(over: Partial<WorkflowRow> & Pick<WorkflowRow, 'id' | 'name'>): WorkflowRow {
  return {
    project_id: null,
    workflow_path: null,
    permission_mode: 'default',
    spec_json: '{}',
    created_at: '2026-01-01T00:00:00Z',
    archived_at: null,
    ...over,
  };
}

interface WorkflowFixtureEntry {
  row: WorkflowRow;
  projectName: string;
}

const WORKFLOW_ENTRIES: WorkflowFixtureEntry[] = [
  { row: wfRow({ id: 'wf-global-sprint', name: 'sprint' }), projectName: '' },
  { row: wfRow({ id: 'wf-global-planner', name: 'planner' }), projectName: '' },
  { row: wfRow({ id: 'wf-global-custom-aa', name: 'triage' }), projectName: '' },
  { row: wfRow({ id: 'wf-3-custom-bb', name: 'nightly', project_id: 3 }), projectName: 'Cyboflow' },
];

/** Every project the cross-project fan-out enumerates (COR-3: ALL of them,
 * always — see the module doc of the component under test). */
const PROJECTS: Project[] = [
  {
    id: 1,
    name: 'Default',
    path: '/repo',
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 3,
    name: 'Cyboflow',
    path: '/repo3',
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

/** What `workflows.list({ projectId })` would real-mindedly return: global rows
 * (project_id null) PLUS whatever is scoped to that exact project. */
function workflowsForProject(entries: WorkflowFixtureEntry[], projectId: number): WorkflowRow[] {
  return entries
    .filter((e) => e.row.project_id === null || e.row.project_id === projectId)
    .map((e) => e.row);
}

// ---------------------------------------------------------------------------
// Module mocks — cross-project fetch (trpc + API.projects), and the in-memory
// `config:*` IPC fake (real configStore, fake transport).
// ---------------------------------------------------------------------------

/**
 * The OMP flavor probe the runtime picker reads (`useOmpAvailability`). Hoisted
 * so the `vi.mock` factory can close over it and a test can swap the answer;
 * `beforeEach` resets it to the local-OMP flavor (Aria off), which is what a
 * default install reports.
 */
const { ompAvailabilityMock } = vi.hoisted(() => ({ ompAvailabilityMock: vi.fn() }));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      workflows: {
        list: { query: vi.fn() },
      },
      omp: {
        availability: { query: () => ompAvailabilityMock() },
      },
    },
  },
}));

const configUpdate = vi.fn();
const applyRunTypeDefaultSpy = vi.fn();

let liveConfig: AppConfig;
/** Set by a test to make the NEXT `applyRunTypeDefault` call report failure. */
let forcedApplyError: string | null = null;

/** Mirrors ConfigManager.applyRunTypeDefault: null deletes a member; an empty key is dropped. */
function applyOp(key: string, op: RunTypeDefaultsOp): RunTypeDefaults | undefined {
  const all: Record<string, RunTypeDefaults> = { ...liveConfig.runTypeDefaults };
  const previous = all[key];

  if (op.kind === 'replace') {
    if (op.value === null || Object.keys(op.value).length === 0) delete all[key];
    else all[key] = { ...op.value };
  } else {
    const merged: RunTypeDefaults = { ...previous };
    for (const [field, value] of Object.entries(op.value) as [keyof RunTypeDefaults, unknown][]) {
      if (value === null) delete merged[field];
      else if (value !== undefined) {
        Object.assign(merged, { [field]: value });
      }
    }
    if (Object.keys(merged).length === 0) delete all[key];
    else all[key] = merged;
  }

  liveConfig = {
    ...liveConfig,
    runTypeDefaults: Object.keys(all).length > 0 ? all : undefined,
  };
  return previous;
}

/**
 * The Codex model catalog the detail screen's model picker reads once the
 * draft's effective runtime is Codex. Faked at the store (the pattern
 * `VariantEditorModal.codex.test.tsx` uses) so the option set is deterministic
 * — the real store fetches `model/list` off the bundled runtime.
 */
const CODEX_MODEL_OPTIONS = [
  { id: 'auto', label: 'Auto/default', description: 'Use the Codex runtime default', isDefault: false },
  { id: 'gpt-5-codex', label: 'GPT-5 Codex', description: 'Codex-tuned', isDefault: true },
  { id: 'gpt-5', label: 'GPT-5', description: 'General purpose', isDefault: false },
];

vi.mock('../../../stores/codexModelCatalogStore', () => ({
  useCodexModelCatalog: () => ({
    options: CODEX_MODEL_OPTIONS,
    defaultModel: 'gpt-5-codex',
    loading: false,
    error: null,
  }),
}));

const OMP_MODEL_OPTIONS = [
  { id: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', ompProvider: 'anthropic' },
  { id: 'openrouter/meta-llama-4', label: 'Llama 4', ompProvider: 'openrouter' },
];

vi.mock('../../../stores/ompModelCatalogStore', () => ({
  useOmpModelCatalog: () => ({ options: OMP_MODEL_OPTIONS, loading: false, error: null }),
}));

vi.mock('../../../utils/api', () => ({
  API: {
    projects: { getAll: vi.fn() },
    config: {
      get: () => Promise.resolve({ success: true, data: liveConfig }),
      update: (...a: unknown[]) => {
        configUpdate(...a);
        return Promise.resolve({ success: true });
      },
      applyRunTypeDefault: (key: string, op: RunTypeDefaultsOp) => {
        applyRunTypeDefaultSpy(key, op);
        if (forcedApplyError !== null) {
          return Promise.resolve({ success: false, error: forcedApplyError });
        }
        const previous = applyOp(key, op);
        return Promise.resolve({ success: true, data: { previous, config: liveConfig } });
      },
    },
  },
}));

// Imported after the mocks so vi.mock hoisting is in effect.
import { RunTypeOverridesSection } from '../RunTypeOverridesSection';
import { useConfigStore } from '../../../stores/configStore';
import { useWorkflowsStore } from '../../../stores/workflowsStore';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';

const workflowsListQuery = vi.mocked(trpc.cyboflow.workflows.list.query);
const projectsGetAll = vi.mocked(API.projects.getAll);

function setWorkflowFixture(entries: WorkflowFixtureEntry[]): void {
  projectsGetAll.mockResolvedValue({ success: true, data: PROJECTS });
  workflowsListQuery.mockImplementation(({ projectId }: { projectId: number }) =>
    Promise.resolve(workflowsForProject(entries, projectId)),
  );
}

/** The deterministic "the async fan-out settled" signal — see the module doc. */
async function waitForWorkflowsSettled(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId('run-type-overrides')).toHaveAttribute('data-workflows-loaded', 'true'),
  );
}

async function renderList(
  over: Partial<AppConfig> = {},
  entries: WorkflowFixtureEntry[] = WORKFLOW_ENTRIES,
): Promise<void> {
  setWorkflowFixture(entries);
  liveConfig = { gitRepoPath: '/repo', ...over };
  await useConfigStore.getState().fetchConfig();
  render(<RunTypeOverridesSection />);
  await waitForWorkflowsSettled();
}

/**
 * Same, but mounted inside a <form> that stands in for `Settings.tsx`'s shared
 * save form. Returns its submit handler so every write path can assert it never
 * fires — the section must own its own write channel end to end.
 */
async function renderInParentForm(over: Partial<AppConfig> = {}): Promise<Mock> {
  const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
  setWorkflowFixture(WORKFLOW_ENTRIES);
  liveConfig = { gitRepoPath: '/repo', ...over };
  await useConfigStore.getState().fetchConfig();
  render(
    <form onSubmit={onSubmit}>
      <RunTypeOverridesSection />
    </form>,
  );
  await waitForWorkflowsSettled();
  return onSubmit;
}

beforeEach(() => {
  configUpdate.mockReset();
  applyRunTypeDefaultSpy.mockReset();
  workflowsListQuery.mockReset();
  projectsGetAll.mockReset();
  forcedApplyError = null;
  // Default install: OMP runs locally, no remote fleet.
  ompAvailabilityMock.mockReset();
  ompAvailabilityMock.mockResolvedValue({ launchable: false, ariaMode: false });
  useConfigStore.setState({ config: null, error: null, isLoading: false });
  useWorkflowsStore.setState({ projectFilter: null, workflows: [] });
});

// ---------------------------------------------------------------------------

describe('RunTypeOverridesSection — grouped list', () => {
  it('groups built-in flows, quick sessions, and custom flows (project-scoped under the project name)', async () => {
    await renderList();

    expect(screen.getByText('Built-in flows')).toBeInTheDocument();
    expect(screen.getByText('Quick sessions')).toBeInTheDocument();
    expect(screen.getByText('Custom flows')).toBeInTheDocument();
    expect(screen.getByText('Custom flows · Cyboflow')).toBeInTheDocument();

    // Built-ins keep their wizard titles; the synthetic quick row is always present.
    expect(screen.getByTestId('run-type-row-workflow:wf-global-sprint')).toHaveTextContent('Sprint');
    expect(screen.getByTestId('run-type-row-workflow:wf-global-planner')).toHaveTextContent('Planner');
    expect(screen.getByTestId('run-type-row-quick')).toHaveTextContent('Quick session');
    // A GLOBAL custom flow is ungrouped; a project-scoped one is under its project.
    expect(screen.getByTestId('run-type-row-workflow:wf-global-custom-aa')).toHaveTextContent('Triage');
    expect(screen.getByTestId('run-type-row-workflow:wf-3-custom-bb')).toHaveTextContent('Nightly');
  });

  // AC 4 — a row with no override shows "Following defaults" and NO chips.
  it('renders "Following defaults" and no chips for a type with no stored override', async () => {
    await renderList();

    const row = screen.getByTestId('run-type-row-workflow:wf-global-planner');
    expect(within(row).getByTestId('run-type-status-workflow:wf-global-planner')).toHaveTextContent(
      'Following defaults',
    );
    expect(within(row).queryByTestId(/^run-type-chip-/)).not.toBeInTheDocument();
  });

  // AC 4 — the summary is a DIFF: a stored value equal to the baseline is not an override.
  it('treats a stored value equal to the global default as "Following defaults" (no chip)', async () => {
    await renderList({
      // 'opus' IS the workflow model floor, and 'sdk' IS DEFAULT_SUBSTRATE.
      runTypeDefaults: { 'workflow:wf-global-sprint': { model: 'opus', substrate: 'sdk' } },
    });

    const row = screen.getByTestId('run-type-row-workflow:wf-global-sprint');
    expect(within(row).getByTestId('run-type-status-workflow:wf-global-sprint')).toHaveTextContent(
      'Following defaults',
    );
    expect(within(row).queryByTestId(/^run-type-chip-/)).not.toBeInTheDocument();
  });

  // AC 4 — an overridden row chips ONLY the differing values.
  it('chips only the values that differ from the global defaults', async () => {
    await renderList({
      defaultAgentPermissionMode: 'acceptEdits',
      runTypeDefaults: {
        'workflow:wf-global-sprint': {
          model: 'sonnet', // differs from the 'opus' floor  → chip
          substrate: 'sdk', // equals DEFAULT_SUBSTRATE       → no chip
          permissionMode: 'acceptEdits', // equals the global → no chip
        },
      },
    });

    const row = screen.getByTestId('run-type-row-workflow:wf-global-sprint');
    expect(within(row).getByTestId('run-type-status-workflow:wf-global-sprint')).toHaveTextContent(
      '1 override',
    );
    // The same regex the "no chips" assertions use — proven here to actually match,
    // so those negatives cannot pass vacuously.
    expect(within(row).getAllByTestId(/^run-type-chip-/)).toHaveLength(1);
    expect(
      within(row).getByTestId('run-type-chip-workflow:wf-global-sprint-model'),
    ).toHaveTextContent('Model: Sonnet 5 · 1M');
    expect(
      within(row).queryByTestId('run-type-chip-workflow:wf-global-sprint-substrate'),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByTestId('run-type-chip-workflow:wf-global-sprint-permissionMode'),
    ).not.toBeInTheDocument();
  });

  // AC 4 — the diff is taken against the RESOLVED global, not the ship default:
  // the same stored value that reads as "Following defaults" for one user is a
  // real override for a user who moved the global.
  it('chips a stored value that matches the ship default but differs from the configured global', async () => {
    await renderList({
      defaultAgentPermissionMode: 'dontAsk',
      // 'default' is PermissionMode's ship value — but not THIS user's global.
      runTypeDefaults: { 'workflow:wf-global-planner': { permissionMode: 'default' } },
    });

    const row = screen.getByTestId('run-type-row-workflow:wf-global-planner');
    expect(within(row).getByTestId('run-type-status-workflow:wf-global-planner')).toHaveTextContent(
      '1 override',
    );
    const chip = within(row).getByTestId('run-type-chip-workflow:wf-global-planner-permissionMode');
    expect(chip).toHaveTextContent('Permission: Ask before edits');
    // The chip names the default it differs from, so the row reads as a diff.
    expect(chip).toHaveAttribute('title', "Permission: default is Don't ask");
  });

  it('counts multiple differing values in the status badge', async () => {
    await renderList({
      runTypeDefaults: { quick: { model: 'sonnet', reasoningEffort: 'high', substrate: 'sdk' } },
    });

    // quick's substrate baseline is 'interactive', so 'sdk' IS a difference.
    expect(screen.getByTestId('run-type-status-quick')).toHaveTextContent('3 overrides');
    expect(screen.getByTestId('run-type-chip-quick-reasoningEffort')).toHaveTextContent(
      'Reasoning effort: High',
    );
  });

  // AC 5 — a stale key is inert but never filtered out.
  it('still renders a stored key whose workflow no longer resolves, labelled with the raw key', async () => {
    await renderList({
      runTypeDefaults: { 'workflow:wf-deleted-999': { substrate: 'interactive' } },
    });

    const row = screen.getByTestId('run-type-row-workflow:wf-deleted-999');
    expect(row).toHaveTextContent('workflow:wf-deleted-999');
    expect(screen.getByText('Unmatched saved defaults')).toBeInTheDocument();
    // Still summarised as a real override, so it can be seen and cleared.
    expect(within(row).getByTestId('run-type-chip-workflow:wf-deleted-999-substrate')).toHaveTextContent(
      'Substrate: Interactive terminal',
    );
  });

  it('renders the quick row even when the workflow fan-out yields nothing', async () => {
    await renderList({}, []);

    expect(screen.getByTestId('run-type-row-quick')).toBeInTheDocument();
    expect(screen.queryByText('Built-in flows')).not.toBeInTheDocument();
  });

  // AC 1 (ROB-6) — a rejected enumeration is surfaced, never silently swallowed.
  describe('workflow enumeration failure', () => {
    it('renders a visible error instead of presenting a partial list as complete', async () => {
      projectsGetAll.mockRejectedValue(new Error('fan-out failed'));
      liveConfig = { gitRepoPath: '/repo' };
      await useConfigStore.getState().fetchConfig();
      render(<RunTypeOverridesSection />);
      await waitForWorkflowsSettled();

      const alert = screen.getByTestId('run-type-overrides-error');
      expect(alert).toHaveTextContent('fan-out failed');
      // The quick row still renders, but the built-in group (which needed the
      // failed fan-out) does not — the list is visibly incomplete, not silently short.
      expect(screen.getByTestId('run-type-row-quick')).toBeInTheDocument();
      expect(screen.queryByText('Built-in flows')).not.toBeInTheDocument();
    });

    it('never surfaces the rejection as an unhandled promise rejection', async () => {
      projectsGetAll.mockRejectedValue(new Error('fan-out failed'));
      liveConfig = { gitRepoPath: '/repo' };
      await useConfigStore.getState().fetchConfig();
      // Rendering (and awaiting settlement) must not throw.
      render(<RunTypeOverridesSection />);
      await expect(waitForWorkflowsSettled()).resolves.toBeUndefined();
    });

    it('lets the user retry, clearing the error once the retry succeeds', async () => {
      projectsGetAll.mockRejectedValueOnce(new Error('fan-out failed'));
      liveConfig = { gitRepoPath: '/repo' };
      await useConfigStore.getState().fetchConfig();
      render(<RunTypeOverridesSection />);
      await waitForWorkflowsSettled();
      expect(screen.getByTestId('run-type-overrides-error')).toBeInTheDocument();

      setWorkflowFixture(WORKFLOW_ENTRIES);
      fireEvent.click(screen.getByTestId('run-type-overrides-retry'));

      await waitFor(() =>
        expect(screen.queryByTestId('run-type-overrides-error')).not.toBeInTheDocument(),
      );
      expect(await screen.findByText('Built-in flows')).toBeInTheDocument();
    });

    it('keeps a per-project failure from blanking the other projects it DID resolve', async () => {
      projectsGetAll.mockResolvedValue({ success: true, data: PROJECTS });
      workflowsListQuery.mockImplementation(({ projectId }: { projectId: number }) => {
        if (projectId === 3) return Promise.reject(new Error('project 3 unreachable'));
        return Promise.resolve(workflowsForProject(WORKFLOW_ENTRIES, projectId));
      });
      liveConfig = { gitRepoPath: '/repo' };
      await useConfigStore.getState().fetchConfig();
      render(<RunTypeOverridesSection />);
      await waitForWorkflowsSettled();

      expect(screen.getByTestId('run-type-overrides-error')).toHaveTextContent(
        'project 3 unreachable',
      );
      // Project 1's (global) rows still resolved and still render.
      expect(screen.getByTestId('run-type-row-workflow:wf-global-sprint')).toBeInTheDocument();
    });
  });

  // AC 2 (COR-3) — the inventory is cross-project regardless of whatever the
  // shared, filterable gallery store is left scoped to.
  it('lists flows from every project even when workflowsStore is left filtered to one project, and never touches that store', async () => {
    useWorkflowsStore.setState({ projectFilter: 3 });
    const initSpy = vi.spyOn(useWorkflowsStore.getState(), 'init');

    await renderList({
      runTypeDefaults: { 'workflow:wf-global-planner': { model: 'sonnet' } },
    });

    // Every project's rows are present, not just project 3's.
    expect(screen.getByTestId('run-type-row-workflow:wf-global-sprint')).toBeInTheDocument();
    expect(screen.getByTestId('run-type-row-workflow:wf-global-planner')).toBeInTheDocument();
    expect(screen.getByTestId('run-type-row-workflow:wf-3-custom-bb')).toBeInTheDocument();
    // The planner's saved default is a REAL row's chip, never an "unmatched" one.
    expect(screen.queryByText('Unmatched saved defaults')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('run-type-row-workflow:wf-global-planner')).getByTestId(
        'run-type-chip-workflow:wf-global-planner-model',
      ),
    ).toBeInTheDocument();
    // The filtered shared store was never consulted at all.
    expect(initSpy).not.toHaveBeenCalled();

    initSpy.mockRestore();
  });
});

describe('RunTypeOverridesSection — detail screen', () => {
  async function openDetail(label: string, over: Partial<AppConfig> = {}): Promise<void> {
    await renderList(over);
    fireEvent.click(screen.getByRole('button', { name: `Configure ${label}` }));
    await screen.findByTestId('run-type-detail');
  }

  it('opens the detail screen from the Configure CTA, with a breadcrumb back to the list', async () => {
    await openDetail('Quick session');

    expect(screen.getByRole('button', { name: /Session settings \/ Quick session/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Session settings \/ Quick session/ }));
    expect(screen.getByTestId('run-type-overrides')).toBeInTheDocument();
  });

  it('renders only the knob cards backed by a real RunTypeDefaults field', async () => {
    await openDetail('Quick session');

    expect(screen.getByTestId('knob-card-model')).toBeInTheDocument();
    expect(screen.getByTestId('knob-card-runtime')).toBeInTheDocument();
    expect(screen.getByTestId('knob-card-permission')).toBeInTheDocument();
    // `orchestration` / `eval` have no storage field — deliberately not rendered.
    expect(screen.queryByTestId('knob-card-orchestration')).not.toBeInTheDocument();
    expect(screen.queryByTestId('knob-card-eval')).not.toBeInTheDocument();
  });

  // COR-8 — the Runtime card seeds each of its fields "from the baseline so the
  // control starts at the value the launch would have used". The quick baseline
  // used to hand it `substrate: 'interactive'` alongside `agentRuntime:
  // 'claude-sdk'`, so the runtime pick's own coercion immediately threw the
  // seeded substrate away and left the card describing a transport the launch
  // does NOT use — on a default install, with no user input beyond the toggle.
  it('seeds the Runtime card on a DEFAULT install with a self-consistent pair (quick)', async () => {
    await openDetail('Quick session');

    const card = screen.getByTestId('knob-card-runtime');
    // What the screen claims the launch would use, before the toggle.
    expect(within(card).getByTestId('run-type-field-substrate')).toHaveTextContent(
      'from defaults · Interactive terminal',
    );
    expect(within(card).getByTestId('run-type-field-agentRuntime')).toHaveTextContent(
      'from defaults · Claude Interactive (CLI)',
    );

    fireEvent.click(within(card).getByRole('switch'));

    expect(within(card).getByLabelText('Substrate')).toHaveValue('interactive');
    expect(within(card).getByLabelText('Agent runtime')).toHaveValue('claude-interactive');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('quick', {
        kind: 'merge',
        value: expect.objectContaining({
          substrate: 'interactive',
          agentRuntime: 'claude-interactive',
        }),
      }),
    );
  });

  it('seeds the Runtime card on a DEFAULT install with a self-consistent pair (flow)', async () => {
    await openDetail('Sprint');

    const card = screen.getByTestId('knob-card-runtime');
    fireEvent.click(within(card).getByRole('switch'));

    expect(within(card).getByLabelText('Substrate')).toHaveValue('sdk');
    expect(within(card).getByLabelText('Agent runtime')).toHaveValue('claude-sdk');
  });

  // AC 3 — effort is Quick-Session-only.
  it("shows a reasoning-effort field on the 'quick' detail screen", async () => {
    await openDetail('Quick session', { runTypeDefaults: { quick: { model: 'sonnet' } } });

    expect(screen.getByTestId('run-type-field-reasoningEffort')).toBeInTheDocument();
  });

  // AC 3 — and never on a `workflow:<id>` one (runs.start has no sink for it).
  it('does NOT show a reasoning-effort field on a workflow detail screen', async () => {
    await openDetail('Sprint', {
      runTypeDefaults: { 'workflow:wf-global-sprint': { model: 'sonnet' } },
    });

    expect(screen.queryByTestId('run-type-field-reasoningEffort')).not.toBeInTheDocument();
  });

  it('tags an un-overridden card "from defaults · <value>" and flips to live controls when switched on', async () => {
    await openDetail('Sprint');

    const card = screen.getByTestId('knob-card-permission');
    expect(within(card).getByTestId('run-type-field-permissionMode')).toHaveTextContent(
      'from defaults · Ask before edits',
    );
    expect(within(card).getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(within(card).getByRole('switch'));

    expect(within(card).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    // Seeded from the baseline, so nothing reads as overridden yet.
    expect(within(card).getByLabelText('Permission')).toHaveValue('default');
    expect(within(card).queryByTestId('run-type-changed-permissionMode')).not.toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText('Permission'), { target: { value: 'dontAsk' } });
    expect(within(card).getByTestId('run-type-changed-permissionMode')).toHaveTextContent(
      'overridden · default is Ask before edits',
    );
  });

  /**
   * Regression: the model baseline is the always-Claude floor, which OMP
   * legitimately refuses (absence there means "OMP picks"). Seeding that
   * refusal made the card UNOPENABLE, because `cardIsOn` is derived from "some
   * field is non-null" — the switch flipped straight back off and the model
   * control could never be reached at all under an OMP runtime.
   */
  it('opens the model card under an OMP runtime, seeding a model OMP can launch', async () => {
    await openDetail('Quick session', { defaultAgentRuntime: 'omp-sdk' });

    const card = await screen.findByTestId('knob-card-model');
    const toggle = within(card).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'true');
    // The seed comes from the offered list, so it is launchable by construction
    // — never the Claude floor the baseline actually held.
    expect(within(card).getByLabelText('Model')).toHaveValue('anthropic/claude-opus-4-5');
  });

  it('still seeds the model card from the baseline under a Claude runtime', async () => {
    await openDetail('Quick session');

    const card = await screen.findByTestId('knob-card-model');
    fireEvent.click(within(card).getByRole('switch'));

    expect(within(card).getByLabelText('Model')).toHaveValue('opus');
  });

  // AC 2 — Save goes through applyRunTypeDefault, never API.config.update or the parent form.
  it('saves through applyRunTypeDefault without touching config.update or the parent form', async () => {
    const onSubmit = await renderInParentForm();

    fireEvent.click(screen.getByRole('button', { name: 'Configure Sprint' }));
    const card = await screen.findByTestId('knob-card-model');
    fireEvent.click(within(card).getByRole('switch'));
    fireEvent.change(within(card).getByLabelText('Model'), { target: { value: 'sonnet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('workflow:wf-global-sprint', {
        kind: 'merge',
        value: {
          model: 'sonnet',
          reasoningEffort: null,
          substrate: null,
          agentRuntime: null,
          permissionMode: null,
        },
      }),
    );
    expect(configUpdate).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    // Back on the list, the new override is summarised as a diff.
    await waitFor(() =>
      expect(screen.getByTestId('run-type-chip-workflow:wf-global-sprint-model')).toHaveTextContent(
        'Model: Sonnet 5 · 1M',
      ),
    );
  });

  // AC 2 — the REASON the shared form is banned: its `runTypeDefaults` echo is
  // snapshotted at modal open. Here a launch screen saves a `quick` default
  // while the detail screen sits open; the section's per-key op must merge into
  // the LIVE config and leave that concurrent write standing. A save routed
  // through `API.config.update` with the modal's snapshot would erase it.
  it('does not clobber a default saved elsewhere while the detail screen was open', async () => {
    const onSubmit = await renderInParentForm({
      runTypeDefaults: { 'workflow:wf-global-sprint': { model: 'haiku' } },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Configure Sprint' }));
    const card = await screen.findByTestId('knob-card-model');
    fireEvent.change(within(card).getByLabelText('Model'), { target: { value: 'sonnet' } });

    // …meanwhile, a launch screen writes its own key straight to config.
    liveConfig = {
      ...liveConfig,
      runTypeDefaults: { ...liveConfig.runTypeDefaults, quick: { model: 'fable' } },
    };

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(useConfigStore.getState().config?.runTypeDefaults).toEqual({
        'workflow:wf-global-sprint': { model: 'sonnet' },
        quick: { model: 'fable' },
      }),
    );
    // Exactly one key was written, through the dedicated op only.
    expect(applyRunTypeDefaultSpy).toHaveBeenCalledTimes(1);
    expect(applyRunTypeDefaultSpy.mock.calls[0][0]).toBe('workflow:wf-global-sprint');
    expect(configUpdate).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    // The concurrent write is visible on the list the section returns to.
    expect(screen.getByTestId('run-type-chip-quick-model')).toHaveTextContent('Model: Fable 5 · 1M');
  });

  // AC 2 — Reset is the other write path, and is held to the same rule.
  it('resets through applyRunTypeDefault without touching config.update or the parent form', async () => {
    const onSubmit = await renderInParentForm({
      runTypeDefaults: { quick: { model: 'sonnet' }, 'workflow:wf-global-sprint': { model: 'haiku' } },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Configure Quick session' }));
    await screen.findByTestId('run-type-detail');
    fireEvent.click(screen.getByRole('button', { name: /Reset Quick session to defaults/ }));

    await waitFor(() =>
      expect(useConfigStore.getState().config?.runTypeDefaults).toEqual({
        'workflow:wf-global-sprint': { model: 'haiku' },
      }),
    );
    expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('quick', { kind: 'replace', value: null });
    expect(configUpdate).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // AC 4 — a FAILED write must never close the screen or discard the draft.
  describe('a failed write', () => {
    it('keeps the screen open and shows the error on Save', async () => {
      await openDetail('Quick session');

      const card = screen.getByTestId('knob-card-model');
      fireEvent.click(within(card).getByRole('switch'));
      fireEvent.change(within(card).getByLabelText('Model'), { target: { value: 'sonnet' } });

      forcedApplyError = "Couldn't save default";
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByTestId('run-type-save-error')).toHaveTextContent(
        "Couldn't save default",
      );
      // Still on the detail screen, draft intact — never closed on failure.
      expect(screen.getByTestId('run-type-detail')).toBeInTheDocument();
      expect(within(card).getByLabelText('Model')).toHaveValue('sonnet');
    });

    it('keeps the screen open and shows the error on Reset', async () => {
      await openDetail('Quick session', { runTypeDefaults: { quick: { model: 'sonnet' } } });

      forcedApplyError = "Couldn't reset";
      fireEvent.click(screen.getByRole('button', { name: /Reset Quick session to defaults/ }));

      expect(await screen.findByTestId('run-type-save-error')).toHaveTextContent("Couldn't reset");
      expect(screen.getByTestId('run-type-detail')).toBeInTheDocument();
    });

    it('does not carry a stale error into a later successful save', async () => {
      await openDetail('Quick session');

      const card = screen.getByTestId('knob-card-model');
      fireEvent.click(within(card).getByRole('switch'));
      forcedApplyError = 'nope';
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await screen.findByTestId('run-type-save-error');

      forcedApplyError = null;
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.queryByTestId('run-type-detail')).not.toBeInTheDocument());
    });
  });

  // AC 3 (COR-3) — an unlaunchable model/runtime/substrate combination cannot be saved.
  describe('runtime-family coercion', () => {
    it('coerces an already-overridden Claude model and clears an incompatible substrate when Codex is selected', async () => {
      await openDetail('Sprint');

      const modelCard = screen.getByTestId('knob-card-model');
      fireEvent.click(within(modelCard).getByRole('switch'));
      expect(within(modelCard).getByLabelText('Model')).toHaveValue('opus');

      const runtimeCard = screen.getByTestId('knob-card-runtime');
      fireEvent.click(within(runtimeCard).getByRole('switch'));
      fireEvent.change(within(runtimeCard).getByLabelText('Substrate'), {
        target: { value: 'interactive' },
      });
      fireEvent.change(within(runtimeCard).getByLabelText('Agent runtime'), {
        target: { value: 'codex-sdk' },
      });

      // The unlaunchable combo (opus + codex-sdk + interactive) is coerced: the
      // model flips to the Codex-compatible 'auto' sentinel, and the now
      // incompatible substrate is cleared back to "Follow defaults".
      expect(within(modelCard).getByLabelText('Model')).toHaveValue('auto');
      expect(within(runtimeCard).getByLabelText('Substrate')).toHaveValue('');
    });

    it('coerces the model even when the model card was never switched on', async () => {
      await openDetail('Sprint');

      const runtimeCard = screen.getByTestId('knob-card-runtime');
      fireEvent.click(within(runtimeCard).getByRole('switch'));
      fireEvent.change(within(runtimeCard).getByLabelText('Agent runtime'), {
        target: { value: 'codex-sdk' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      // The saved patch carries an EXPLICIT Codex-compatible model — a stale
      // Claude floor can never ride along with the runtime override.
      await waitFor(() =>
        expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('workflow:wf-global-sprint', {
          kind: 'merge',
          value: expect.objectContaining({ model: 'auto', agentRuntime: 'codex-sdk' }),
        }),
      );
    });

    // AC 1 — runtime LAST. Already worked; pinned on the PATCH (not just the
    // control) so the fix for the other orders cannot regress it.
    it('runtime last: a Claude model picked first never reaches the saved patch', async () => {
      await openDetail('Sprint');

      const modelCard = screen.getByTestId('knob-card-model');
      fireEvent.click(within(modelCard).getByRole('switch'));
      fireEvent.change(within(modelCard).getByLabelText('Model'), { target: { value: 'sonnet' } });

      const runtimeCard = screen.getByTestId('knob-card-runtime');
      fireEvent.click(within(runtimeCard).getByRole('switch'));
      fireEvent.change(within(runtimeCard).getByLabelText('Agent runtime'), {
        target: { value: 'codex-sdk' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('workflow:wf-global-sprint', {
          kind: 'merge',
          value: {
            model: 'auto',
            reasoningEffort: null,
            substrate: null,
            agentRuntime: 'codex-sdk',
            permissionMode: null,
          },
        }),
      );
    });

    // AC 2 — model LAST. THE defect: the model dropdown stayed Claude-only and
    // its edit path applied no coercion, so this order rebuilt the exact pair
    // the runtime pick had just removed.
    it('model last: a Claude model cannot be re-selected after a Codex runtime', async () => {
      await openDetail('Sprint');

      const modelCard = screen.getByTestId('knob-card-model');
      fireEvent.click(within(modelCard).getByRole('switch'));
      const runtimeCard = screen.getByTestId('knob-card-runtime');
      fireEvent.click(within(runtimeCard).getByRole('switch'));
      fireEvent.change(within(runtimeCard).getByLabelText('Agent runtime'), {
        target: { value: 'codex-sdk' },
      });

      // The Claude alias is not even on offer any more…
      const modelSelect = within(modelCard).getByLabelText('Model');
      expect(
        within(modelSelect).queryAllByRole('option').map((o) => (o as HTMLOptionElement).value),
      ).not.toContain('opus');
      // …and forcing it through the control anyway does not stick.
      fireEvent.change(modelSelect, { target: { value: 'opus' } });
      expect(modelSelect).not.toHaveValue('opus');

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(applyRunTypeDefaultSpy).toHaveBeenCalled());
      const [, op] = applyRunTypeDefaultSpy.mock.calls[0] as [string, RunTypeDefaultsOp];
      expect(op).toMatchObject({ kind: 'merge', value: { agentRuntime: 'codex-sdk' } });
      expect((op.value as RunTypeDefaults).model).toBe('auto');
    });

    // AC 3 — substrate LAST. A stored substrate BEATS the runtime's implied one
    // at launch, so a disagreeing pick would be saved as dead, contradictory
    // state; the runtime moves to the one that owns the picked transport.
    it('substrate last: a disagreeing pick moves the runtime instead of contradicting it', async () => {
      await openDetail('Sprint');

      const runtimeCard = screen.getByTestId('knob-card-runtime');
      fireEvent.click(within(runtimeCard).getByRole('switch'));
      fireEvent.change(within(runtimeCard).getByLabelText('Agent runtime'), {
        target: { value: 'claude-sdk' },
      });
      fireEvent.change(within(runtimeCard).getByLabelText('Substrate'), {
        target: { value: 'interactive' },
      });

      expect(within(runtimeCard).getByLabelText('Agent runtime')).toHaveValue('claude-interactive');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('workflow:wf-global-sprint', {
          kind: 'merge',
          value: expect.objectContaining({
            substrate: 'interactive',
            agentRuntime: 'claude-interactive',
          }),
        }),
      );
    });

    // AC 3 — and a Codex runtime has no substrate at all to disagree WITH.
    it('substrate last: the control is inert under a Codex runtime and saves nothing', async () => {
      await openDetail('Sprint');

      const runtimeCard = screen.getByTestId('knob-card-runtime');
      fireEvent.click(within(runtimeCard).getByRole('switch'));
      fireEvent.change(within(runtimeCard).getByLabelText('Agent runtime'), {
        target: { value: 'codex-sdk' },
      });

      const substrateSelect = within(runtimeCard).getByLabelText('Substrate');
      expect(substrateSelect).toBeDisabled();
      expect(within(runtimeCard).getByTestId('run-type-na-substrate')).toBeInTheDocument();
      fireEvent.change(substrateSelect, { target: { value: 'interactive' } });
      expect(substrateSelect).toHaveValue('');

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('workflow:wf-global-sprint', {
          kind: 'merge',
          value: expect.objectContaining({ substrate: null, agentRuntime: 'codex-sdk' }),
        }),
      );
    });

    // AC 4 — the model dropdown is scoped to the draft's EFFECTIVE runtime, and
    // sources its Codex half from the same catalog store the launch pickers use.
    it('offers Claude aliases on a Claude runtime and Codex catalog models on a Codex one', async () => {
      await openDetail('Sprint');

      const modelCard = screen.getByTestId('knob-card-model');
      fireEvent.click(within(modelCard).getByRole('switch'));
      const optionText = (): (string | null)[] =>
        within(within(modelCard).getByLabelText('Model'))
          .getAllByRole('option')
          .map((o) => o.textContent);

      expect(optionText()).toEqual([
        'Follow defaults',
        'Fable 5 · 1M',
        'Opus 5 · 1M',
        'Sonnet 5 · 1M',
        'Haiku 4.5 · 200K',
        'Auto',
      ]);

      const runtimeCard = screen.getByTestId('knob-card-runtime');
      fireEvent.click(within(runtimeCard).getByRole('switch'));
      fireEvent.change(within(runtimeCard).getByLabelText('Agent runtime'), {
        target: { value: 'codex-sdk' },
      });

      // No Claude alias survives — and no "Follow defaults" either: an omitted
      // model member resolves to the always-Claude floor, so it would BE the
      // cross-family pair (this mirrors ModelSelector's Claude-only default option).
      expect(optionText()).toEqual(['Auto/default', 'GPT-5 Codex', 'GPT-5']);

      fireEvent.change(within(runtimeCard).getByLabelText('Agent runtime'), {
        target: { value: 'claude-interactive' },
      });
      expect(optionText()).toContain('Opus 5 · 1M');
    });

    it('coerces a stale Codex-family model back to Claude when flipping to a Claude runtime', async () => {
      // A raw Codex model id (never offered by this Claude-only picker, but
      // reachable via a stale/older-version stored default) has no matching
      // <option>, so the control cannot even DISPLAY it — which is exactly why
      // it must be coerced away rather than left standing the moment the
      // runtime override is touched.
      await openDetail('Sprint', {
        runTypeDefaults: { 'workflow:wf-global-sprint': { model: 'gpt-5-codex', agentRuntime: 'codex-sdk' } },
      });

      const runtimeCard = screen.getByTestId('knob-card-runtime');
      fireEvent.change(within(runtimeCard).getByLabelText('Agent runtime'), {
        target: { value: 'claude-sdk' },
      });

      const modelCard = screen.getByTestId('knob-card-model');
      expect(within(modelCard).getByLabelText('Model')).toHaveValue('opus');
    });
  });

  // AC 3 — the quick key is the only one whose launch can reach the Codex TUI.
  it('offers the terminal + OMP session runtimes on the quick screen only', async () => {
    await openDetail('Quick session');

    const card = screen.getByTestId('knob-card-runtime');
    fireEvent.click(within(card).getByRole('switch'));
    // The session-scope set for the LOCAL OMP flavor (Aria off, the default):
    // every selectableInPickers runtime except the remote fleet supervisor. The
    // two OMP flavors are alternatives, so `omp-fleet` is absent here — see the
    // Aria-mode test below for the other half.
    expect(
      within(within(card).getByLabelText('Agent runtime')).getAllByRole('option').map((o) => o.textContent),
    ).toEqual([
      'Follow defaults',
      'Claude SDK',
      'Claude Interactive (CLI)',
      'Codex SDK',
      'Codex (CLI)',
      'OMP',
      'OMP (CLI)',
    ]);

    // The stored value is untouched by the flavor filter: nothing was saved
    // here, so the control still reads "Follow defaults" for the pick above.
  });

  // Aria mode is the ONE switch that decides which OMP this install runs, and it
  // has to reach every surface that names a runtime — otherwise Settings offers
  // a flavor the launch picker refuses.
  it('swaps the local OMP runtimes for the fleet supervisor under Aria mode', async () => {
    // ariaMode is the user's SETTING, so it rides the config store; the query
    // only supplies `launchable` (whether a bridge is actually reachable).
    ompAvailabilityMock.mockResolvedValue({ launchable: true, ariaMode: true });
    await openDetail('Quick session', { ariaMode: true });

    const card = screen.getByTestId('knob-card-runtime');
    fireEvent.click(within(card).getByRole('switch'));

    await waitFor(() =>
      expect(
        within(within(card).getByLabelText('Agent runtime')).getAllByRole('option').map((o) => o.textContent),
      ).toEqual([
        'Follow defaults',
        'Claude SDK',
        'Claude Interactive (CLI)',
        'Codex SDK',
        'Codex (CLI)',
        'OMP fleet',
      ]),
    );
  });

  // Flipping the toggle changes what you can PICK, never what is already
  // stored. A <select> whose list omits its own value renders blank and would
  // rewrite the stored override on the next save of any other field.
  it('keeps a stored runtime the flavor would hide in its own dropdown', async () => {
    ompAvailabilityMock.mockResolvedValue({ launchable: true, ariaMode: true });
    await openDetail('Quick session', {
      ariaMode: true,
      runTypeDefaults: { quick: { agentRuntime: 'omp-sdk' } },
    });

    const card = screen.getByTestId('knob-card-runtime');
    await waitFor(() => {
      const labels = within(within(card).getByLabelText('Agent runtime'))
        .getAllByRole('option')
        .map((o) => o.textContent);
      // Both the flavor's runtime AND the stored one the flavor hides.
      expect(labels).toContain('OMP fleet');
      expect(labels).toContain('OMP');
    });
    expect(within(card).getByLabelText('Agent runtime')).toHaveValue('omp-sdk');
  });

  it('omits the session-only PTY runtimes on a workflow screen (the LAUNCHABLE set)', async () => {
    await openDetail('Sprint');

    const card = screen.getByTestId('knob-card-runtime');
    fireEvent.click(within(card).getByRole('switch'));
    // 'OMP' is present, 'OMP (CLI)' is not: a workflow screen offers every
    // STRUCTURED runtime and no terminal one, which is the launchable set.
    expect(
      within(within(card).getByLabelText('Agent runtime')).getAllByRole('option').map((o) => o.textContent),
    ).toEqual(['Follow defaults', 'Claude SDK', 'Claude Interactive (CLI)', 'Codex SDK', 'OMP']);
  });

  // AC 5 + AC 6 — a stale key is not just VISIBLE, it is operable: being able to
  // clear it is the whole reason it is never auto-pruned.
  it('opens a stale key under its raw key and can clear it end-to-end', async () => {
    await renderList({
      runTypeDefaults: { 'workflow:wf-deleted-999': { model: 'haiku', substrate: 'interactive' } },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Configure workflow:wf-deleted-999' }));
    await screen.findByTestId('run-type-detail');

    // The breadcrumb + header fall back to the raw key: the id resolves to nothing.
    expect(
      screen.getByRole('button', { name: 'Session settings / workflow:wf-deleted-999' }),
    ).toBeInTheDocument();
    // A stale key is a FLOW key, so it gets no effort control either.
    expect(screen.queryByTestId('run-type-field-reasoningEffort')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Reset workflow:wf-deleted-999 to defaults/ }));

    await waitFor(() =>
      expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('workflow:wf-deleted-999', {
        kind: 'replace',
        value: null,
      }),
    );
    await waitFor(() => expect(useConfigStore.getState().config?.runTypeDefaults).toBeUndefined());
    // With nothing stored for it, the unmatched row has nothing left to show.
    expect(screen.queryByTestId('run-type-row-workflow:wf-deleted-999')).not.toBeInTheDocument();
    expect(screen.queryByText('Unmatched saved defaults')).not.toBeInTheDocument();
  });

  // AC 6 — emptying the LAST key drops `runTypeDefaults` itself, so an empty map
  // never becomes a persisted config entry.
  it('drops runTypeDefaults entirely when the only key is cleared and saved', async () => {
    await openDetail('Quick session', { runTypeDefaults: { quick: { model: 'sonnet' } } });

    const card = screen.getByTestId('knob-card-model');
    expect(within(card).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(card).getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(useConfigStore.getState().config?.runTypeDefaults).toBeUndefined());
    expect(screen.getByTestId('run-type-status-quick')).toHaveTextContent('Following defaults');
    expect(screen.queryByTestId('run-type-chip-quick-model')).not.toBeInTheDocument();
    expect(configUpdate).not.toHaveBeenCalled();
  });

  // AC 6 — clearing every field merges the key to empty, which deletes it.
  it('deletes the key end-to-end when every field is cleared and saved', async () => {
    await openDetail('Quick session', {
      runTypeDefaults: {
        quick: { model: 'sonnet', reasoningEffort: 'high', substrate: 'sdk' },
        'workflow:wf-global-sprint': { model: 'haiku' },
      },
    });

    // Switch every card OFF — each clears its own fields back to "follow defaults".
    for (const cardId of ['model', 'runtime', 'permission']) {
      const card = screen.getByTestId(`knob-card-${cardId}`);
      const toggle = within(card).getByRole('switch');
      if (toggle.getAttribute('aria-checked') === 'true') fireEvent.click(toggle);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('quick', {
        kind: 'merge',
        value: {
          model: null,
          reasoningEffort: null,
          substrate: null,
          agentRuntime: null,
          permissionMode: null,
        },
      }),
    );

    // The store refetched: the key is GONE from config, the sibling key survives.
    await waitFor(() =>
      expect(useConfigStore.getState().config?.runTypeDefaults).toEqual({
        'workflow:wf-global-sprint': { model: 'haiku' },
      }),
    );
    expect(screen.getByTestId('run-type-status-quick')).toHaveTextContent('Following defaults');
  });

  it('resets a type to defaults with a replace-null op', async () => {
    await openDetail('Quick session', {
      runTypeDefaults: { quick: { model: 'sonnet' } },
    });

    fireEvent.click(screen.getByRole('button', { name: /Reset Quick session to defaults/ }));

    await waitFor(() =>
      expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('quick', { kind: 'replace', value: null }),
    );
    await waitFor(() =>
      expect(useConfigStore.getState().config?.runTypeDefaults).toBeUndefined(),
    );
    expect(configUpdate).not.toHaveBeenCalled();
  });

  it('discards the draft on Cancel', async () => {
    await openDetail('Quick session');

    const card = screen.getByTestId('knob-card-model');
    fireEvent.click(within(card).getByRole('switch'));
    fireEvent.change(within(card).getByLabelText('Model'), { target: { value: 'haiku' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(applyRunTypeDefaultSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('run-type-status-quick')).toHaveTextContent('Following defaults');
  });
});
