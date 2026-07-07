/**
 * Unit tests for the tRPC monitor sub-router
 * (main/src/orchestrator/trpc/routers/monitor.ts — the monitor-unify refactor's
 * tRPC contract, replacing the old supervisorChat router).
 *
 * Behaviors covered:
 *   isActive    — { active:false } with no registered monitor; { active:true } once a
 *                 session is registered for the run.
 *   send        — { delivered:false } with no monitor; { delivered:true } + drives the
 *                 session's `converse` (inject→answer→inject orchestration) when active;
 *                 falls back to `answer` for a session predating `converse`.
 *   stepResults — [] when the StepResultStore singleton is uninitialized.
 *
 * The MonitorRegistry + StepResultStore singletons are reset before each test so
 * registration state never bleeds across cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { MonitorRegistry, type MonitorSession } from '../../../programmatic/monitor';
import { StepResultStore } from '../../../stepResultStore';
import { setMonitorRehydrator, _resetMonitorRehydratorForTesting } from '../monitor';

beforeEach(() => {
  MonitorRegistry._resetForTesting();
  StepResultStore._resetForTesting();
});

afterEach(() => {
  _resetMonitorRehydratorForTesting();
});

/** A fully-faked monitor session (no SDK) with a `converse` that records its calls. */
function makeMonitorSession(): MonitorSession & {
  converse: ReturnType<typeof vi.fn>;
  answer: ReturnType<typeof vi.fn>;
  triage: ReturnType<typeof vi.fn>;
} {
  return {
    triage: vi.fn().mockResolvedValue({ decision: 'escalate', rationale: '' }),
    answer: vi.fn().mockResolvedValue('answered'),
    converse: vi.fn().mockResolvedValue('reply text'),
  };
}

describe('cyboflow.monitor.isActive', () => {
  it('returns { active: false } when no monitor is registered for the run', async () => {
    const caller = appRouter.createCaller(createContext());
    const result = await caller.cyboflow.monitor.isActive({ runId: 'run-1' });
    expect(result).toEqual({ active: false });
  });

  it('returns { active: true } once a monitor session is registered for the run', async () => {
    MonitorRegistry.getInstance().register('run-1', makeMonitorSession());
    const caller = appRouter.createCaller(createContext());
    const result = await caller.cyboflow.monitor.isActive({ runId: 'run-1' });
    expect(result).toEqual({ active: true });
  });

  it('is run-scoped: a monitor on one run does not mark another run active', async () => {
    MonitorRegistry.getInstance().register('run-1', makeMonitorSession());
    const caller = appRouter.createCaller(createContext());
    expect(await caller.cyboflow.monitor.isActive({ runId: 'run-2' })).toEqual({ active: false });
  });
});

describe('cyboflow.monitor.send', () => {
  it('returns { delivered: false } and consults nothing when no monitor is active', async () => {
    const caller = appRouter.createCaller(createContext());
    const result = await caller.cyboflow.monitor.send({ runId: 'run-1', text: 'hello' });
    expect(result).toEqual({ delivered: false });
  });

  it('drives the session converse (inject→answer→inject) and returns { delivered: true }', async () => {
    const session = makeMonitorSession();
    MonitorRegistry.getInstance().register('run-1', session);
    const caller = appRouter.createCaller(createContext());

    const result = await caller.cyboflow.monitor.send({ runId: 'run-1', text: 'why did it fail?' });

    expect(result).toEqual({ delivered: true });
    // The router delegates the whole exchange to `converse` (it owns the render
    // orchestration) — `answer` is NOT called directly when `converse` is present.
    expect(session.converse).toHaveBeenCalledWith('why did it fail?');
    expect(session.answer).not.toHaveBeenCalled();
  });

  it('falls back to answer for a session that predates converse (still delivers)', async () => {
    const session: MonitorSession = {
      triage: vi.fn().mockResolvedValue({ decision: 'escalate', rationale: '' }),
      answer: vi.fn().mockResolvedValue('bare answer'),
      // no converse
    };
    MonitorRegistry.getInstance().register('run-1', session);
    const caller = appRouter.createCaller(createContext());

    const result = await caller.cyboflow.monitor.send({ runId: 'run-1', text: 'ping' });

    expect(result).toEqual({ delivered: true });
    expect(session.answer).toHaveBeenCalledWith('ping');
  });
});

