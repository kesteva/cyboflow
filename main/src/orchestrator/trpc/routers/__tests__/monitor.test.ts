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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { MonitorRegistry, type MonitorSession } from '../../../programmatic/monitor';
import { StepResultStore } from '../../../stepResultStore';

beforeEach(() => {
  MonitorRegistry._resetForTesting();
  StepResultStore._resetForTesting();
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
