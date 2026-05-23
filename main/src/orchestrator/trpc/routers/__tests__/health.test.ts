/**
 * Unit tests for the tRPC health sub-router (main/src/orchestrator/trpc/routers/health.ts).
 *
 * Behaviors covered (per TASK-620 acceptance criteria):
 *
 *   1. health.mcpServer falls back to HEALTH_STARTING when no provider has been
 *      injected via setHealthProvider.
 *   2. health.mcpServer delegates to OrchestratorHealth.getMcpServerStatus() after
 *      setHealthProvider has been called.
 *
 * Each test uses vi.resetModules() + dynamic import to get a fresh module state
 * (the health router uses a module-level singleton `_health`). This prevents
 * state from one test bleeding into another.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestratorHealth } from '../../../health';

// ---------------------------------------------------------------------------
// Reset module-level singleton between tests so injection state is isolated.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cyboflow.health.mcpServer — fallback', () => {
  it('returns HEALTH_STARTING when no provider has been injected', async () => {
    // Fresh module state: _health is null.
    const { appRouter } = await import('../../router');
    const { createContext } = await import('../../context');
    const { HEALTH_STARTING } = await import('../../../../../../shared/types/mcpHealth');

    const caller = appRouter.createCaller(createContext());
    const result = await caller.cyboflow.health.mcpServer();

    expect(result).toEqual(HEALTH_STARTING);
    expect(result.status).toBe('starting');
    expect(result.restartAttempts).toBe(0);
  });
});

describe('cyboflow.health.mcpServer — setHealthProvider delegation', () => {
  it('delegates to OrchestratorHealth.getMcpServerStatus() after setHealthProvider', async () => {
    // Fresh module state for each test.
    const { appRouter } = await import('../../router');
    const { createContext } = await import('../../context');
    const { setHealthProvider } = await import('../health');

    const mockStatus = { status: 'running' as const, restartAttempts: 2, lastError: undefined };
    const mockHealth: Pick<OrchestratorHealth, 'getMcpServerStatus'> = {
      getMcpServerStatus: vi.fn(() => mockStatus),
    };

    setHealthProvider(mockHealth as OrchestratorHealth);

    const caller = appRouter.createCaller(createContext());
    const result = await caller.cyboflow.health.mcpServer();

    expect(result).toEqual(mockStatus);
    expect(mockHealth.getMcpServerStatus).toHaveBeenCalledOnce();
  });
});
