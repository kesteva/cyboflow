/**
 * Unit tests for OrchestratorHealth (main/src/orchestrator/health.ts).
 *
 * Behaviors covered (per TASK-455 AC1 + test_strategy):
 *
 * 1. getMcpServerStatus() returns a McpServerHealth shaped object reading from
 *    the injected McpServerLifecycle.
 * 2. The status field mirrors whatever getStatus() returns from the lifecycle.
 * 3. restartAttempts mirrors whatever getRestartAttempts() returns.
 * 4. lastError is undefined until setMcpError() is called.
 * 5. After setMcpError(msg), lastError equals msg.
 * 6. A second setMcpError() call overwrites the previous error.
 *
 * McpServerLifecycle is replaced with a lightweight stub so no subprocess or
 * filesystem operations are triggered.
 */
import { describe, it, expect, vi } from 'vitest';
import { OrchestratorHealth } from '../health';
import type { McpServerStatus } from '../mcpServer/mcpServerLifecycle';

// ---------------------------------------------------------------------------
// Stub for McpServerLifecycle
// ---------------------------------------------------------------------------

function makeLifecycleStub(
  status: McpServerStatus = 'starting',
  restartAttempts = 0,
) {
  return {
    getStatus: vi.fn(() => status),
    getRestartAttempts: vi.fn(() => restartAttempts),
    // Other McpServerLifecycle methods are never called by OrchestratorHealth
    start: vi.fn(),
    stop: vi.fn(),
    resolveScriptPath: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrchestratorHealth.getMcpServerStatus()', () => {
  it.each(['running', 'starting', 'failed'] as const)(
    'returns the status from the lifecycle getStatus() (%s)',
    (status) => {
      const lifecycle = makeLifecycleStub(status);
      const health = new OrchestratorHealth(
        lifecycle as unknown as ConstructorParameters<typeof OrchestratorHealth>[0],
      );

      const result = health.getMcpServerStatus();

      expect(result.status).toBe(status);
      expect(lifecycle.getStatus).toHaveBeenCalledOnce();
    },
  );

  it('returns restartAttempts from the lifecycle getRestartAttempts()', () => {
    const lifecycle = makeLifecycleStub('running', 2);
    const health = new OrchestratorHealth(
      lifecycle as unknown as ConstructorParameters<typeof OrchestratorHealth>[0],
    );

    expect(health.getMcpServerStatus().restartAttempts).toBe(2);
    expect(lifecycle.getRestartAttempts).toHaveBeenCalledOnce();
  });

  it('returns lastError: undefined before setMcpError is called', () => {
    const lifecycle = makeLifecycleStub();
    const health = new OrchestratorHealth(
      lifecycle as unknown as ConstructorParameters<typeof OrchestratorHealth>[0],
    );

    expect(health.getMcpServerStatus().lastError).toBeUndefined();
  });

  it('returns lastError equal to the string passed to setMcpError()', () => {
    const lifecycle = makeLifecycleStub('failed');
    const health = new OrchestratorHealth(
      lifecycle as unknown as ConstructorParameters<typeof OrchestratorHealth>[0],
    );

    health.setMcpError('subprocess exited with code 1');

    expect(health.getMcpServerStatus().lastError).toBe('subprocess exited with code 1');
  });

  it('overwrites lastError on a second setMcpError() call', () => {
    const lifecycle = makeLifecycleStub('failed');
    const health = new OrchestratorHealth(
      lifecycle as unknown as ConstructorParameters<typeof OrchestratorHealth>[0],
    );

    health.setMcpError('first error');
    health.setMcpError('second error');

    expect(health.getMcpServerStatus().lastError).toBe('second error');
  });
});

// ---------------------------------------------------------------------------
// Socket-integrity downgrade
//
// The lifecycle only knows the SUBPROCESS is up. When the orch socket path has
// been unlinked or replaced, already-open connections keep working but no new
// subprocess can connect — the state that let a two-day outage report green.
// ---------------------------------------------------------------------------

describe('OrchestratorHealth socket-integrity downgrade', () => {
  const lifecycleArg = (stub: ReturnType<typeof makeLifecycleStub>) =>
    stub as unknown as ConstructorParameters<typeof OrchestratorHealth>[0];

  it('downgrades a running lifecycle to failed when the socket path is gone', () => {
    const lifecycle = makeLifecycleStub('running', 1);
    const health = new OrchestratorHealth(lifecycleArg(lifecycle), {
      isSocketPathIntact: () => false,
    });

    const result = health.getMcpServerStatus();

    expect(result.status).toBe('failed');
    expect(result.lastError).toMatch(/no new MCP subprocess can connect/i);
    // restartAttempts still reports truthfully through the downgrade.
    expect(result.restartAttempts).toBe(1);
  });

  it('leaves a running lifecycle green while the socket path is intact', () => {
    const lifecycle = makeLifecycleStub('running');
    const health = new OrchestratorHealth(lifecycleArg(lifecycle), {
      isSocketPathIntact: () => true,
    });

    const result = health.getMcpServerStatus();

    expect(result.status).toBe('running');
    expect(result.lastError).toBeUndefined();
  });

  it('does not mask a real lifecycle error message when downgrading', () => {
    const lifecycle = makeLifecycleStub('running');
    const health = new OrchestratorHealth(lifecycleArg(lifecycle), {
      isSocketPathIntact: () => false,
    });
    health.setMcpError('subprocess exited with code 1');

    expect(health.getMcpServerStatus().lastError).toBe('subprocess exited with code 1');
  });

  it('never downgrades a starting lifecycle — the socket legitimately does not exist yet', () => {
    const lifecycle = makeLifecycleStub('starting');
    const health = new OrchestratorHealth(lifecycleArg(lifecycle), {
      isSocketPathIntact: () => false,
    });

    expect(health.getMcpServerStatus().status).toBe('starting');
  });

  it('behaves exactly as before when no probe is injected', () => {
    const lifecycle = makeLifecycleStub('running', 3);
    const health = new OrchestratorHealth(lifecycleArg(lifecycle));

    expect(health.getMcpServerStatus()).toEqual({
      status: 'running',
      lastError: undefined,
      restartAttempts: 3,
    });
  });
});
