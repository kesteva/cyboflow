import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
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
        onReviewItemChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
    },
  },
}));
