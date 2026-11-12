/**
 * Unit tests for the tRPC dynamicWorkflows sub-router
 * (main/src/orchestrator/trpc/routers/dynamicWorkflows.ts).
 *
 * Behaviors covered:
 *
 *   1. dynamicWorkflows.list returns [] when the DynamicWorkflowTracker
 *      singleton has not been initialized (fail-soft fallback).
 *   2. dynamicWorkflows.list accepts an optional sessionId filter without
 *      throwing when the tracker is uninitialized.
 *
 * Each test uses vi.resetModules() + dynamic import to get fresh module state
 * (DynamicWorkflowTracker is a module-level singleton). This prevents state
 * from one test bleeding into another.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Reset module-level singleton between tests so tracker state is isolated.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cyboflow.dynamicWorkflows.list — uninitialized-tracker fallback', () => {
  it.each([{}, { sessionId: 'session-1' }])(
    'returns [] when DynamicWorkflowTracker has not been initialized (input %j)',
    async (input) => {
      // Fresh module state: tryGetInstance() returns null.
      const { appRouter } = await import('../../router');
      const { createContext } = await import('../../context');

      const caller = appRouter.createCaller(createContext());
      const result = await caller.cyboflow.dynamicWorkflows.list(input);

      expect(result).toEqual([]);
    },
  );
});
