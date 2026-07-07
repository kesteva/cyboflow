/**
 * Unit tests for monitorRehydration.ts — the lazy monitor-revival seam consumed
 * by the tRPC monitor router (trpc/routers/monitor.ts's `setMonitorRehydrator`)
 * on a `MonitorRegistry` miss after an app restart.
 *
 * Covers the refusal matrix (not found / wrong substrate / wrong execution_model
 * / missing worktree_path — each returns null and registers nothing), the
 * success path (registers + returns a session built from the DB row's
 * MonitorContext values), and the injectEvent seam (ensureInjectBridge null OR
 * throwing both degrade to an undefined injectEvent + a logged warning, never a
 * failed rehydration).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMonitorRehydrator } from '../monitorRehydration';
import { MonitorRegistry, type MonitorContext, type MonitorSession } from '../monitor';
import type { DatabaseLike, PreparedStatement, LoggerLike } from '../../types';
import type { ClaudeStreamEvent } from '../../../../../shared/types/claudeStream';

beforeEach(() => {
  MonitorRegistry._resetForTesting();
});

/** A canned-row fake DatabaseLike: `.prepare(sql).get(id)` always returns `row`, ignoring SQL text. */
function fakeDb(row: Record<string, unknown> | undefined): DatabaseLike {
  return {
    prepare: (_sql: string): PreparedStatement => ({
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => row,
      all: () => [],
    }),
    transaction: <T>(fn: (...args: unknown[]) => T) => fn,
  };
}

/** A minimal faked MonitorSession (no SDK). */
function fakeSession(): MonitorSession {
  return {
    triage: vi.fn().mockResolvedValue({ decision: 'escalate', rationale: '' }),
    answer: vi.fn().mockResolvedValue('answer'),
  };
}

function fakeLogger(): LoggerLike & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** A row shaped exactly like the workflow_runs JOIN workflows SELECT, eligible for rehydration. */
const ELIGIBLE_ROW = {
  projectId: 7,
  worktreePath: '/wt/run-1',
  substrate: 'sdk',
  executionModel: 'programmatic',
  workflowName: 'planner',
};

describe('createMonitorRehydrator — refusal matrix', () => {
  it('returns null and registers nothing when no workflow_runs row exists (unknown/dismissed run)', () => {
    const buildSession = vi.fn();
    const rehydrator = createMonitorRehydrator({
      db: fakeDb(undefined),
      ensureInjectBridge: () => null,
      buildSession,
    });

    expect(rehydrator.rehydrate('run-1')).toBeNull();
    expect(buildSession).not.toHaveBeenCalled();
    expect(MonitorRegistry.getInstance().get('run-1')).toBeUndefined();
  });

  it('returns null when the run substrate is not sdk', () => {
    const buildSession = vi.fn();
    const rehydrator = createMonitorRehydrator({
      db: fakeDb({ ...ELIGIBLE_ROW, substrate: 'interactive' }),
      ensureInjectBridge: () => null,
      buildSession,
    });

    expect(rehydrator.rehydrate('run-1')).toBeNull();
    expect(buildSession).not.toHaveBeenCalled();
    expect(MonitorRegistry.getInstance().get('run-1')).toBeUndefined();
  });

  it('returns null when the execution_model is not programmatic (orchestrated runs have no monitor)', () => {
    const buildSession = vi.fn();
    const rehydrator = createMonitorRehydrator({
      db: fakeDb({ ...ELIGIBLE_ROW, executionModel: 'orchestrated' }),
      ensureInjectBridge: () => null,
      buildSession,
    });

    expect(rehydrator.rehydrate('run-1')).toBeNull();
    expect(buildSession).not.toHaveBeenCalled();
    expect(MonitorRegistry.getInstance().get('run-1')).toBeUndefined();
  });

  it('returns null when worktree_path is missing (defensive — MonitorContext requires a string)', () => {
    const buildSession = vi.fn();
    const rehydrator = createMonitorRehydrator({
      db: fakeDb({ ...ELIGIBLE_ROW, worktreePath: null }),
      ensureInjectBridge: () => null,
      buildSession,
    });

    expect(rehydrator.rehydrate('run-1')).toBeNull();
    expect(buildSession).not.toHaveBeenCalled();
    expect(MonitorRegistry.getInstance().get('run-1')).toBeUndefined();
  });

  it('is eligible regardless of run status — chat-at-rest is the point (not part of the refusal matrix)', () => {
    // The SELECT deliberately never reads `status`; any status column value on
    // an otherwise-eligible row must not affect the outcome.
    const buildSession = vi.fn().mockReturnValue(fakeSession());
    const rehydrator = createMonitorRehydrator({
      db: fakeDb({ ...ELIGIBLE_ROW, status: 'failed' }),
      ensureInjectBridge: () => null,
      buildSession,
    });

    expect(rehydrator.rehydrate('run-1')).not.toBeNull();
    expect(buildSession).toHaveBeenCalledTimes(1);
  });
});

