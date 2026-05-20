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
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import * as path from 'path';
import { WorkflowRegistry, resolveSoloFlowPluginRoot, buildDefaultSoloFlowWorkflows, type WorkflowDescriptor } from '../workflowRegistry';
import type { SoloFlowWorkflowName } from '../../../../shared/types/workflows';
import { REGISTRY_SCHEMA } from '../../database/__test_fixtures__/registrySchema';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { withTempDir } from '../../__test_fixtures__/tmp';

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
  let logger: ReturnType<typeof makeSpyLogger>;

  beforeEach(() => {
    db = createTestDb();
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
        const nonExistentPath = join(tmpDir, 'does-not-exist.md');
        registry.seed(1, [{ name: 'compound', path: nonExistentPath }]);

        interface ModeRow { permission_mode: string }
        const row = db.prepare('SELECT permission_mode FROM workflows WHERE name = ?').get('compound') as ModeRow;
        expect(row.permission_mode).toBe('default');
      });
    });

    it('missing .md file logs ERROR with the path (TASK-601: raised from WARN to fail-loud)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const nonExistentPath = join(tmpDir, 'does-not-exist.md');
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
        const nonExistentPath = join(tmpDir, 'does-not-exist.md');
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
    it('returns all workflows for a project', async () => {
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
      const cacheDir = join(fakeHome, '.claude', 'plugins', 'cache', 'soloflow', 'soloflow-dev');
      mkdirSync(join(cacheDir, '0.10.3'), { recursive: true });

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
      const cacheDir = join(fakeHome, '.claude', 'plugins', 'cache', 'soloflow', 'soloflow-dev');
      for (const ver of ['0.9.12', '0.10.3', '0.10.10']) {
        mkdirSync(join(cacheDir, ver), { recursive: true });
      }

      const result = resolveSoloFlowPluginRoot(fakeHome, {});
      expect(result.source).toBe('discovered');
      expect(result.root).toBe(join(cacheDir, '0.10.10'));
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
      const cacheDir = join(fakeHome, '.claude', 'plugins', 'cache', 'soloflow', 'soloflow-dev');
      mkdirSync(join(cacheDir, '0.10.5'), { recursive: true });

      const result = resolveSoloFlowPluginRoot(fakeHome, {
        SOLOFLOW_PLUGIN_ROOT: '   ',
      });
      expect(result.source).toBe('discovered');
      expect(result.root).toBe(join(cacheDir, '0.10.5'));
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
      const cacheDir = join(fakeHome, '.claude', 'plugins', 'cache', 'soloflow', 'soloflow-dev');
      for (const nonSemverName of ['latest', '.DS_Store', 'node_modules', '0.10']) {
        mkdirSync(join(cacheDir, nonSemverName), { recursive: true });
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
      const pluginRoot = join(
        tmpHome,
        '.claude', 'plugins', 'cache', 'soloflow', 'soloflow-dev', '0.10.3',
      );
      const commandsDir = join(pluginRoot, 'commands');
      mkdirSync(commandsDir, { recursive: true });

      // Write real .md files with frontmatter for all 5 default workflows.
      const workflowNames = ['idea-extractor', 'planner', 'sprint', 'compound', 'prune'];
      for (const name of workflowNames) {
        writeFileSync(
          join(commandsDir, `${name}.md`),
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
      const db = new Database(':memory:');
      db.exec(REGISTRY_SCHEMA);

      const logger = makeSpyLogger();
      const registry = new WorkflowRegistry(dbAdapter(db), logger);

      const finalDescriptors = resolvedPaths.map((rp) => ({
        name: rp.name as import('../../../../shared/types/workflows').SoloFlowWorkflowName,
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
