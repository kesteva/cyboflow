/**
 * Retired panel types (Crystal's 'dashboard' and 'setup-tasks') are never
 * listed by the DatabaseService panel reads. Older databases can still hold
 * these rows, flagged `permanent`; surfacing them would hand the renderer an
 * un-closable "Unknown Panel Type" tab, so getPanelsForSession, getAllPanels,
 * getActivePanels and getActivePanel all skip them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

let tmpDir: string;
let db: DatabaseService;
const sessionId = 'session-1';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-retired-panels-'));
  db = new DatabaseService(join(tmpDir, 'test.db'));
  db.initialize();
  const projectId = db.createProject('Proj', join(tmpDir, 'repo')).id;
  db.createSession({
    id: sessionId,
    name: 'Session 1',
    initial_prompt: 'do the thing',
    worktree_name: 'wt-1',
    worktree_path: join(tmpDir, 'wt-1'),
    project_id: projectId,
  });
  const permanent = { createdAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T00:00:00Z', position: 0, permanent: true };
  db.createPanel({ id: 'legacy-dashboard', sessionId, type: 'dashboard', title: 'Dashboard', metadata: permanent });
  db.createPanel({ id: 'legacy-setup', sessionId, type: 'setup-tasks', title: 'Setup', metadata: permanent });
  db.createPanel({ id: 'terminal-1', sessionId, type: 'terminal', title: 'Terminal 1' });
});

afterEach(() => {
  db.getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('retired panel types are not listed', () => {
  it('getPanelsForSession returns only live panel types', () => {
    expect(db.getPanelsForSession(sessionId).map((p) => p.id)).toEqual(['terminal-1']);
  });

  it('getAllPanels returns only live panel types', () => {
    expect(db.getAllPanels().map((p) => p.id)).toEqual(['terminal-1']);
  });

  it('getActivePanels returns only live panel types', () => {
    expect(db.getActivePanels().map((p) => p.id)).toEqual(['terminal-1']);
  });

  it('getActivePanel returns null when the stored active panel is a retired type', () => {
    db.setActivePanel(sessionId, 'legacy-dashboard');
    expect(db.getActivePanel(sessionId)).toBeNull();

    db.setActivePanel(sessionId, 'terminal-1');
    expect(db.getActivePanel(sessionId)?.id).toBe('terminal-1');
  });

  it('leaves the retired rows in place (no destructive cleanup)', () => {
    const count = db
      .getDb()
      .prepare("SELECT COUNT(*) AS n FROM tool_panels WHERE type IN ('dashboard', 'setup-tasks')")
      .get() as { n: number };
    expect(count.n).toBe(2);
  });
});