describe('createMonitorRehydrator — success path', () => {
  it('registers + returns the session, calling buildSession with the DB-derived MonitorContext', () => {
    const session = fakeSession();
    const buildSession = vi.fn().mockReturnValue(session);
    const injectFn: (event: ClaudeStreamEvent) => void = vi.fn();
    const rehydrator = createMonitorRehydrator({
      db: fakeDb(ELIGIBLE_ROW),
      ensureInjectBridge: () => injectFn,
      buildSession,
    });

    const result = rehydrator.rehydrate('run-1');

    expect(result).toBe(session);
    expect(buildSession).toHaveBeenCalledTimes(1);
    const [ctx, injectEvent] = buildSession.mock.calls[0] as [MonitorContext, unknown];
    expect(ctx).toEqual({
      runId: 'run-1',
      projectId: 7,
      workflowName: 'planner',
      worktreePath: '/wt/run-1',
    });
    expect(injectEvent).toBe(injectFn);
    expect(MonitorRegistry.getInstance().get('run-1')).toBe(session);
  });

  it('passes undefined injectEvent + logs a warning when ensureInjectBridge returns null (session still built)', () => {
    const session = fakeSession();
    const buildSession = vi.fn().mockReturnValue(session);
    const logger = fakeLogger();
    const rehydrator = createMonitorRehydrator({
      db: fakeDb(ELIGIBLE_ROW),
      ensureInjectBridge: () => null,
      buildSession,
      logger,
    });

    const result = rehydrator.rehydrate('run-1');

    expect(result).toBe(session);
    const [, injectEvent] = buildSession.mock.calls[0] as [MonitorContext, unknown];
    expect(injectEvent).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no inject bridge available'),
      expect.objectContaining({ runId: 'run-1' }),
    );
    expect(MonitorRegistry.getInstance().get('run-1')).toBe(session);
  });

  it('degrades to undefined injectEvent + logs a warning when ensureInjectBridge throws (fail-soft, still rehydrates)', () => {
    const session = fakeSession();
    const buildSession = vi.fn().mockReturnValue(session);
    const logger = fakeLogger();
    const rehydrator = createMonitorRehydrator({
      db: fakeDb(ELIGIBLE_ROW),
      ensureInjectBridge: () => {
        throw new Error('bridge construction boom');
      },
      buildSession,
      logger,
    });

    const result = rehydrator.rehydrate('run-1');

    expect(result).toBe(session);
    const [, injectEvent] = buildSession.mock.calls[0] as [MonitorContext, unknown];
    expect(injectEvent).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ensureInjectBridge threw'),
      expect.objectContaining({ runId: 'run-1', error: 'bridge construction boom' }),
    );
    expect(MonitorRegistry.getInstance().get('run-1')).toBe(session);
  });
});
