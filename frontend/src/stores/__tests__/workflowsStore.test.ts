/**
 * Unit tests for workflowsStore — focused on the cross-project fan-out dedup
 * introduced for global workflows (migration 029).
 *
 * A GLOBAL flow (`project_id` null) is returned by EVERY project's
 * `workflows.list`, so the fan-out yields the same row once per enumerated
 * project. The store must dedupe those by `row.id` (mirroring the agent dedup)
 * and fold per-project run history into ONE entry, keeping the NEWEST run
 * timestamp across the fan-out.
 *
 * The tRPC client + projects API are mocked at module level so importing the
 * store needs no live IPC bridge. The store's closure-private `initialized`
 * guard means each behavior test re-imports the module fresh (loadStore) so
 * init() actually fetches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  WorkflowRow,
  WorkflowRunListRow,
} from '../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Mutable mock references — re-created in beforeEach so each test is isolated.
// vi.mock factories read these via getters so swapping the reference takes
// effect even after the module under test captured `trpc`.
// ---------------------------------------------------------------------------

let mockWorkflowsListQuery: ReturnType<typeof vi.fn>;
let mockAgentsListQuery: ReturnType<typeof vi.fn>;
let mockRunsListQuery: ReturnType<typeof vi.fn>;
let mockProjectsGetAll: ReturnType<typeof vi.fn>;

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      workflows: {
        list: { get query() { return mockWorkflowsListQuery; } },
      },
      agents: {
        list: { get query() { return mockAgentsListQuery; } },
        onChanged: { subscribe: () => ({ unsubscribe: vi.fn() }) },
      },
      runs: {
        list: { get query() { return mockRunsListQuery; } },
      },
      events: {
        onRunStatusChanged: { subscribe: () => ({ unsubscribe: vi.fn() }) },
      },
    },
  },
}));

vi.mock('../../utils/api', () => ({
  API: { projects: { get getAll() { return mockProjectsGetAll; } } },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A GLOBAL built-in row (project_id null) — returned by every project's list. */
function globalRow(id: string, name: string): WorkflowRow {
  return {
    id,
    project_id: null,
    name,
    workflow_path: `workflows/${name}.md`,
    permission_mode: 'default',
    spec_json: '{}',
    created_at: '2026-06-01T00:00:00.000Z',
  };
}

/** A project-scoped custom row. */
function projectRow(id: string, name: string, projectId: number): WorkflowRow {
  return {
    id,
    project_id: projectId,
    name,
    workflow_path: null,
    permission_mode: 'default',
    // A custom flow needs a resolvable spec_json or it is dropped on read.
    spec_json: JSON.stringify({
      id: name,
      phases: [
        {
          id: 'p1',
          label: 'Plan',
          color: '#3b6dd6',
          steps: [{ id: 's1', name: 'S1', agent: 'context', mcps: [], retries: 0 }],
        },
      ],
    }),
    created_at: '2026-06-02T00:00:00.000Z',
  };
}

function run(workflowId: string, createdAt: string): WorkflowRunListRow {
  return {
    id: `run-${workflowId}-${createdAt}`,
    workflow_id: workflowId,
    project_id: 1,
    status: 'completed',
    worktree_path: null,
    branch_name: null,
    created_at: createdAt,
    updated_at: createdAt,
    started_at: null,
    ended_at: null,
    stuck_reason: null,
  };
}

type WorkflowsModule = typeof import('../workflowsStore');

async function loadStore(): Promise<WorkflowsModule> {
  vi.resetModules();
  return import('../workflowsStore');
}

beforeEach(() => {
  mockAgentsListQuery = vi.fn().mockResolvedValue([]);
  mockRunsListQuery = vi.fn().mockResolvedValue([]);
  mockProjectsGetAll = vi.fn().mockResolvedValue({
    success: true,
    data: [
      { id: 1, name: 'Acme' },
      { id: 2, name: 'Beta' },
    ],
  });
});

