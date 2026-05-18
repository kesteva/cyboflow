/**
 * Unit tests for WorkflowRegistry.
 *
 * Behaviors covered (per TASK-351 test_strategy):
 * 1. seed inserts five workflows with correct names
 * 2. seed is idempotent (second call does not duplicate rows)
 * 3. frontmatter permission_mode parsing: present/absent/file-missing cases
 * 4. createRun snapshots permission_mode onto workflow_runs row
 * 5. missing .md file falls back to 'default' and logs WARN
 *
 * All tests use an in-memory better-sqlite3 instance with the workflow tables
 * applied inline — no file I/O for the DB itself.  Workflow .md files are
 * written to temp paths via os.tmpdir() so fs.readFileSync is exercised
 * end-to-end; missing-file tests simply pass a non-existent path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WorkflowRegistry, type WorkflowDescriptor } from '../workflowRegistry';
import type { SoloFlowWorkflowName } from '../../../../shared/types/workflows';
import type { LoggerLike } from '../types';

// ---------------------------------------------------------------------------
// Schema for the two tables this registry owns
// ---------------------------------------------------------------------------

const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL DEFAULT '{}',
  workflow_path TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows(project_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled')),
  permission_mode_snapshot TEXT NOT NULL,
  worktree_path TEXT,
  branch_name TEXT,
  policy_json TEXT,
  stuck_at DATETIME,
  stuck_reason TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  ended_at DATETIME,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a fresh in-memory SQLite database with only the registry tables. */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(REGISTRY_SCHEMA);
  return db;
}

/**
 * Build a DatabaseLike adapter over a better-sqlite3 instance.
 * Mirrors the inline adapter used in main/src/index.ts.
 */
function dbAdapter(db: Database.Database) {
  return {
    prepare: (sql: string) => db.prepare(sql),
    transaction: <T>(fn: (...args: unknown[]) => T) =>
      db.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
  };
}

