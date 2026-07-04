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
      // A/B testing (migration 046) — VariantSelector / VariantManagerSection
      // fetch this for the selected workflow. Empty by default so either renders
      // its "nothing to show" state without any test file needing its own mock.
      variants: {
        list: { query: vi.fn().mockResolvedValue([]) },
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
    },
  },
}));