// ---------------------------------------------------------------------------
// deriveLastUsedByWorkflow (pure helper — newest created_at per workflow id)
// ---------------------------------------------------------------------------

describe('deriveLastUsedByWorkflow', () => {
  it('keeps the newest created_at per workflow id', async () => {
    const { deriveLastUsedByWorkflow } = await loadStore();
    const out = deriveLastUsedByWorkflow([
      run('wf-global-planner', '2026-06-01T00:00:00.000Z'),
      run('wf-global-planner', '2026-06-05T00:00:00.000Z'),
      run('wf-global-sprint', '2026-06-03T00:00:00.000Z'),
    ]);
    expect(out['wf-global-planner']).toBe('2026-06-05T00:00:00.000Z');
    expect(out['wf-global-sprint']).toBe('2026-06-03T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Cross-project dedup of global workflows (migration 029)
// ---------------------------------------------------------------------------

describe('workflowsStore — global-workflow dedup', () => {
  it('shows a global flow ONCE across the cross-project fan-out', async () => {
    // Both projects return the SAME global planner row.
    mockWorkflowsListQuery = vi.fn().mockResolvedValue([globalRow('wf-global-planner', 'planner')]);

    const { useWorkflowsStore } = await loadStore();
    await useWorkflowsStore.getState().init();

    const { workflows } = useWorkflowsStore.getState();
    expect(workflows).toHaveLength(1);
    expect(workflows[0].row.id).toBe('wf-global-planner');
    // A global row carries no owning-project name (its chip is hidden).
    expect(workflows[0].row.project_id).toBeNull();
    expect(workflows[0].projectName).toBe('');
    // The list was queried once per enumerated project (the rows then deduped).
    expect(mockWorkflowsListQuery).toHaveBeenCalledTimes(2);
  });

  it("folds a global flow's runs to the NEWEST timestamp across projects", async () => {
    mockWorkflowsListQuery = vi.fn().mockResolvedValue([globalRow('wf-global-sprint', 'sprint')]);
    // Project 1 ran it on the 3rd; project 2 on the 8th — the newest must win.
    mockRunsListQuery = vi.fn().mockImplementation(({ projectId }: { projectId: number }) =>
      Promise.resolve(
        projectId === 1
          ? [run('wf-global-sprint', '2026-06-03T00:00:00.000Z')]
          : [run('wf-global-sprint', '2026-06-08T00:00:00.000Z')],
      ),
    );

    const { useWorkflowsStore } = await loadStore();
    await useWorkflowsStore.getState().init();

    const { workflows } = useWorkflowsStore.getState();
    expect(workflows).toHaveLength(1);
    expect(workflows[0].lastUsedAt).toBe('2026-06-08T00:00:00.000Z');
  });

  it('keeps project-scoped rows distinct and tags them with their project name', async () => {
    // Each project returns the global planner PLUS its own custom flow.
    mockWorkflowsListQuery = vi.fn().mockImplementation(({ projectId }: { projectId: number }) =>
      Promise.resolve([
        globalRow('wf-global-planner', 'planner'),
        projectRow(`wf-${projectId}-custom-aaaa`, `custom-${projectId}`, projectId),
      ]),
    );

    const { useWorkflowsStore } = await loadStore();
    await useWorkflowsStore.getState().init();

    const { workflows } = useWorkflowsStore.getState();
    const ids = workflows.map((w) => w.row.id).sort();
    expect(ids).toEqual(['wf-1-custom-aaaa', 'wf-2-custom-aaaa', 'wf-global-planner']);

    const p1 = workflows.find((w) => w.row.id === 'wf-1-custom-aaaa');
    const p2 = workflows.find((w) => w.row.id === 'wf-2-custom-aaaa');
    expect(p1?.projectName).toBe('Acme');
    expect(p2?.projectName).toBe('Beta');
  });
});
