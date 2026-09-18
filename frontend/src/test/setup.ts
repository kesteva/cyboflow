import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

import { startOrphanWatchdog } from '../../../vitestOrphanWatchdog';

// Exit if our vitest root dies — see main/src/test/setup.ts for the why. jsdom
// still runs inside a real forked node process, so this suite leaks orphans too.
startOrphanWatchdog();

afterEach(() => { cleanup(); });

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

// ---------------------------------------------------------------------------
// Global tRPC stub — prevents "Could not find `electronTRPC` global" crash
// when a test file renders a component that imports trpc/client without
// providing its own vi.mock('…/trpc/client').  Individual test files that
// need specific tRPC behaviour override this with their own vi.mock calls.
// ---------------------------------------------------------------------------

vi.mock('../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        list: { query: vi.fn().mockResolvedValue([]) },
        // Live merge/PR gate — settled by default so accept actions proceed.
        sessionSettleState: { query: vi.fn().mockResolvedValue({ flowBusy: false, chatTurnInFlight: false }) },
        listFiles: { query: vi.fn().mockResolvedValue([]) },
        readFile: {
          query: vi.fn().mockResolvedValue({ path: '', content: '', size: 0, unviewableReason: null }),
        },
        // Sprint lanes (single-run lane model) — empty by default so any
        // component mounting SprintLanesPanel renders nothing.
        sprintLanes: { query: vi.fn().mockResolvedValue([]) },
        onSprintLaneChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
      workflows: {
        list: {
          query: vi.fn().mockResolvedValue([
            { id: 'wf-1', project_id: 0, name: 'soloflow', workflow_path: null, permission_mode: 'default', created_at: '' },
            { id: 'wf-2', project_id: 0, name: 'planner', workflow_path: null, permission_mode: 'default', created_at: '' },
          ]),
        },
      },
      // A/B testing (migration 048) — VariantSelector / VariantManagerSection
      // fetch this for the selected workflow. Empty by default so either renders
      // its "nothing to show" state without any test file needing its own mock.
      variants: {
        list: { query: vi.fn().mockResolvedValue([]) },
      },
      // A/B testing slice C — ExperimentsSection (Insights) fetches variantStats
      // per workflow and the past-experiments dashboard list; WorkflowSummaryPanel's
      // experiment banner polls comparisonStatus when a run carries an experimentId.
      // Empty/absent by default so any component mounting these renders its
      // "nothing to show" state without every test file needing its own mock.
      insights: {
        variantStats: { query: vi.fn().mockResolvedValue([]) },
      },
      experiments: {
        listForDashboard: { query: vi.fn().mockResolvedValue([]) },
        comparisonStatus: { query: vi.fn().mockResolvedValue({ status: 'absent' }) },
        // Rotation experiments (migration 058) — ExperimentsSection lists rotation
        // dashboard rows, VariantManagerSection probes the running rotation for its
        // supersede-confirm gate, RotationComparisonBody fetches per-arm stats/runs.
        // Benign defaults so components render their empty states without per-file mocks.
        listRotationsForDashboard: { query: vi.fn().mockResolvedValue([]) },
        getRunningRotation: { query: vi.fn().mockResolvedValue(null) },
        rotationStats: { query: vi.fn().mockResolvedValue([]) },
        rotationRuns: { query: vi.fn().mockResolvedValue([]) },
      },
      events: {
        onStuckDetected: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        onApprovalCreated: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        onApprovalDecided: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        onRunStatusChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        setBadgeCount: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      },
      approvals: {
        listPending: { query: vi.fn().mockResolvedValue([]) },
      },
      // Right-rail Diff tab liveness — RunRightRail subscribes to worktree
      // changes for the selected session while its Diff tab is mounted. Inert
      // by default (never emits) so any test that opens the Diff tab renders
      // without a per-file mock; files asserting on the subscription override.
      sessionGit: {
        onWorktreeChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
      // Live AskUserQuestion queue (questionStore) — RunPendingInputStrip mounts
      // unconditionally inside RunCenterPane, so any test rendering it needs this
      // stubbed even without a dedicated trpc mock. Empty by default.
      questions: {
        listPending: { query: vi.fn().mockResolvedValue([]) },
        onQuestionCreated: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        onQuestionAnswered: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
      // Unified review_items inbox (reviewItemsSlice) — same rationale: mounted
      // unconditionally inside RunCenterPane via RunPendingInputStrip.
      reviewItems: {
        list: { query: vi.fn().mockResolvedValue([]) },
        // Proposal-card finding resolution (TASK-221's useProposalEntityLabels) —
        // null by default so an unmocked finding id degrades to "unresolved"
        // rather than every test needing its own stub.
        get: { query: vi.fn().mockResolvedValue(null) },
        onReviewItemChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
      // Dynamic-workflow mirror (dynamicWorkflowStore) — DraggableProjectTreeView
      // joins the store's singleton subscription for its collapsed-project
      // running badge (TASK-223), so every test rendering the sidebar tree
      // needs these to exist. Inert by default (empty seed, never emits).
      dynamicWorkflows: {
        list: { query: vi.fn().mockResolvedValue([]) },
        onChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        onRemoved: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
      // Approved-design lookup (Tier 2, item 8c) — DesignAffordance mounts
      // unconditionally on every non-idea TaskCard/TaskDetailModal and, given a
      // sessionKey, every sprint swimlane lane header. No bound design by
      // default so it renders nothing without every test file needing its own
      // mock.
      design: {
        forEntity: { query: vi.fn().mockResolvedValue(null) },
        snapshotHtml: { query: vi.fn().mockResolvedValue(null) },
      },
      // Idea component ledger live channel — also read by DesignAffordance /
      // ApprovedDesignTab for their live refresh. No-op by default.
      ideaComponents: {
        onComponentsChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
    },
  },
}));
