/**
 * Tests for cyboflow.omp.fleetSnapshot — the redacted read surface.
 *
 * Verifies the DTO boundary: a full snapshot carrying sentinel secrets in
 * task/lastOutput/repoPath/allowedPaths/failure output is projected down to
 * summary fields only before crossing the tRPC reply. Typecheck alone cannot
 * prove redaction; this test asserts the sentinels are absent and the summary
 * fields are present.
 */
import { describe, it, expect } from 'vitest';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { OmpControlPlaneAdapter, RegistrySnapshot, WorkerEntry } from '../../../../../../shared/types/omp';
import { OMP_SUPERVISE_CAPABILITY } from '../../../../../../shared/types/ompCommand';

const SENTINEL = 'SENTINEL_SECRET_DO_NOT_CROSS_IPC';

function fullWorker(): WorkerEntry {
  return {
    id: 'wkr-1',
    paneId: 'p1',
    workspaceId: 'ws-1',
    backend: 'subprocess',
    model: 'zai/glm-5.2:high',
    task: `deploy ${SENTINEL}`,
    label: 'a-label',
    status: 'working',
    spawnedAt: '2026-08-13T00:00:00.000Z',
    lastSeenAt: '2026-08-13T00:01:00.000Z',
    leaseExpiresAt: '2026-08-13T00:10:00.000Z',
    lastOutput: `stdout: ${SENTINEL}`,
    repoPath: `/repos/${SENTINEL}`,
    allowedPaths: [`/src/${SENTINEL}.ts`],
    failureReport: {
      state: 'pending',
      idempotencyKey: 'k',
      transitionStatus: 'failed',
      output: `failure ${SENTINEL}`,
    },
  };
}

const adapter: OmpControlPlaneAdapter = {
  version: 1,
  authority: 'read',
  async getFleetSnapshot() {
    const snapshot: RegistrySnapshot = {
      version: 1,
      savedAt: '2026-08-13T00:02:00.000Z',
      workers: [fullWorker()],
    };
    return { ok: true, snapshot };
  },
};

describe('cyboflow.omp.fleetSnapshot redaction', () => {
  it('projects a full snapshot down to summary fields only (no secrets cross the boundary)', async () => {
    const caller = appRouter.createCaller(createContext({ omp: adapter }));
    const res = await caller.cyboflow.omp.fleetSnapshot();

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');

    const wire = JSON.stringify(res);

    // Summary fields present.
    expect(res.snapshot.totalWorkers).toBe(1);
    expect(res.snapshot.workers[0]).toEqual({
      id: 'wkr-1',
      label: 'a-label',
      model: 'zai/glm-5.2:high',
      status: 'working',
      backend: 'subprocess',
      spawnedAt: '2026-08-13T00:00:00.000Z',
      lastSeenAt: '2026-08-13T00:01:00.000Z',
    });

    // Secret-bearing fields absent from the wire.
    expect(wire).not.toContain(SENTINEL);
    expect(wire).not.toContain('task');
    expect(wire).not.toContain('lastOutput');
    expect(wire).not.toContain('repoPath');
    expect(wire).not.toContain('allowedPaths');
    expect(wire).not.toContain('failureReport');
    expect(wire).not.toContain('paneId');
  });

  it('surfaces unavailable when no adapter is configured', async () => {
    const caller = appRouter.createCaller(createContext({}));
    const res = await caller.cyboflow.omp.fleetSnapshot();
    expect(res).toMatchObject({ ok: false, error: 'unavailable' });
  });
});

/**
 * cyboflow.omp.availability — what the picker may offer.
 *
 * Two independent axes, and the router must not collapse them: `launchable`
 * asks whether a remote worker can be spawned RIGHT NOW (boot-built manager +
 * supervise capability), `ariaMode` says which OMP flavor this install runs.
 * A toggle flipped without a relaunch is exactly the state where they disagree.
 */
describe('cyboflow.omp.availability', () => {
  const supervising = {
    userId: 'local',
    capabilities: new Set([OMP_SUPERVISE_CAPABILITY]),
  };
  const unprivileged = { userId: 'local', capabilities: new Set<string>() };

  async function query(deps: Parameters<typeof createContext>[0]) {
    return appRouter.createCaller(createContext(deps)).cyboflow.omp.availability();
  }

  it('reports launchable only when the manager exists AND the principal supervises', async () => {
    expect(
      await query({ principal: supervising, ompFleetLaunchable: () => true, ompAriaMode: () => true }),
    ).toEqual({ launchable: true, ariaMode: true });

    // Manager absent (Aria mode on, but the app has not relaunched yet).
    expect(
      await query({ principal: supervising, ompFleetLaunchable: () => false, ompAriaMode: () => true }),
    ).toEqual({ launchable: false, ariaMode: true });

    // Capability revoked while a manager from an earlier boot still exists.
    expect(
      await query({ principal: unprivileged, ompFleetLaunchable: () => true, ompAriaMode: () => true }),
    ).toEqual({ launchable: false, ariaMode: true });
  });

  it('reports ariaMode independently of launchability', async () => {
    // A local-OMP install: not a fleet, and that is not a failure.
    expect(
      await query({ principal: unprivileged, ompFleetLaunchable: () => false, ompAriaMode: () => false }),
    ).toEqual({ launchable: false, ariaMode: false });
  });

  it('floors both to false when nothing is wired (fail closed)', async () => {
    expect(await query({})).toEqual({ launchable: false, ariaMode: false });
  });
});
