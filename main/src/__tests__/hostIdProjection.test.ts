import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database/database';
import { join } from 'node:path';
import { SessionManager } from '../services/sessionManager';
import type { Session } from '../types/session';

vi.mock('../services/panelManager', () => ({
  panelManager: {
    ensureDiffPanel: vi.fn().mockResolvedValue(undefined),
    getPanelsForSession: vi.fn().mockReturnValue([]),
  },
}));
vi.mock('../ipc/logs', () => ({ addSessionLog: vi.fn(), cleanupSessionLogs: vi.fn() }));

function convertDbSessionToSession(row: DbSession): Session {
  const mgr = new SessionManager({} as unknown as ConstructorParameters<typeof SessionManager>[0]);
  return (mgr as unknown as { convertDbSessionToSession(r: DbSession): Session }).convertDbSessionToSession(row);
}
import { listRunsHandler } from '../orchestrator/runQueries';
import { dbAdapter } from '../orchestrator/__test_fixtures__/dbAdapter';
import type { Session as DbSession } from '../database/models';

describe('host_id projection parity (migration 152)', () => {
  it('convertDbSessionToSession projects sessions.host_id to hostId', () => {
    const base = { id: 's1', name: 'n', status: 'pending', created_at: '2026-01-01T00:00:00Z' } as unknown as DbSession;
    expect(convertDbSessionToSession({ ...base, host_id: 'h-1' }).hostId).toBe('h-1');
    expect(convertDbSessionToSession(base).hostId).toBeNull();
  });

  it('listRunsHandler surfaces workflow_runs.host_id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-hostid-'));
    const svc = new DatabaseService(join(dir, 'test.db'));
    try {
      svc.initialize();
      const db = svc.getDb();
      db.pragma('foreign_keys = OFF');
      db.prepare(`INSERT INTO workflows (id, name, spec_json, project_id) VALUES ('w1','w','{}',7)`).run();
      db.prepare(`INSERT INTO workflow_runs (id, workflow_id, project_id, host_id) VALUES ('r1','w1',7,'local')`).run();
      db.prepare(`INSERT INTO workflow_runs (id, workflow_id, project_id) VALUES ('r2','w1',7)`).run();
      const byId = new Map(listRunsHandler(dbAdapter(db), 7).map((r) => [r.id, r]));
      expect(byId.get('r1')?.host_id).toBe('local');
      expect(byId.get('r2')?.host_id).toBeNull();
    } finally {
      try { svc.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