describe('cyboflow.monitor.stepResults', () => {
  it('returns [] when the StepResultStore singleton is uninitialized', async () => {
    const caller = appRouter.createCaller(createContext());
    const result = await caller.cyboflow.monitor.stepResults({ runId: 'run-1' });
    expect(result).toEqual([]);
  });
});

describe('lazy monitor rehydration (setMonitorRehydrator)', () => {
  it('isActive rehydrates on a registry miss when the rehydrator revives a session', async () => {
    const session = makeMonitorSession();
    setMonitorRehydrator({ rehydrate: vi.fn().mockReturnValue(session) });
    const caller = appRouter.createCaller(createContext());

    const result = await caller.cyboflow.monitor.isActive({ runId: 'run-1' });

    expect(result).toEqual({ active: true });
  });

  it('send rehydrates on a registry miss and delivers to the revived session', async () => {
    const session = makeMonitorSession();
    const rehydrate = vi.fn().mockReturnValue(session);
    setMonitorRehydrator({ rehydrate });
    const caller = appRouter.createCaller(createContext());

    const result = await caller.cyboflow.monitor.send({ runId: 'run-1', text: 'still there?' });

    expect(result).toEqual({ delivered: true });
    expect(rehydrate).toHaveBeenCalledWith('run-1');
    expect(session.converse).toHaveBeenCalledWith('still there?');
  });

  it('an unset rehydrator preserves legacy miss behavior ({active:false} / {delivered:false})', async () => {
    // No setMonitorRehydrator call in this test — the module-level rehydrator
    // stays null (afterEach also resets it defensively between tests).
    const caller = appRouter.createCaller(createContext());

    expect(await caller.cyboflow.monitor.isActive({ runId: 'run-1' })).toEqual({ active: false });
    expect(await caller.cyboflow.monitor.send({ runId: 'run-1', text: 'hi' })).toEqual({ delivered: false });
  });

  it('a rehydrator that refuses (returns null) preserves legacy miss behavior', async () => {
    setMonitorRehydrator({ rehydrate: vi.fn().mockReturnValue(null) });
    const caller = appRouter.createCaller(createContext());

    expect(await caller.cyboflow.monitor.isActive({ runId: 'run-1' })).toEqual({ active: false });
    expect(await caller.cyboflow.monitor.send({ runId: 'run-1', text: 'hi' })).toEqual({ delivered: false });
  });

  it('a throwing rehydrator is fail-soft: treated as a miss, never surfaces to the caller', async () => {
    setMonitorRehydrator({
      rehydrate: vi.fn().mockImplementation(() => {
        throw new Error('rehydration boom');
      }),
    });
    const caller = appRouter.createCaller(createContext());

    await expect(caller.cyboflow.monitor.isActive({ runId: 'run-1' })).resolves.toEqual({ active: false });
    await expect(caller.cyboflow.monitor.send({ runId: 'run-1', text: 'hi' })).resolves.toEqual({
      delivered: false,
    });
  });

  it('does not consult the rehydrator when the registry already has a live session', async () => {
    MonitorRegistry.getInstance().register('run-1', makeMonitorSession());
    const rehydrate = vi.fn();
    setMonitorRehydrator({ rehydrate });
    const caller = appRouter.createCaller(createContext());

    expect(await caller.cyboflow.monitor.isActive({ runId: 'run-1' })).toEqual({ active: true });
    expect(rehydrate).not.toHaveBeenCalled();
  });
});
