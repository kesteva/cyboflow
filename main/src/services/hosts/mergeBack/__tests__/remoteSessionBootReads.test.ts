/** remoteSessionBootReads over the REAL migration chain (DatabaseService.initialize). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../../database/database';
import { makeDatabaseLike } from '../../../../orchestrator/loggerAdapter';
import { findHalfProvisionedRemoteSessions, remoteResumeReads } from '../remoteSessionBootReads';

const NOW = '2026-10-22T12:00:00.000Z';
let dir: string;
let svc: DatabaseService;
let projectId: number;

function session(id: string, opts: { hostId?: string | null; runId?: string } = {}): void {
  svc.createSession({
    id, name: id, initial_prompt: '', worktree_name: id, worktree_path: `/remote/wt/${id}`, project_id: projectId,
    host_id: opts.hostId === undefined ? 'h-ssh' : opts.hostId, ...(opts.runId ? { run_id: opts.runId } : {}),
  });
}

function mergeBackRow(id: string, state: string): void {
  svc.getDb().prepare(
    `INSERT INTO session_merge_backs (session_id, host_id, project_id, merge_key, branch, state, created_at, updated_at)
     VALUES (?, 'h-ssh', ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, id, id, state, NOW, NOW);
}

function run(id: string, sessionId: string, createdAt: string): void {
  svc.getDb().prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, session_id, created_at, updated_at)
     VALUES (?, (SELECT id FROM workflows LIMIT 1), ?, 'completed', ?, ?, ?)`,
  ).run(id, projectId, sessionId, createdAt, createdAt);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cyboflow-remote-boot-'));
  svc = new DatabaseService(join(dir, 'test.db'));
  svc.initialize();
  svc.getDb().prepare(
    `INSERT INTO hosts (id, label, kind, config_json, detected_tier, lifecycle_state, created_at, updated_at)
     VALUES ('h-ssh', 'Studio', 'ssh', '{}', 'full', 'online', ?, ?)`,
  ).run(NOW, NOW);
  svc.getDb().prepare(`INSERT OR IGNORE INTO workflows (id, name) VALUES ('wf-test', 'wf-test')`).run();
  projectId = svc.createProject('p', join(dir, 'repo')).id;
});

afterEach(() => {
  try { svc.close(); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('findHalfProvisionedRemoteSessions (LC-4)', () => {
  it('finds remote sessions with no row or a bare_ready / base_pushed row and no run — nothing else', () => {
    session('no-row');
    session('bare'); mergeBackRow('bare', 'bare_ready');
    session('pushed'); mergeBackRow('pushed', 'base_pushed');
    session('ready'); mergeBackRow('ready', 'remote_ready'); // finished provisioning: never touched
    session('merged'); mergeBackRow('merged', 'merged');
    session('with-run'); mergeBackRow('with-run', 'bare_ready'); run('run-1', 'with-run', '2026-10-22 11:00:00');
    session('linked'); mergeBackRow('linked', 'bare_ready');
    svc.getDb().prepare(`UPDATE sessions SET chat_run_id = '__quick__x' WHERE id = 'linked'`).run();
    session('local', { hostId: null });
    session('gone'); mergeBackRow('gone', 'bare_ready'); svc.archiveSession('gone');

    expect(findHalfProvisionedRemoteSessions(makeDatabaseLike(svc))).toEqual(['bare', 'no-row', 'pushed']);
  });
});

describe('remoteResumeReads', () => {
  it('isArchived: archived or missing sessions; runsCreatedSince: runs strictly after an ISO instant', () => {
    session('live');
    session('dismissed');
    svc.archiveSession('dismissed');
    run('before', 'live', '2026-10-22 11:59:59');
    run('after-sqlite', 'live', '2026-10-22 12:00:01');
    run('after-iso', 'live', '2026-10-22T12:30:00.000Z');
    const reads = remoteResumeReads(makeDatabaseLike(svc));
    expect(reads.isArchived('live')).toBe(false);
    expect(reads.isArchived('dismissed')).toBe(true);
    expect(reads.isArchived('nope')).toBe(true);
    expect(reads.runsCreatedSince('live', NOW)).toBe(2);
    expect(reads.runsCreatedSince('live', '2026-10-22T13:00:00.000Z')).toBe(0);
  });
});
