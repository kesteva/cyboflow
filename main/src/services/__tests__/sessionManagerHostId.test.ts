/**
 * Environments (M2-C1): SessionManager.createSession's trailing `{ hostId }` option persists to sessions.host_id
 * through the real DatabaseService INSERT. Local (absent / null / 'local') stamps the canonical NULL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../panelManager', () => ({
  panelManager: {
    ensureDiffPanel: vi.fn().mockResolvedValue(undefined),
    getPanelsForSession: vi.fn().mockReturnValue([]),
  },
}));
vi.mock('../../ipc/logs', () => ({ addSessionLog: vi.fn(), cleanupSessionLogs: vi.fn() }));

import { SessionManager } from '../sessionManager';
import { DatabaseService } from '../../database/database';

describe('SessionManager.createSession — host_id stamp (M2-C1)', () => {
  let tmpDir: string;
  let svc: DatabaseService | null = null;

  afterEach(() => {
    svc?.close();
    svc = null;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(): { mgr: SessionManager; projectId: number; hostIdOf: (id: string) => string | null } {
    tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-session-host-'));
    svc = new DatabaseService(join(tmpDir, 'test.db'));
    svc.setMigrationsDirForTesting(join(__dirname, '../../database/migrations'));
    svc.initialize();
    const db = svc.getDb();
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO projects (name, path, active) VALUES ('p', '/tmp/p-host', 1)").run();
    const { id: projectId } = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: number };
    const hostIdOf = (id: string) =>
      (db.prepare('SELECT host_id FROM sessions WHERE id = ?').get(id) as { host_id: string | null }).host_id;
    return { mgr: new SessionManager(svc), projectId, hostIdOf };
  }

  const create = (mgr: SessionManager, projectId: number, name: string, options?: { hostId?: string | null }) =>
    mgr.createSession(name, `/tmp/wt/${name}`, '', name, undefined, projectId, false, 'claude', undefined, undefined,
      false, undefined, undefined, undefined, options);

  it('a remote hostId is persisted and projected', async () => {
    const { mgr, projectId, hostIdOf } = setup();
    const session = await create(mgr, projectId, 'remote-one', { hostId: 'h-ssh' });
    expect(hostIdOf(session.id)).toBe('h-ssh');
    expect(session.hostId).toBe('h-ssh');
  });

  it("local (no options / null / 'local') stamps NULL", async () => {
    const { mgr, projectId, hostIdOf } = setup();
    const a = await create(mgr, projectId, 'local-a');
    const b = await create(mgr, projectId, 'local-b', { hostId: null });
    const c = await create(mgr, projectId, 'local-c', { hostId: 'local' });
    expect([hostIdOf(a.id), hostIdOf(b.id), hostIdOf(c.id)]).toEqual([null, null, null]);
    expect(a.hostId).toBeNull();
  });
});