/** Creates a fake LoggerLike that records calls for assertion. */
function makeLogger(): LoggerLike & { warnCalls: Array<{ message: string; context?: Record<string, unknown> }> } {
  const warnCalls: Array<{ message: string; context?: Record<string, unknown> }> = [];
  return {
    warnCalls,
    info: vi.fn(),
    warn: (message, context) => warnCalls.push({ message, context }),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Write a minimal markdown file with optional frontmatter to a temp dir. */
function writeTempMd(dir: string, filename: string, content: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** Build five workflow descriptors pointing at real temp files. */
function buildDescriptors(
  dir: string,
  overrides: Partial<Record<SoloFlowWorkflowName, string>> = {},
): WorkflowDescriptor[] {
  const names: SoloFlowWorkflowName[] = ['soloflow', 'planner', 'sprint', 'compound', 'prune'];
  return names.map((name) => {
    if (name in overrides) {
      return { name, path: overrides[name]! };
    }
    const content = `---\ndescription: ${name} workflow\n---\n# ${name}\n`;
    const path = writeTempMd(dir, `${name}.md`, content);
    return { name, path };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowRegistry', () => {
  let db: Database.Database;
  let registry: WorkflowRegistry;
  let logger: ReturnType<typeof makeLogger>;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    logger = makeLogger();
    registry = new WorkflowRegistry(dbAdapter(db), logger);
    tmpDir = mkdtempSync(join(tmpdir(), 'workflow-registry-test-'));
  });

  // -------------------------------------------------------------------------
  // seed
  // -------------------------------------------------------------------------

  describe('seed', () => {
    it('inserts five workflows with correct names', () => {
      const descriptors = buildDescriptors(tmpDir);
      registry.seed(1, descriptors);

      interface CountRow { count: number }
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id = 1').get() as CountRow;
      expect(count).toBe(5);

      interface NameRow { name: string }
      const rows = db.prepare('SELECT name FROM workflows WHERE project_id = 1 ORDER BY name').all() as NameRow[];
      const names = rows.map((r) => r.name).sort();
      expect(names).toEqual(['compound', 'planner', 'prune', 'soloflow', 'sprint']);
    });

    it('is idempotent — second seed call does not add duplicate rows', () => {
      const descriptors = buildDescriptors(tmpDir);
      registry.seed(1, descriptors);
      registry.seed(1, descriptors);

      interface CountRow { count: number }
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id = 1').get() as CountRow;
      expect(count).toBe(5);
    });

    it('preserves existing row IDs on re-seed', () => {
      const descriptors = buildDescriptors(tmpDir);
      registry.seed(1, descriptors);

      interface IdNameRow { id: string; name: string }
      const before = db.prepare('SELECT id, name FROM workflows WHERE project_id = 1 ORDER BY id').all() as IdNameRow[];

      registry.seed(1, descriptors);

      const after = db.prepare('SELECT id, name FROM workflows WHERE project_id = 1 ORDER BY id').all() as IdNameRow[];
      expect(after).toEqual(before);
    });

    it('parses permission_mode: acceptEdits from frontmatter', () => {
      const content = `---\ndescription: test\npermission_mode: acceptEdits\n---\n`;
      const path = writeTempMd(tmpDir, 'accepts.md', content);
      registry.seed(1, [{ name: 'soloflow', path }]);

      interface ModeRow { permission_mode: string }
      const row = db.prepare('SELECT permission_mode FROM workflows WHERE name = ?').get('soloflow') as ModeRow;
      expect(row.permission_mode).toBe('acceptEdits');
    });

    it('parses permission_mode: dontAsk from frontmatter', () => {
      const content = `---\ndescription: test\npermission_mode: dontAsk\n---\n`;
      const path = writeTempMd(tmpDir, 'dontask.md', content);
      registry.seed(1, [{ name: 'planner', path }]);

      interface ModeRow { permission_mode: string }
      const row = db.prepare('SELECT permission_mode FROM workflows WHERE name = ?').get('planner') as ModeRow;
      expect(row.permission_mode).toBe('dontAsk');
    });

    it('defaults permission_mode to "default" when key is absent', () => {
      const content = `---\ndescription: test\n---\n`;
      const path = writeTempMd(tmpDir, 'noperm.md', content);
      registry.seed(1, [{ name: 'sprint', path }]);

      interface ModeRow { permission_mode: string }
      const row = db.prepare('SELECT permission_mode FROM workflows WHERE name = ?').get('sprint') as ModeRow;
      expect(row.permission_mode).toBe('default');
    });

    it('missing .md file falls back to permission_mode "default"', () => {
      const nonExistentPath = join(tmpDir, 'does-not-exist.md');
      registry.seed(1, [{ name: 'compound', path: nonExistentPath }]);

      interface ModeRow { permission_mode: string }
      const row = db.prepare('SELECT permission_mode FROM workflows WHERE name = ?').get('compound') as ModeRow;
      expect(row.permission_mode).toBe('default');
    });

    it('missing .md file logs WARN with the path', () => {
      const nonExistentPath = join(tmpDir, 'does-not-exist.md');
      registry.seed(1, [{ name: 'prune', path: nonExistentPath }]);

      expect(logger.warnCalls.length).toBeGreaterThan(0);
      const warnMsg = logger.warnCalls[0].message;
      expect(warnMsg).toContain('could not read workflow file');
      const warnCtx = logger.warnCalls[0].context;
      expect(warnCtx?.path).toBe(nonExistentPath);
    });

    it('missing .md file does not throw and still inserts the row', () => {
      const nonExistentPath = join(tmpDir, 'does-not-exist.md');
      expect(() => registry.seed(1, [{ name: 'prune', path: nonExistentPath }])).not.toThrow();

      interface CountRow { count: number }
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id = 1').get() as CountRow;
      expect(count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getById / listByProject
  // -------------------------------------------------------------------------

  describe('getById', () => {
    it('returns the workflow row by id', () => {
      const descriptors = buildDescriptors(tmpDir);
      registry.seed(1, descriptors);

      interface IdRow { id: string }
      const first = db.prepare('SELECT id FROM workflows WHERE project_id = 1 ORDER BY id LIMIT 1').get() as IdRow;
      const row = registry.getById(first.id);
      expect(row).not.toBeNull();
      expect(row?.id).toBe(first.id);
    });

    it('returns null for an unknown id', () => {
      expect(registry.getById('nonexistent-id')).toBeNull();
    });
  });

  describe('listByProject', () => {
    it('returns all workflows for a project', () => {
      const descriptors = buildDescriptors(tmpDir);
      registry.seed(1, descriptors);
      const rows = registry.listByProject(1);
      expect(rows).toHaveLength(5);
    });

    it('returns empty array for an unknown project', () => {
      expect(registry.listByProject(999)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // createRun
  // -------------------------------------------------------------------------

  describe('createRun', () => {
    it('snapshots permission_mode onto workflow_runs row', () => {
      const content = `---\npermission_mode: acceptEdits\n---\n`;
      const path = writeTempMd(tmpDir, 'accepts2.md', content);
      registry.seed(1, [{ name: 'soloflow', path }]);

      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('soloflow') as IdRow;
      const { runId } = registry.createRun(workflowId);

      interface SnapshotRow { permission_mode_snapshot: string }
      const row = db.prepare('SELECT permission_mode_snapshot FROM workflow_runs WHERE id = ?').get(runId) as SnapshotRow;
      expect(row.permission_mode_snapshot).toBe('acceptEdits');
    });

    it('returns a 32-character hex runId', () => {
      const path = writeTempMd(tmpDir, 'default.md', '---\n---\n');
      registry.seed(1, [{ name: 'sprint', path }]);

      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
      const { runId } = registry.createRun(workflowId);

      expect(runId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('inserts a row with status "queued"', () => {
      const path = writeTempMd(tmpDir, 'queued.md', '---\n---\n');
      registry.seed(1, [{ name: 'planner', path }]);

      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
      const { runId } = registry.createRun(workflowId);

      interface StatusRow { status: string }
      const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as StatusRow;
      expect(row.status).toBe('queued');
    });

    it('returns the same permissionMode that was snapshotted', () => {
      const content = `---\npermission_mode: dontAsk\n---\n`;
      const path = writeTempMd(tmpDir, 'dontask2.md', content);
      registry.seed(1, [{ name: 'compound', path }]);

      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('compound') as IdRow;
      const result = registry.createRun(workflowId);

      expect(result.permissionMode).toBe('dontAsk');
    });

    it('throws when the workflow does not exist', () => {
      expect(() => registry.createRun('nonexistent-id')).toThrow('not found');
    });
  });
});
