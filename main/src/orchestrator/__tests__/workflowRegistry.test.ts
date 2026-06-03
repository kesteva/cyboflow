/**
 * Unit tests for WorkflowRegistry.
 *
 * Behaviors covered (per TASK-351 / TASK-601 test_strategy):
 * 1. seed inserts five workflows with correct names
 * 2. seed is idempotent (second call does not duplicate rows)
 * 3. frontmatter permission_mode parsing: present/absent/file-missing cases
 * 4. createRun snapshots permission_mode onto workflow_runs row
 * 5. missing .md file falls back to 'default' and logs ERROR (TASK-601: raised from WARN)
 * 6. resolveSoloFlowPluginRoot: env-var override, highest-semver discovery, fallback
 *
 * All tests use an in-memory better-sqlite3 instance with the workflow tables
 * applied inline — no file I/O for the DB itself.  Workflow .md files are
 * written to temp paths via os.tmpdir() so fs.readFileSync is exercised
 * end-to-end; missing-file tests simply pass a non-existent path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import * as path from 'path';
import { WorkflowRegistry, resolveSoloFlowPluginRoot, buildDefaultSoloFlowWorkflows, QUICK_WORKFLOW_NAME, type WorkflowDescriptor } from '../workflowRegistry';
import type { CyboflowWorkflowName, WorkflowDefinition } from '../../../../shared/types/workflows';
import { WORKFLOW_DEFINITIONS } from '../../../../shared/types/workflows';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { withTempDir } from '../../__test_fixtures__/tmp';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';

/** Write a minimal markdown file with optional frontmatter to a temp dir. */
function writeTempMd(dir: string, filename: string, content: string): string {
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** Build five workflow descriptors pointing at real temp files. */
function buildDescriptors(
  dir: string,
  overrides: Partial<Record<CyboflowWorkflowName, string>> = {},
): WorkflowDescriptor[] {
  const names: CyboflowWorkflowName[] = ['soloflow', 'planner', 'sprint', 'compound', 'prune'];
  return names.map((name) => {
    if (name in overrides) {
      return { name, path: overrides[name]! };
    }
    const content = `---\ndescription: ${name} workflow\n---\n# ${name}\n`;
    const path = writeTempMd(dir, `${name}.md`, content);
    return { name, path };
  });
}

/**
 * Minimal structurally-valid `WorkflowDefinition` for the editor write-path
 * tests (updateSpec / createCustom). The registry does NOT re-validate, so this
 * only needs to round-trip through JSON.stringify and back via
 * resolveWorkflowDefinition — but it is also a valid strict-schema shape.
 */
function makeDefinition(id: string): WorkflowDefinition {
  return {
    id,
    phases: [
      {
        id: 'plan',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [
          { id: 'context', name: 'Get context', agent: 'idea-extractor', mcps: ['filesystem'], retries: 0 },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowRegistry', () => {
  let db: Database.Database;
  let registry: WorkflowRegistry;
  let logger: ReturnType<typeof makeSpyLogger>;

  beforeEach(() => {
    // getRunById now SELECTs current_step_id + the migration-014 run->task
    // columns; opt the fixture into those columns so the projection resolves.
    db = createTestDb({ includeWorkflowRunTaskColumns: true });
    // createRun also stamps workflow_runs.substrate (IDEA-013 / TASK-806); layer
    // that additive ALTER on top so the in-memory fixture carries the column.
    db.exec(
      "ALTER TABLE workflow_runs ADD COLUMN substrate TEXT NOT NULL DEFAULT 'sdk' CHECK (substrate IN ('sdk','interactive'))",
    );
    logger = makeSpyLogger();
    registry = new WorkflowRegistry(dbAdapter(db), logger);
  });

  // -------------------------------------------------------------------------
  // seed
  // -------------------------------------------------------------------------

  describe('seed', () => {
    it('inserts five workflows with correct names', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
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
    });

    it('is idempotent — second seed call does not add duplicate rows', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const descriptors = buildDescriptors(tmpDir);
        registry.seed(1, descriptors);
        registry.seed(1, descriptors);

        interface CountRow { count: number }
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id = 1').get() as CountRow;
        expect(count).toBe(5);
      });
    });

    it('preserves existing row IDs on re-seed', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const descriptors = buildDescriptors(tmpDir);
        registry.seed(1, descriptors);

        interface IdNameRow { id: string; name: string }
        const before = db.prepare('SELECT id, name FROM workflows WHERE project_id = 1 ORDER BY id').all() as IdNameRow[];

        registry.seed(1, descriptors);

        const after = db.prepare('SELECT id, name FROM workflows WHERE project_id = 1 ORDER BY id').all() as IdNameRow[];
        expect(after).toEqual(before);
      });
    });

    it('parses permission_mode: acceptEdits from frontmatter', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const content = `---\ndescription: test\npermission_mode: acceptEdits\n---\n`;
        const path = writeTempMd(tmpDir, 'accepts.md', content);
        registry.seed(1, [{ name: 'soloflow', path }]);

        interface ModeRow { permission_mode: string }
        const row = db.prepare('SELECT permission_mode FROM workflows WHERE name = ?').get('soloflow') as ModeRow;
        expect(row.permission_mode).toBe('acceptEdits');
      });
    });

    it('parses permission_mode: dontAsk from frontmatter', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const content = `---\ndescription: test\npermission_mode: dontAsk\n---\n`;
        const path = writeTempMd(tmpDir, 'dontask.md', content);
        registry.seed(1, [{ name: 'planner', path }]);

        interface ModeRow { permission_mode: string }
        const row = db.prepare('SELECT permission_mode FROM workflows WHERE name = ?').get('planner') as ModeRow;
        expect(row.permission_mode).toBe('dontAsk');
      });
    });

    it('defaults permission_mode to "default" when key is absent', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const content = `---\ndescription: test\n---\n`;
        const path = writeTempMd(tmpDir, 'noperm.md', content);
        registry.seed(1, [{ name: 'sprint', path }]);

        interface ModeRow { permission_mode: string }
        const row = db.prepare('SELECT permission_mode FROM workflows WHERE name = ?').get('sprint') as ModeRow;
        expect(row.permission_mode).toBe('default');
      });
    });

    it('missing .md file falls back to permission_mode "default"', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const nonExistentPath = path.join(tmpDir, 'does-not-exist.md');
        registry.seed(1, [{ name: 'compound', path: nonExistentPath }]);

        interface ModeRow { permission_mode: string }
        const row = db.prepare('SELECT permission_mode FROM workflows WHERE name = ?').get('compound') as ModeRow;
        expect(row.permission_mode).toBe('default');
      });
    });

    it('missing .md file logs ERROR with the path (TASK-601: raised from WARN to fail-loud)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const nonExistentPath = path.join(tmpDir, 'does-not-exist.md');
        registry.seed(1, [{ name: 'prune', path: nonExistentPath }]);

        // TASK-601: the log level was raised from WARN to ERROR so missing
        // workflow files are fail-loud rather than silently swallowed.
        const errorCalls = logger.calls.filter((c) => c.level === 'error');
        expect(errorCalls.length).toBeGreaterThan(0);
        const errMsg = errorCalls[0].message;
        expect(errMsg).toContain('could not read workflow file');
        const errCtx = errorCalls[0].ctx;
        expect(errCtx?.path).toBe(nonExistentPath);
      });
    });

    it('missing .md file does not throw and still inserts the row', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const nonExistentPath = path.join(tmpDir, 'does-not-exist.md');
        expect(() => registry.seed(1, [{ name: 'prune', path: nonExistentPath }])).not.toThrow();

        interface CountRow { count: number }
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id = 1').get() as CountRow;
        expect(count).toBe(1);
      });
    });

    it('assigns the deterministic id wf-<projectId>-<name> to each seeded workflow', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        // The deterministic-ID seed pattern is documented in workflowRegistry.ts:
        // Format: "wf-<projectId>-<name>" — unique per project+name pair and stable
        // across re-seeds so INSERT OR IGNORE is idempotent.
        const content = `---\n---\n`;
        const path = writeTempMd(tmpDir, 'deterministic.md', content);
        registry.seed(42, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const row = db.prepare('SELECT id FROM workflows WHERE project_id = 42 AND name = ?').get('sprint') as IdRow;
        expect(row.id).toBe('wf-42-sprint');
      });
    });
  });

  // -------------------------------------------------------------------------
  // getById / listByProject
  // -------------------------------------------------------------------------

  describe('getById', () => {
    it('returns the workflow row by id', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const descriptors = buildDescriptors(tmpDir);
        registry.seed(1, descriptors);

        interface IdRow { id: string }
        const first = db.prepare('SELECT id FROM workflows WHERE project_id = 1 ORDER BY id LIMIT 1').get() as IdRow;
        const row = registry.getById(first.id);
        expect(row).not.toBeNull();
        expect(row?.id).toBe(first.id);
      });
    });

    it('returns null for an unknown id', () => {
      expect(registry.getById('nonexistent-id')).toBeNull();
    });
  });

  describe('listByProject', () => {
    it('returns all non-sentinel workflows for a project', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const descriptors = buildDescriptors(tmpDir);
        registry.seed(1, descriptors);
        const rows = registry.listByProject(1);
        expect(rows).toHaveLength(5);
      });
    });

    it('returns empty array for an unknown project', () => {
      expect(registry.listByProject(999)).toEqual([]);
    });

    it('excludes __quick__ sentinel workflow from results', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const descriptors = buildDescriptors(tmpDir);
        registry.seed(1, descriptors);
        // Also create a sentinel row directly so we don't depend on ensureQuickWorkflow
        db.prepare(
          `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json, permission_mode)
           VALUES ('wf-1-__quick__', 1, '__quick__', '{}', 'default')`,
        ).run();

        const rows = registry.listByProject(1);
        // Should still be 5 (no sentinel)
        expect(rows).toHaveLength(5);
        expect(rows.every((r) => r.name !== '__quick__')).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // ensureQuickWorkflow
  // -------------------------------------------------------------------------

  describe('ensureQuickWorkflow', () => {
    it('creates a __quick__ sentinel row and returns the deterministic id', () => {
      const workflowId = registry.ensureQuickWorkflow(42);
      expect(workflowId).toBe('wf-42-__quick__');

      interface WfRow { id: string; name: string; project_id: number }
      const row = db
        .prepare('SELECT id, name, project_id FROM workflows WHERE id = ?')
        .get(workflowId) as WfRow | undefined;

      expect(row).toBeDefined();
      expect(row!.name).toBe(QUICK_WORKFLOW_NAME);
      expect(row!.project_id).toBe(42);
    });

    it('is idempotent — calling twice for the same project does not duplicate rows', () => {
      registry.ensureQuickWorkflow(7);
      registry.ensureQuickWorkflow(7);

      interface CountRow { count: number }
      const { count } = db
        .prepare("SELECT COUNT(*) AS count FROM workflows WHERE project_id = 7 AND name = '__quick__'")
        .get() as CountRow;

      expect(count).toBe(1);
    });

    it('returns the same id on every call', () => {
      const first = registry.ensureQuickWorkflow(99);
      const second = registry.ensureQuickWorkflow(99);
      expect(first).toBe(second);
      expect(first).toBe('wf-99-__quick__');
    });

    it('creates independent sentinels for different projects', () => {
      const idA = registry.ensureQuickWorkflow(10);
      const idB = registry.ensureQuickWorkflow(20);

      expect(idA).toBe('wf-10-__quick__');
      expect(idB).toBe('wf-20-__quick__');

      interface CountRow { count: number }
      const { count } = db
        .prepare("SELECT COUNT(*) AS count FROM workflows WHERE name = '__quick__'")
        .get() as CountRow;

      expect(count).toBe(2);
    });

    it('sentinel row is excluded from listByProject results', () => {
      registry.ensureQuickWorkflow(5);

      const rows = registry.listByProject(5);
      expect(rows.every((r) => r.name !== '__quick__')).toBe(true);
    });

    it('QUICK_WORKFLOW_NAME constant equals __quick__', () => {
      expect(QUICK_WORKFLOW_NAME).toBe('__quick__');
    });
  });

  // -------------------------------------------------------------------------
  // createRun
  // -------------------------------------------------------------------------

  describe('createRun', () => {
    it('snapshots permission_mode onto workflow_runs row', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
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
    });

    it('returns a 32-character hex runId', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'default.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        const { runId } = registry.createRun(workflowId);

        expect(runId).toMatch(/^[0-9a-f]{32}$/);
      });
    });

    it('inserts a row with status "queued"', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'queued.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const { runId } = registry.createRun(workflowId);

        interface StatusRow { status: string }
        const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as StatusRow;
        expect(row.status).toBe('queued');
      });
    });

    it('returns the same permissionMode that was snapshotted', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const content = `---\npermission_mode: dontAsk\n---\n`;
        const path = writeTempMd(tmpDir, 'dontask2.md', content);
        registry.seed(1, [{ name: 'compound', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('compound') as IdRow;
        const result = registry.createRun(workflowId);

        expect(result.permissionMode).toBe('dontAsk');
      });
    });

    it('throws when the workflow does not exist', () => {
      expect(() => registry.createRun('nonexistent-id')).toThrow('not found');
    });

    // ───── substrate stamping (IDEA-013 / TASK-806) ─────

    it("stamps the default substrate 'sdk' when no override is set (zero-behavior-change)", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'substrate-default.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        const result = registry.createRun(workflowId);

        // Returned value floors to 'sdk'.
        expect(result.substrate).toBe('sdk');

        // And it is persisted on the row.
        interface SubstrateRow { substrate: string }
        const row = db.prepare('SELECT substrate FROM workflow_runs WHERE id = ?').get(result.runId) as SubstrateRow;
        expect(row.substrate).toBe('sdk');
      });
    });

    it("stamps 'interactive' when CYBOFLOW_SUBSTRATE resolves it via the env override level", async () => {
      const prev = process.env.CYBOFLOW_SUBSTRATE;
      process.env.CYBOFLOW_SUBSTRATE = 'interactive';
      try {
        await withTempDir('workflow-registry-test-', async (tmpDir) => {
          const path = writeTempMd(tmpDir, 'substrate-interactive.md', '---\n---\n');
          registry.seed(1, [{ name: 'planner', path }]);

          interface IdRow { id: string }
          const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
          const result = registry.createRun(workflowId);

          expect(result.substrate).toBe('interactive');

          interface SubstrateRow { substrate: string }
          const row = db.prepare('SELECT substrate FROM workflow_runs WHERE id = ?').get(result.runId) as SubstrateRow;
          expect(row.substrate).toBe('interactive');
        });
      } finally {
        if (prev === undefined) {
          delete process.env.CYBOFLOW_SUBSTRATE;
        } else {
          process.env.CYBOFLOW_SUBSTRATE = prev;
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // getRunById — new nullable columns from TASK-598 reconciliation
  // -------------------------------------------------------------------------

  describe('getRunById', () => {
    it('returns null for an unknown run id', () => {
      expect(registry.getRunById('nonexistent-run')).toBeNull();
    });

    it('projects policy_json, stuck_at, stuck_reason, error_message as null on a freshly created run', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        // Seed a workflow, create a run, then read it back via getRunById to
        // confirm all four new nullable columns are projected (not missing from
        // the SELECT) and default to null.
        const path = writeTempMd(tmpDir, 'nullable-cols.md', '---\n---\n');
        registry.seed(1, [{ name: 'soloflow', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('soloflow') as IdRow;
        const { runId } = registry.createRun(workflowId);

        const run = registry.getRunById(runId);
        expect(run).not.toBeNull();
        // All four columns added by TASK-598 must be present in the returned row
        // and must be null (no value was written on insert).
        expect(run!.policy_json).toBeNull();
        expect(run!.stuck_at).toBeNull();
        expect(run!.stuck_reason).toBeNull();
        expect(run!.error_message).toBeNull();
      });
    });

    it('reads back policy_json, stuck_at, stuck_reason, error_message when written directly', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        // Confirm getRunById round-trips non-null values for the four new columns
        // so a future consumer (stuck-detector, B9) can rely on them.
        const path = writeTempMd(tmpDir, 'written-cols.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const { runId } = registry.createRun(workflowId);

        db.prepare(
          `UPDATE workflow_runs
             SET policy_json = ?, stuck_at = ?, stuck_reason = ?, error_message = ?
           WHERE id = ?`,
        ).run('{"key":"value"}', '2026-05-17T10:00:00Z', 'no_progress', 'subprocess exited', runId);

        const run = registry.getRunById(runId);
        expect(run).not.toBeNull();
        expect(run!.policy_json).toBe('{"key":"value"}');
        expect(run!.stuck_at).toBe('2026-05-17T10:00:00Z');
        expect(run!.stuck_reason).toBe('no_progress');
        expect(run!.error_message).toBe('subprocess exited');
      });
    });

    it('projects started_at and ended_at as null on a freshly created run', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'started-ended-null.md', '---\n---\n');
        registry.seed(1, [{ name: 'soloflow', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('soloflow') as IdRow;
        const { runId } = registry.createRun(workflowId);

        const run = registry.getRunById(runId);
        expect(run).not.toBeNull();
        expect(run!.started_at ?? null).toBeNull();
        expect(run!.ended_at ?? null).toBeNull();
      });
    });

    it('reads back started_at and ended_at when written directly', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'started-ended-written.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const { runId } = registry.createRun(workflowId);

        db.prepare(
          `UPDATE workflow_runs
             SET started_at = ?, ended_at = ?
           WHERE id = ?`,
        ).run('2026-05-18T10:00:00Z', '2026-05-18T11:30:00Z', runId);

        const run = registry.getRunById(runId);
        expect(run).not.toBeNull();
        expect(run!.started_at).toBe('2026-05-18T10:00:00Z');
        expect(run!.ended_at).toBe('2026-05-18T11:30:00Z');
      });
    });

    // ───── substrate read-back + immutability (IDEA-013 / TASK-806) ─────

    it("getRunById round-trips the stamped substrate ('sdk' default)", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'substrate-readback.md', '---\n---\n');
        registry.seed(1, [{ name: 'soloflow', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('soloflow') as IdRow;
        const { runId, substrate } = registry.createRun(workflowId);

        const run = registry.getRunById(runId);
        expect(run).not.toBeNull();
        expect(run!.substrate).toBe(substrate);
        expect(run!.substrate).toBe('sdk');
      });
    });

    it('substrate is immutable for the run — a second read returns the same value (no in-flight mutation path)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'substrate-immutable.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const { runId } = registry.createRun(workflowId);

        // Progress the run through a couple of status transitions; substrate must
        // not move (createRun is the only writer; there is no UPDATE path).
        db.prepare('UPDATE workflow_runs SET status = ? WHERE id = ?').run('running', runId);
        const first = registry.getRunById(runId);
        db.prepare('UPDATE workflow_runs SET status = ? WHERE id = ?').run('completed', runId);
        const second = registry.getRunById(runId);

        expect(first!.substrate).toBe('sdk');
        expect(second!.substrate).toBe('sdk');
        expect(first!.substrate).toBe(second!.substrate);
      });
    });
  });

  // -------------------------------------------------------------------------
  // spec_json projection — getById / listByProject must SELECT the column
  // -------------------------------------------------------------------------

  describe('spec_json column projection', () => {
    it('getById returns spec_json (default "{}") on a seeded row', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        registry.seed(1, buildDescriptors(tmpDir));
        const row = registry.getById('wf-1-soloflow');
        expect(row).not.toBeNull();
        // Seeded rows fall back to the schema default of '{}'.
        expect(row!.spec_json).toBe('{}');
      });
    });

    it('getById round-trips a non-default spec_json written directly', () => {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-soloflow', 1, 'soloflow', ?, 'default')`,
      ).run(JSON.stringify(makeDefinition('soloflow')));

      const row = registry.getById('wf-1-soloflow');
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.spec_json)).toEqual(makeDefinition('soloflow'));
    });

    it('listByProject projects spec_json on every returned row', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        registry.seed(1, buildDescriptors(tmpDir));
        const rows = registry.listByProject(1);
        expect(rows).toHaveLength(5);
        for (const r of rows) {
          // Field is present (typed string) — '{}' default for fresh seeds.
          expect(typeof r.spec_json).toBe('string');
          expect(r.spec_json).toBe('{}');
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // updateSpec (editor "Save")
  // -------------------------------------------------------------------------

  describe('updateSpec', () => {
    it('persists the JSON-stringified definition onto spec_json', () => {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-soloflow', 1, 'soloflow', '{}', 'default')`,
      ).run();

      const definition = makeDefinition('soloflow');
      registry.updateSpec('wf-1-soloflow', definition);

      interface SpecRow { spec_json: string }
      const row = db.prepare('SELECT spec_json FROM workflows WHERE id = ?').get('wf-1-soloflow') as SpecRow;
      expect(row.spec_json).toBe(JSON.stringify(definition));
      expect(JSON.parse(row.spec_json)).toEqual(definition);
    });

    it('round-trips through getById so resolveWorkflowDefinition would prefer it', () => {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-planner', 1, 'planner', '{}', 'default')`,
      ).run();

      const edited = makeDefinition('planner');
      // Mutate one field so the edited graph clearly differs from the built-in.
      edited.phases[0].label = 'Edited Plan';
      registry.updateSpec('wf-1-planner', edited);

      const row = registry.getById('wf-1-planner');
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.spec_json)).toEqual(edited);
    });

    it('throws when the workflow id does not exist (0 rows updated)', () => {
      expect(() => registry.updateSpec('nonexistent-id', makeDefinition('x'))).toThrow('not found');
    });
  });

  // -------------------------------------------------------------------------
  // resetSpec (editor "Reset to default")
  // -------------------------------------------------------------------------

  describe('resetSpec', () => {
    it('resets a built-in workflow spec_json back to "{}"', () => {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-sprint', 1, 'sprint', ?, 'default')`,
      ).run(JSON.stringify(makeDefinition('sprint')));

      registry.resetSpec('wf-1-sprint');

      interface SpecRow { spec_json: string }
      const row = db.prepare('SELECT spec_json FROM workflows WHERE id = ?').get('wf-1-sprint') as SpecRow;
      expect(row.spec_json).toBe('{}');
    });

    it('throws when the workflow id does not exist', () => {
      expect(() => registry.resetSpec('nonexistent-id')).toThrow('not found');
    });

    it('throws for a custom (non-built-in) workflow name', () => {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-custom-abc12345', 1, 'My Custom Flow', ?, 'default')`,
      ).run(JSON.stringify(makeDefinition('my-custom-flow')));

      expect(() => registry.resetSpec('wf-1-custom-abc12345')).toThrow(/cannot reset a custom workflow/i);
    });

    it('does NOT touch a custom workflow spec_json when the reset is rejected', () => {
      const customSpec = JSON.stringify(makeDefinition('my-custom-flow'));
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-custom-def67890', 1, 'Another Flow', ?, 'default')`,
      ).run(customSpec);

      expect(() => registry.resetSpec('wf-1-custom-def67890')).toThrow();

      interface SpecRow { spec_json: string }
      const row = db.prepare('SELECT spec_json FROM workflows WHERE id = ?').get('wf-1-custom-def67890') as SpecRow;
      expect(row.spec_json).toBe(customSpec);
    });
  });

  // -------------------------------------------------------------------------
  // createCustom (editor "Save as new flow")
  // -------------------------------------------------------------------------

  describe('createCustom', () => {
    it('inserts a row with a generated id and returns it with spec_json + permission_mode', () => {
      const definition = makeDefinition('my-flow');
      const row = registry.createCustom(1, 'My Flow', definition, 'acceptEdits');

      // Generated id: wf-<projectId>-custom-<8 lowercase hex chars>.
      expect(row.id).toMatch(/^wf-1-custom-[0-9a-f]{8}$/);
      expect(row.project_id).toBe(1);
      expect(row.name).toBe('My Flow');
      expect(row.workflow_path).toBeNull();
      expect(row.permission_mode).toBe('acceptEdits');
      expect(JSON.parse(row.spec_json)).toEqual(definition);

      // The returned row reflects what was actually persisted.
      const reread = registry.getById(row.id);
      expect(reread).not.toBeNull();
      expect(reread!.id).toBe(row.id);
      expect(JSON.parse(reread!.spec_json)).toEqual(definition);
    });

    it('defaults persisted permission_mode to whatever the caller passes (default)', () => {
      const row = registry.createCustom(7, 'Default Mode Flow', makeDefinition('default-mode-flow'), 'default');
      expect(row.permission_mode).toBe('default');
    });

    it('rejects a name that collides with a built-in workflow name', () => {
      for (const builtIn of ['soloflow', 'planner', 'sprint', 'compound', 'prune']) {
        expect(
          () => registry.createCustom(1, builtIn, makeDefinition(builtIn), 'default'),
          `built-in name '${builtIn}' should be rejected`,
        ).toThrow(/reserved/i);
      }
    });

    it('rejects the __quick__ sentinel name', () => {
      expect(
        () => registry.createCustom(1, QUICK_WORKFLOW_NAME, makeDefinition('quick'), 'default'),
      ).toThrow(/reserved/i);
    });

    it('rejects a name that collides with an existing row in the SAME project', () => {
      registry.createCustom(1, 'Duplicate', makeDefinition('duplicate'), 'default');
      expect(
        () => registry.createCustom(1, 'Duplicate', makeDefinition('duplicate'), 'default'),
      ).toThrow(/already exists/i);
    });

    it('allows the same name in a DIFFERENT project (collision is per-project)', () => {
      const rowA = registry.createCustom(1, 'Shared Name', makeDefinition('shared-name'), 'default');
      const rowB = registry.createCustom(2, 'Shared Name', makeDefinition('shared-name'), 'default');
      expect(rowA.project_id).toBe(1);
      expect(rowB.project_id).toBe(2);
      expect(rowA.id).not.toBe(rowB.id);
    });

    it('does NOT insert a row when the name is rejected', () => {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-soloflow', 1, 'soloflow', '{}', 'default')`,
      ).run();

      expect(() => registry.createCustom(1, 'soloflow', makeDefinition('soloflow'), 'default')).toThrow();

      interface CountRow { count: number }
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id = 1').get() as CountRow;
      // Only the row we seeded directly — no custom row was inserted.
      expect(count).toBe(1);
    });

    it('a created custom flow appears in listByProject', () => {
      const row = registry.createCustom(3, 'Listed Flow', makeDefinition('listed-flow'), 'default');
      const rows = registry.listByProject(3);
      expect(rows.map((r) => r.id)).toContain(row.id);
    });

    it('resolveWorkflowDefinition-shaped: the persisted spec is the built-in clone when cloned from one', () => {
      // Custom flows are commonly created by cloning a built-in then renaming.
      // Confirm an arbitrary built-in definition survives the round-trip.
      const cloned = WORKFLOW_DEFINITIONS.soloflow;
      const row = registry.createCustom(9, 'Cloned Soloflow', cloned, 'default');
      expect(JSON.parse(row.spec_json)).toEqual(cloned);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveSoloFlowPluginRoot (TASK-601)
// ---------------------------------------------------------------------------

describe('resolveSoloFlowPluginRoot', () => {
  it('returns env-var value when SOLOFLOW_PLUGIN_ROOT is set', () => {
    const fakeRoot = '/custom/soloflow/path';
    const result = resolveSoloFlowPluginRoot('/home/test', {
      SOLOFLOW_PLUGIN_ROOT: fakeRoot,
    });
    expect(result.source).toBe('env');
    expect(result.root).toBe(fakeRoot);
  });

  it('env-var wins even when the filesystem has installed versions', async () => {
    await withTempDir('resolve-test-', async (fakeHome) => {
      const cacheDir = path.join(fakeHome, '.claude', 'plugins', 'cache', 'soloflow', 'soloflow-dev');
      mkdirSync(path.join(cacheDir, '0.10.3'), { recursive: true });

      const overridePath = '/override/path';
      const result = resolveSoloFlowPluginRoot(fakeHome, {
        SOLOFLOW_PLUGIN_ROOT: overridePath,
      });
      expect(result.source).toBe('env');
      expect(result.root).toBe(overridePath);
    });
  });

  it('picks the highest semver from a fixture dir with multiple versions', async () => {
    await withTempDir('resolve-semver-', async (fakeHome) => {
      // Build a fake plugin cache with 0.9.12, 0.10.3, and 0.10.10 subdirectories.
      // The resolver must pick 0.10.10 (highest semver), not 0.10.3 (lexicographic
      // sort would incorrectly rank 0.10.3 > 0.10.10 since '3' > '1' char-by-char).
      const cacheDir = path.join(fakeHome, '.claude', 'plugins', 'cache', 'soloflow', 'soloflow-dev');
      for (const ver of ['0.9.12', '0.10.3', '0.10.10']) {
        mkdirSync(path.join(cacheDir, ver), { recursive: true });
      }

      const result = resolveSoloFlowPluginRoot(fakeHome, {});
      expect(result.source).toBe('discovered');
      expect(result.root).toBe(path.join(cacheDir, '0.10.10'));
    });
  });

  it('returns fallback when no versions are installed', async () => {
    await withTempDir('resolve-fallback-', async (fakeHome) => {
      // Do NOT create the cacheDir — readdirSync should throw ENOENT.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = resolveSoloFlowPluginRoot(fakeHome, {});
      warnSpy.mockRestore();

      expect(result.source).toBe('fallback');
      expect(result.root).toContain('soloflow-dev');
    });
  });

  it('whitespace-only SOLOFLOW_PLUGIN_ROOT is not treated as an override — falls through to discovery', async () => {
    await withTempDir('resolve-ws-fallback-', async (fakeHome) => {
      // The resolver guards with `envOverride.trim() !== ''` so a value of e.g.
      // '   ' (spaces only) must NOT return source:'env'.  Instead it should
      // fall through to filesystem discovery (or fallback).
      // Build one real version dir so we land on 'discovered' rather than
      // 'fallback' — that lets us assert the guard without a console.warn spy.
      const cacheDir = path.join(fakeHome, '.claude', 'plugins', 'cache', 'soloflow', 'soloflow-dev');
      mkdirSync(path.join(cacheDir, '0.10.5'), { recursive: true });

      const result = resolveSoloFlowPluginRoot(fakeHome, {
        SOLOFLOW_PLUGIN_ROOT: '   ',
      });
      expect(result.source).toBe('discovered');
      expect(result.root).toBe(path.join(cacheDir, '0.10.5'));
    });
  });

  it('SOLOFLOW_PLUGIN_ROOT with surrounding whitespace is trimmed before returning', () => {
    // The resolver calls `.trim()` on the env-var value so a path written
    // with accidental leading/trailing spaces still resolves correctly.
    const fakeRoot = '/trimmed/soloflow/path';
    const result = resolveSoloFlowPluginRoot('/home/test', {
      SOLOFLOW_PLUGIN_ROOT: `  ${fakeRoot}  `,
    });
    expect(result.source).toBe('env');
    expect(result.root).toBe(fakeRoot);
  });

  it('falls back when cacheDir exists but contains only non-semver entries', async () => {
    await withTempDir('resolve-nonsemver-', async (fakeHome) => {
      // If the cache directory exists but holds only directories whose names do
      // not match the semver pattern (e.g. 'latest', '.DS_Store', 'node_modules'),
      // the resolver must skip them all and fall through to the fallback path.
      const cacheDir = path.join(fakeHome, '.claude', 'plugins', 'cache', 'soloflow', 'soloflow-dev');
      for (const nonSemverName of ['latest', '.DS_Store', 'node_modules', '0.10']) {
        mkdirSync(path.join(cacheDir, nonSemverName), { recursive: true });
      }

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = resolveSoloFlowPluginRoot(fakeHome, {});
      warnSpy.mockRestore();

      expect(result.source).toBe('fallback');
      expect(result.root).toContain('soloflow-dev');
    });
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_SOLOFLOW_WORKFLOWS compat shim regression (TASK-601 bugfix)
// ---------------------------------------------------------------------------

describe('DEFAULT_SOLOFLOW_WORKFLOWS compat shim', () => {
  it('pathFromHome is relative so path.join(homeDir, pathFromHome) resolves to an existing file', async () => {
    await withTempDir('soloflow-shim-test-', async (tmpHome) => {
      const pluginRoot = path.join(
        tmpHome,
        '.claude', 'plugins', 'cache', 'soloflow', 'soloflow-dev', '0.10.3',
      );
      const commandsDir = path.join(pluginRoot, 'commands');
      mkdirSync(commandsDir, { recursive: true });

      // Write real .md files with frontmatter for all 5 default workflows.
      const workflowNames = ['idea-extractor', 'planner', 'sprint', 'compound', 'prune'];
      for (const name of workflowNames) {
        writeFileSync(
          path.join(commandsDir, `${name}.md`),
          `---\npermission_mode: acceptEdits\n---\n# ${name}\n`,
          'utf-8',
        );
      }

      // Build descriptors pointing at our tmp tree.
      const descriptors = buildDefaultSoloFlowWorkflows(pluginRoot);

      // Simulate what the compat shim does: store relative paths.
      const shimEntries = descriptors.map((d) => ({
        name: d.name,
        pathFromHome: path.relative(tmpHome, d.path),
      }));

      // Simulate what the cyboflow.ts callsite does: path.join(homeDir, pathFromHome).
      const resolvedPaths = shimEntries.map((wf) => ({
        name: wf.name,
        resolvedPath: path.join(tmpHome, wf.pathFromHome),
      }));

      // Every resolved path must exist on disk (no doubled-prefix).
      for (const { name, resolvedPath } of resolvedPaths) {
        expect(existsSync(resolvedPath), `${name}: ${resolvedPath} does not exist`).toBe(true);
      }

      // Also verify that the permission_mode from the file is parseable as 'acceptEdits'.
      // We use a fresh registry with an in-memory DB to exercise seed() end-to-end.
      const db = createTestDb();

      const logger = makeSpyLogger();
      const registry = new WorkflowRegistry(dbAdapter(db), logger);

      const finalDescriptors = resolvedPaths.map((rp) => ({
        name: rp.name as import('../../../../shared/types/workflows').CyboflowWorkflowName,
        path: rp.resolvedPath,
      }));

      registry.seed(1, finalDescriptors);

      // No ERROR log should fire in the happy path.
      expect(logger.calls.filter((c) => c.level === 'error').length).toBe(0);

      // All 5 workflows should have permission_mode = 'acceptEdits'.
      interface ModeRow { name: string; permission_mode: string }
      const rows = db
        .prepare('SELECT name, permission_mode FROM workflows WHERE project_id = 1 ORDER BY name')
        .all() as ModeRow[];
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.permission_mode).toBe('acceptEdits');
      }
    });
  });
});
