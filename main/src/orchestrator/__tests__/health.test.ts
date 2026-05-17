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
  it('returns the status from the lifecycle getStatus()', () => {
    const lifecycle = makeLifecycleStub('running');
    const health = new OrchestratorHealth(
      lifecycle as unknown as ConstructorParameters<typeof OrchestratorHealth>[0],
    );

    const result = health.getMcpServerStatus();

    expect(result.status).toBe('running');
    expect(lifecycle.getStatus).toHaveBeenCalledOnce();
  });

  it('returns status: starting when lifecycle status is starting', () => {
    const lifecycle = makeLifecycleStub('starting');
    const health = new OrchestratorHealth(
      lifecycle as unknown as ConstructorParameters<typeof OrchestratorHealth>[0],
    );

    expect(health.getMcpServerStatus().status).toBe('starting');
  });

  it('returns status: failed when lifecycle status is failed', () => {
    const lifecycle = makeLifecycleStub('failed');
    const health = new OrchestratorHealth(
      lifecycle as unknown as ConstructorParameters<typeof OrchestratorHealth>[0],
    );

    expect(health.getMcpServerStatus().status).toBe('failed');
  });

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
