/**
 * Unit tests for WorkflowRegistry.
 *
 * Behaviors covered (per TASK-351 / TASK-601 test_strategy):
 * 1. seed inserts the built-in workflows with correct names
 * 2. seed is idempotent (second call does not duplicate rows)
 * 3. frontmatter permission_mode parsing: present/absent/file-missing cases
 * 4. createRun snapshots permission_mode onto workflow_runs row
 * 5. missing .md file falls back to 'default' and logs ERROR (TASK-601: raised from WARN)
 *
 * The SoloFlow plugin-root discovery + compat-shim tests were removed in P0:
 * the built-in workflow bodies now live in-repo (see builtInWorkflows.test.ts)
 * and the app no longer discovers them under ~/.claude/plugins/cache/soloflow.
 *
 * All tests use an in-memory better-sqlite3 instance with the workflow tables
 * applied inline — no file I/O for the DB itself.  Workflow .md files are
 * written to temp paths via os.tmpdir() so fs.readFileSync is exercised
 * end-to-end; missing-file tests simply pass a non-existent path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { writeFileSync } from 'fs';
import * as path from 'path';
import { WorkflowRegistry, QUICK_WORKFLOW_NAME, type WorkflowDescriptor, type WorkflowConfigProvider } from '../workflowRegistry';
import { computeSpecHash } from '../specHash';
import type { PermissionMode } from '../../../../shared/types/workflows';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import type { CyboflowWorkflowName, WorkflowDefinition } from '../../../../shared/types/workflows';
import { CYBOFLOW_WORKFLOW_NAMES, WORKFLOW_DEFINITIONS } from '../../../../shared/types/workflows';
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

/** Build the built-in workflow descriptors pointing at real temp files. */
function buildDescriptors(
  dir: string,
  overrides: Partial<Record<CyboflowWorkflowName, string>> = {},
): WorkflowDescriptor[] {
  // Derive from the single source of truth so the descriptor set tracks the
  // built-in flow list automatically (planner + sprint + compound + …).
  const names: readonly CyboflowWorkflowName[] = CYBOFLOW_WORKFLOW_NAMES;
  return names.map((name) => {
    if (name in overrides) {
      return { name, path: overrides[name]! };
    }
    const content = `---\ndescription: ${name} workflow\n---\n# ${name}\n`;
    const path = writeTempMd(dir, `${name}.md`, content);
    return { name, path };
  });
}

/** The built-in flow names sorted — for set-equality assertions. */
const BUILTIN_NAMES_SORTED = [...CYBOFLOW_WORKFLOW_NAMES].sort();

/**
 * A canned owning-session id threaded as the 3rd positional `createRun` arg.
 * createRun now THROWS when session-less (permission-mode redesign slice 1b), so
 * every run-creating test passes one. workflow_runs.session_id is a soft link (no
 * FK), so a synthetic id needs no backing `sessions` row for these registry tests.
 */
const TEST_SESSION_ID = 'sess-test';

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

/**
 * Build a stub WorkflowConfigProvider supplying the global defaults that
 * createRun feeds into the resolvers. Mirrors ConfigManager's surface without
 * importing the concrete service (standalone-typecheck invariant).
 */
function makeConfig(
  agentMode: PermissionMode,
  substrate: CliSubstrate = 'sdk',
): WorkflowConfigProvider {
  return {
    getDefaultAgentPermissionMode: () => agentMode,
    getDefaultSubstrate: () => substrate,
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
    // createRun also stamps workflow_runs.execution_model (migration 032), the
    // sibling immutable stamp to substrate that getRunById now projects. The
    // column is provided by the includeWorkflowRunTaskColumns block above (folded
    // in alongside batch_id), so no manual ALTER is needed here.
    // createRun now also writes workflow_runs.session_id (session<->run
    // restructure, Phase 1 / migration 019); layer the additive ALTER on top.
    db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
// batch_id (sprint lanes, migration 022) comes from the fixture's
    // includeWorkflowRunTaskColumns block — no manual ALTER needed here.
    // spec-capture (migration 026): createRun freezes workflow_runs.spec_hash and
    // INSERT-OR-IGNOREs a workflow_revisions snapshot; updateSpec / resetSpec also
    // snapshot. Layer both additive shapes on top of GATE_SCHEMA (mirrors the
    // migration's ALTER + CREATE TABLE; never widens GATE_SCHEMA).
    db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
    // getRunById now SELECTs workflow_runs.seed_finding_ids (compound triage seed,
    // migration 032); layer the additive ALTER on top so the projection resolves.
    db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_finding_ids TEXT');
    // createRun stamps workflow_runs.model (per-run model pin, migration 037) and
    // getRunById projects it; the column is provided by the
    // includeWorkflowRunTaskColumns block above (folded in alongside
    // execution_model), so no manual ALTER is needed here.
    // createRun now also stamps the three immutable visual-verification columns
    // (migration 046) — verify_enabled / verify_type / verify_chain, the sibling
    // run-stamp to substrate / execution_model that getRunById also projects.
    // Layer the additive ALTERs on top (mirrors the migration's ADD COLUMNs;
    // never widens GATE_SCHEMA). With the master switch OFF (no config injected)
    // every run stamps verify_enabled=0 / verify_type=NULL / verify_chain=NULL.
    db.exec('ALTER TABLE workflow_runs ADD COLUMN verify_enabled INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN verify_type TEXT');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN verify_chain TEXT');
    db.exec(`
      CREATE TABLE workflow_revisions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        spec_hash   TEXT NOT NULL,
        spec_json   TEXT NOT NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (workflow_id, spec_hash),
        FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
      )
    `);
    logger = makeSpyLogger();
    registry = new WorkflowRegistry(dbAdapter(db), logger);
  });

  // -------------------------------------------------------------------------
  // seed
  // -------------------------------------------------------------------------

  describe('seed', () => {
    it('inserts the built-in workflows with correct names', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const descriptors = buildDescriptors(tmpDir);
        registry.seed(1, descriptors);

        interface CountRow { count: number }
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id = 1').get() as CountRow;
        expect(count).toBe(CYBOFLOW_WORKFLOW_NAMES.length);

        interface NameRow { name: string }
        const rows = db.prepare('SELECT name FROM workflows WHERE project_id = 1 ORDER BY name').all() as NameRow[];
        const names = rows.map((r) => r.name).sort();
        expect(names).toEqual(BUILTIN_NAMES_SORTED);
      });
    });

    it('is idempotent — second seed call does not add duplicate rows', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const descriptors = buildDescriptors(tmpDir);
        registry.seed(1, descriptors);
        registry.seed(1, descriptors);

        interface CountRow { count: number }
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id = 1').get() as CountRow;
        expect(count).toBe(CYBOFLOW_WORKFLOW_NAMES.length);
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
        registry.seed(1, [{ name: 'planner', path }]);

        interface ModeRow { permission_mode: string }
        const row = db.prepare('SELECT permission_mode FROM workflows WHERE name = ?').get('planner') as ModeRow;
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
        registry.seed(1, [{ name: 'sprint', path: nonExistentPath }]);

        interface ModeRow { permission_mode: string }
        const row = db.prepare('SELECT permission_mode FROM workflows WHERE name = ?').get('sprint') as ModeRow;
        expect(row.permission_mode).toBe('default');
      });
    });

    it('missing .md file logs ERROR with the path (TASK-601: raised from WARN to fail-loud)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const nonExistentPath = path.join(tmpDir, 'does-not-exist.md');
        registry.seed(1, [{ name: 'sprint', path: nonExistentPath }]);

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
        expect(() => registry.seed(1, [{ name: 'sprint', path: nonExistentPath }])).not.toThrow();

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
        expect(rows).toHaveLength(CYBOFLOW_WORKFLOW_NAMES.length);
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
        // Still exactly the built-in flows (no sentinel).
        expect(rows).toHaveLength(CYBOFLOW_WORKFLOW_NAMES.length);
        expect(rows.every((r) => r.name !== '__quick__')).toBe(true);
      });
    });

    it('excludes the still-dropped legacy built-ins (soloflow/prune) lingering from a pre-refactor DB', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        registry.seed(1, buildDescriptors(tmpDir)); // planner + sprint + compound
        // Simulate the stale rows a pre-refactor project DB still carries. NOTE:
        // `compound` is NO LONGER in this set — it was rebuilt as a real built-in
        // (TASK compound-flow), so it is seeded above and surfaces in the picker;
        // only `soloflow` / `prune` remain dropped.
        db.prepare(
          `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json, permission_mode) VALUES
             ('wf-1-soloflow', 1, 'soloflow', '{}', 'default'),
             ('wf-1-prune', 1, 'prune', '{}', 'default')`,
        ).run();

        const names = registry.listByProject(1).map((r) => r.name).sort();
        expect(names).toEqual(BUILTIN_NAMES_SORTED);
      });
    });

    it('excludes foreign/internal flows with an unresolvable empty spec (e.g. task/sprint-init/sprint-finalize leaked via the shared dev DB)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        registry.seed(1, buildDescriptors(tmpDir)); // planner + sprint + compound
        // Rows another worktree (feat/parallel-sprint) registered into the SHARED
        // dev DB: unknown names + empty spec → resolveWorkflowDefinition returns
        // null, so they must not surface as dead "0 steps / 0 phases" picker cards.
        db.prepare(
          `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json, permission_mode) VALUES
             ('wf-1-task', 1, 'task', '{}', 'default'),
             ('wf-1-sprint-init', 1, 'sprint-init', '{}', 'default'),
             ('wf-1-sprint-finalize', 1, 'sprint-finalize', '{}', 'default')`,
        ).run();

        const names = registry.listByProject(1).map((r) => r.name).sort();
        expect(names).toEqual(BUILTIN_NAMES_SORTED);
      });
    });

    // ───── global + project union (migration 030) ─────

    it('returns the GLOBAL built-ins UNIONed with the project-scoped rows', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        // Global built-ins (project_id NULL) + one project-scoped custom flow.
        registry.ensureGlobalBuiltIns(buildDescriptors(tmpDir));
        const custom = registry.createCustom({
          projectId: 3,
          name: 'Project Three Flow',
          specJson: JSON.stringify(makeDefinition('project-three-flow')),
        });

        const rows = registry.listByProject(3);
        // The 3 global built-ins + the project's own custom.
        expect(rows).toHaveLength(CYBOFLOW_WORKFLOW_NAMES.length + 1);
        expect(rows.map((r) => r.id)).toContain(custom.id);
        // The global built-ins surface (project_id NULL).
        expect(rows.filter((r) => r.project_id === null).map((r) => r.name).sort()).toEqual(
          BUILTIN_NAMES_SORTED,
        );
      });
    });

    it('does NOT return another project\'s scoped rows', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        registry.ensureGlobalBuiltIns(buildDescriptors(tmpDir));
        const projTwoFlow = registry.createCustom({
          projectId: 2,
          name: 'Belongs To Two',
          specJson: JSON.stringify(makeDefinition('belongs-to-two')),
        });

        // Project 5 sees the globals but NOT project 2's scoped custom flow.
        const rows = registry.listByProject(5);
        expect(rows.map((r) => r.id)).not.toContain(projTwoFlow.id);
        expect(rows.map((r) => r.name).sort()).toEqual(BUILTIN_NAMES_SORTED);
      });
    });

    it('returns the GLOBAL built-ins even for a project with no scoped rows', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        registry.ensureGlobalBuiltIns(buildDescriptors(tmpDir));
        const rows = registry.listByProject(999);
        expect(rows.map((r) => r.name).sort()).toEqual(BUILTIN_NAMES_SORTED);
        expect(rows.every((r) => r.project_id === null)).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // ensureGlobalBuiltIns (migration 030 — one global set, not per-project)
  // -------------------------------------------------------------------------

  describe('ensureGlobalBuiltIns', () => {
    it('inserts exactly one global row per built-in (project_id NULL, id wf-global-<name>)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        registry.ensureGlobalBuiltIns(buildDescriptors(tmpDir));

        interface GlobalRow { id: string; name: string; project_id: number | null }
        const rows = db
          .prepare('SELECT id, name, project_id FROM workflows WHERE project_id IS NULL ORDER BY name')
          .all() as GlobalRow[];

        expect(rows).toHaveLength(CYBOFLOW_WORKFLOW_NAMES.length);
        expect(rows.map((r) => r.name).sort()).toEqual(BUILTIN_NAMES_SORTED);
        for (const r of rows) {
          expect(r.project_id).toBeNull();
          expect(r.id).toBe(`wf-global-${r.name}`);
        }
      });
    });

    it('is idempotent — a second call does not duplicate the global rows', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const descriptors = buildDescriptors(tmpDir);
        registry.ensureGlobalBuiltIns(descriptors);
        registry.ensureGlobalBuiltIns(descriptors);

        interface CountRow { count: number }
        const { count } = db
          .prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id IS NULL')
          .get() as CountRow;
        expect(count).toBe(CYBOFLOW_WORKFLOW_NAMES.length);
      });
    });

    it('does NOT create any per-project rows (no wf-<projectId>-<name> seeding)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        registry.ensureGlobalBuiltIns(buildDescriptors(tmpDir));

        interface CountRow { count: number }
        const { count } = db
          .prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id IS NOT NULL')
          .get() as CountRow;
        expect(count).toBe(0);
      });
    });

    it('re-points an existing global row at the in-repo prompt (pre-refactor plugin path -> in-repo)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        // A pre-refactor global row whose workflow_path points at the old plugin cache.
        db.prepare(
          `INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
           VALUES ('wf-global-planner', NULL, 'planner', '/old/plugins/cache/soloflow/planner.md', 'default')`,
        ).run();

        const descriptors = buildDescriptors(tmpDir); // real in-repo .md paths
        const plannerPath = descriptors.find((d) => d.name === 'planner')!.path;
        registry.ensureGlobalBuiltIns(descriptors);

        const row = db
          .prepare("SELECT workflow_path FROM workflows WHERE id = 'wf-global-planner'")
          .get() as { workflow_path: string };
        expect(row.workflow_path).toBe(plannerPath);
      });
    });

    it('preserves user spec_json edits on a global row while re-pointing the path', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        db.prepare(
          `INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode, spec_json)
           VALUES ('wf-global-sprint', NULL, 'sprint', '/old/sprint.md', 'default', '{"phases":[]}')`,
        ).run();

        const descriptors = buildDescriptors(tmpDir);
        const sprintPath = descriptors.find((d) => d.name === 'sprint')!.path;
        registry.ensureGlobalBuiltIns(descriptors);

        const row = db
          .prepare("SELECT workflow_path, spec_json FROM workflows WHERE id = 'wf-global-sprint'")
          .get() as { workflow_path: string; spec_json: string };
        expect(row.workflow_path).toBe(sprintPath);
        expect(row.spec_json).toBe('{"phases":[]}');
      });
    });

    it('global built-ins are visible to every project via listByProject', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        registry.ensureGlobalBuiltIns(buildDescriptors(tmpDir));
        // No per-project seeding happened, yet each project sees the union.
        expect(registry.listByProject(7).map((r) => r.name).sort()).toEqual(BUILTIN_NAMES_SORTED);
        expect(registry.listByProject(42).map((r) => r.name).sort()).toEqual(BUILTIN_NAMES_SORTED);
      });
    });

    // ───── phantom per-project built-in prune (shared-DB hardening) ─────

    it('prunes a re-seeded phantom per-project built-in (spec "{}", no runs) while PRESERVING an edited project copy', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        // Phantom per-project built-ins a stale build re-seeded (empty spec).
        db.prepare(
          `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode) VALUES
             ('wf-1-planner', 1, 'planner', '{}', 'default'),
             ('wf-2-sprint', 2, 'sprint', '{}', 'default')`,
        ).run();
        // An EDITED per-project built-in (project copy) — non-empty spec, KEPT.
        db.prepare(
          `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
           VALUES ('wf-3-planner', 3, 'planner', ?, 'default')`,
        ).run(JSON.stringify(makeDefinition('planner')));

        registry.ensureGlobalBuiltIns(buildDescriptors(tmpDir));

        // Phantoms pruned.
        expect(registry.getById('wf-1-planner')).toBeNull();
        expect(registry.getById('wf-2-sprint')).toBeNull();
        // Edited project copy preserved.
        expect(registry.getById('wf-3-planner')).not.toBeNull();
        // The single global set is intact (one row per built-in, project_id NULL).
        interface CountRow { count: number }
        const { count } = db
          .prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id IS NULL')
          .get() as CountRow;
        expect(count).toBe(CYBOFLOW_WORKFLOW_NAMES.length);
      });
    });

    it('does NOT prune a phantom per-project built-in that carries run history (would cascade-delete runs)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        db.prepare(
          `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
           VALUES ('wf-1-planner', 1, 'planner', '{}', 'default')`,
        ).run();
        // A run pinned to that phantom row — pruning it would cascade the run away.
        registry.createRun('wf-1-planner', undefined, TEST_SESSION_ID);

        registry.ensureGlobalBuiltIns(buildDescriptors(tmpDir));

        // The phantom survives BECAUSE it has run history (safety guard).
        expect(registry.getById('wf-1-planner')).not.toBeNull();
      });
    });

    it('does NOT touch custom flows (non-built-in names) during the phantom prune', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        // A project-scoped custom flow with an EMPTY spec must NOT be pruned —
        // the prune is scoped to built-in names only.
        db.prepare(
          `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
           VALUES ('wf-1-custom-keepme01', 1, 'Keep Me', '{}', 'default')`,
        ).run();

        registry.ensureGlobalBuiltIns(buildDescriptors(tmpDir));

        expect(registry.getById('wf-1-custom-keepme01')).not.toBeNull();
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
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

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
        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        expect(runId).toMatch(/^[0-9a-f]{32}$/);
      });
    });

    it('inserts a row with status "queued"', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'queued.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        interface StatusRow { status: string }
        const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as StatusRow;
        expect(row.status).toBe('queued');
      });
    });

    it('returns the same permissionMode that was snapshotted', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const content = `---\npermission_mode: dontAsk\n---\n`;
        const path = writeTempMd(tmpDir, 'dontask2.md', content);
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        const result = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        expect(result.permissionMode).toBe('dontAsk');
      });
    });

    it('throws when the workflow does not exist', () => {
      expect(() => registry.createRun('nonexistent-id')).toThrow('not found');
    });

    // ───── permission-mode resolution (global default + frontmatter opt-in) ─────

    it("falls through a 'default' column to the injected global default", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        // No frontmatter permission_mode → column seeded as 'default' (unset).
        const path = writeTempMd(tmpDir, 'global-default.md', '---\n---\n');
        const cfgRegistry = new WorkflowRegistry(dbAdapter(db), logger, makeConfig('auto'));
        cfgRegistry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const result = cfgRegistry.createRun(workflowId, undefined, TEST_SESSION_ID);

        // Column was 'default' (treated as unset) → global default 'auto' wins.
        expect(result.permissionMode).toBe('auto');
        interface SnapshotRow { permission_mode_snapshot: string }
        const row = db.prepare('SELECT permission_mode_snapshot FROM workflow_runs WHERE id = ?').get(result.runId) as SnapshotRow;
        expect(row.permission_mode_snapshot).toBe('auto');
      });
    });

    it('an explicit frontmatter opt-in on the column beats the global default', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const content = `---\npermission_mode: dontAsk\n---\n`;
        const path = writeTempMd(tmpDir, 'frontmatter-opt-in.md', content);
        const cfgRegistry = new WorkflowRegistry(dbAdapter(db), logger, makeConfig('auto'));
        cfgRegistry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        const result = cfgRegistry.createRun(workflowId, undefined, TEST_SESSION_ID);

        // Column 'dontAsk' is an explicit per-agent opt-in → wins over the
        // global default 'auto'.
        expect(result.permissionMode).toBe('dontAsk');
      });
    });

    it('an explicit per-run requestedPermissionMode beats frontmatter and the global default', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        // Frontmatter opt-in 'dontAsk' AND injected global default 'auto' are both
        // present — the per-run override must outrank both.
        const content = `---\npermission_mode: dontAsk\n---\n`;
        const path = writeTempMd(tmpDir, 'per-run-override.md', content);
        const cfgRegistry = new WorkflowRegistry(dbAdapter(db), logger, makeConfig('auto'));
        cfgRegistry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        // requestedPermissionMode = 'acceptEdits' is the HIGHEST-precedence rung.
        const result = cfgRegistry.createRun(workflowId, undefined, TEST_SESSION_ID, 'acceptEdits');

        expect(result.permissionMode).toBe('acceptEdits');
        interface SnapshotRow { permission_mode_snapshot: string }
        const row = db.prepare('SELECT permission_mode_snapshot FROM workflow_runs WHERE id = ?').get(result.runId) as SnapshotRow;
        expect(row.permission_mode_snapshot).toBe('acceptEdits');
      });
    });

    it("floors to 'default' when no config is injected and the column is 'default' (test-fixture path)", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'no-config-floor.md', '---\n---\n');
        // `registry` (beforeEach) is constructed WITHOUT a config provider.
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const result = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        expect(result.permissionMode).toBe('default');
      });
    });

    // ───── substrate stamping (IDEA-013 / TASK-806) ─────

    it("stamps the default substrate 'sdk' when no override is set (zero-behavior-change)", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'substrate-default.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        const result = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        // Returned value floors to 'sdk'.
        expect(result.substrate).toBe('sdk');

        // And it is persisted on the row.
        interface SubstrateRow { substrate: string }
        const row = db.prepare('SELECT substrate FROM workflow_runs WHERE id = ?').get(result.runId) as SubstrateRow;
        expect(row.substrate).toBe('sdk');
      });
    });

    // ───── execution_model stamping (migration 032) ─────

    it("stamps the default execution model 'orchestrated' when no override is set (zero-behavior-change)", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'exec-default.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        const result = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        // Returned value floors to 'orchestrated'.
        expect(result.executionModel).toBe('orchestrated');

        // And it is persisted on the row.
        interface ExecRow { execution_model: string }
        const row = db.prepare('SELECT execution_model FROM workflow_runs WHERE id = ?').get(result.runId) as ExecRow;
        expect(row.execution_model).toBe('orchestrated');
      });
    });

    // ───── model stamping (migration 037) ─────

    it('stamps a NULL model when no per-run model is requested (no pin → SDK default)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'model-default.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        // sessionId (3rd arg) is required — a run can never be session-less.
        const result = registry.createRun(workflowId, undefined, 'sess-model');

        interface ModelRow { model: string | null }
        const row = db.prepare('SELECT model FROM workflow_runs WHERE id = ?').get(result.runId) as ModelRow;
        expect(row.model).toBeNull();
        // getRunById projects the same NULL.
        expect(registry.getRunById(result.runId)?.model ?? null).toBeNull();
      });
    });

    it('stamps the requested per-run model and getRunById projects it', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'model-opus.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        const result = registry.createRun(workflowId, undefined, 'sess-model', undefined, {
          requestedModel: 'opus',
        });

        interface ModelRow { model: string | null }
        const row = db.prepare('SELECT model FROM workflow_runs WHERE id = ?').get(result.runId) as ModelRow;
        expect(row.model).toBe('opus');
        expect(registry.getRunById(result.runId)?.model).toBe('opus');
      });
    });

    // ───── eval_enabled stamping (migration 044) ─────

    it('stamps a NULL eval_enabled when no per-run override is requested (inherit the global)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'eval-default.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        const result = registry.createRun(workflowId, undefined, 'sess-eval');

        interface EvalRow { eval_enabled: number | null }
        const row = db.prepare('SELECT eval_enabled FROM workflow_runs WHERE id = ?').get(result.runId) as EvalRow;
        expect(row.eval_enabled).toBeNull();
        expect(registry.getRunById(result.runId)?.eval_enabled ?? null).toBeNull();
      });
    });

    it('stamps eval_enabled=1 for an explicit per-run ON and getRunById projects it', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'eval-on.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        const result = registry.createRun(workflowId, undefined, 'sess-eval', undefined, {
          requestedEvalEnabled: true,
        });

        interface EvalRow { eval_enabled: number | null }
        const row = db.prepare('SELECT eval_enabled FROM workflow_runs WHERE id = ?').get(result.runId) as EvalRow;
        expect(row.eval_enabled).toBe(1);
        expect(registry.getRunById(result.runId)?.eval_enabled).toBe(1);
      });
    });

    it('stamps eval_enabled=0 for an explicit per-run OFF', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'eval-off.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        const result = registry.createRun(workflowId, undefined, 'sess-eval', undefined, {
          requestedEvalEnabled: false,
        });

        interface EvalRow { eval_enabled: number | null }
        const row = db.prepare('SELECT eval_enabled FROM workflow_runs WHERE id = ?').get(result.runId) as EvalRow;
        expect(row.eval_enabled).toBe(0);
        expect(registry.getRunById(result.runId)?.eval_enabled).toBe(0);
      });
    });

    it("stamps 'programmatic' on an SDK run when CYBOFLOW_EXECUTION_MODEL resolves it via the env override level", async () => {
      const prev = process.env.CYBOFLOW_EXECUTION_MODEL;
      process.env.CYBOFLOW_EXECUTION_MODEL = 'programmatic';
      try {
        await withTempDir('workflow-registry-test-', async (tmpDir) => {
          const path = writeTempMd(tmpDir, 'exec-programmatic.md', '---\n---\n');
          registry.seed(1, [{ name: 'planner', path }]);

          interface IdRow { id: string }
          const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
          // SDK substrate (default) — programmatic is available, so the env wins.
          const result = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

          expect(result.substrate).toBe('sdk');
          expect(result.executionModel).toBe('programmatic');

          interface ExecRow { execution_model: string }
          const row = db.prepare('SELECT execution_model FROM workflow_runs WHERE id = ?').get(result.runId) as ExecRow;
          expect(row.execution_model).toBe('programmatic');
        });
      } finally {
        if (prev === undefined) {
          delete process.env.CYBOFLOW_EXECUTION_MODEL;
        } else {
          process.env.CYBOFLOW_EXECUTION_MODEL = prev;
        }
      }
    });

    it("hard-pins 'orchestrated' on an interactive run even when the env requests 'programmatic' (PTY stays orchestrator-driven)", async () => {
      const prev = process.env.CYBOFLOW_EXECUTION_MODEL;
      process.env.CYBOFLOW_EXECUTION_MODEL = 'programmatic';
      try {
        await withTempDir('workflow-registry-test-', async (tmpDir) => {
          const path = writeTempMd(tmpDir, 'exec-interactive-pin.md', '---\n---\n');
          registry.seed(1, [{ name: 'compound', path }]);

          interface IdRow { id: string }
          const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('compound') as IdRow;
          // Explicit interactive substrate — the hard rule outranks the env override.
          const result = registry.createRun(workflowId, 'interactive', TEST_SESSION_ID);

          expect(result.substrate).toBe('interactive');
          expect(result.executionModel).toBe('orchestrated');

          interface ExecRow { execution_model: string }
          const row = db.prepare('SELECT execution_model FROM workflow_runs WHERE id = ?').get(result.runId) as ExecRow;
          expect(row.execution_model).toBe('orchestrated');
        });
      } finally {
        if (prev === undefined) {
          delete process.env.CYBOFLOW_EXECUTION_MODEL;
        } else {
          process.env.CYBOFLOW_EXECUTION_MODEL = prev;
        }
      }
    });

    it("honors an explicit opts.requestedExecutionModel='programmatic' on an SDK run (highest rung)", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'exec-requested.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        const result = registry.createRun(workflowId, undefined, TEST_SESSION_ID, undefined, {
          projectId: 1,
          requestedExecutionModel: 'programmatic',
        });

        expect(result.substrate).toBe('sdk');
        expect(result.executionModel).toBe('programmatic');
      });
    });

    it("ignores opts.requestedExecutionModel='programmatic' on an interactive run (hard-pin wins)", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'exec-requested-interactive.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const result = registry.createRun(workflowId, 'interactive', TEST_SESSION_ID, undefined, {
          projectId: 1,
          requestedExecutionModel: 'programmatic',
        });

        expect(result.substrate).toBe('interactive');
        expect(result.executionModel).toBe('orchestrated');
      });
    });

    it('getRunById round-trips the stamped execution model', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'exec-readback.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const { runId, executionModel } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        const run = registry.getRunById(runId);
        expect(run!.execution_model).toBe(executionModel);
        expect(run!.execution_model).toBe('orchestrated');
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
          const result = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

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

    // ───── session_id link (session<->run restructure, Phase 1 / migration 019) ─────

    it('writes session_id when a sessionId is supplied (session-hosted run)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'session-link.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        // The 3rd arg (sessionId) links the run to the owning chat session at INSERT.
        const { runId } = registry.createRun(workflowId, undefined, 'sess-123');

        interface SessionRow { session_id: string | null }
        const row = db.prepare('SELECT session_id FROM workflow_runs WHERE id = ?').get(runId) as SessionRow;
        expect(row.session_id).toBe('sess-123');
      });
    });

    it('throws when no sessionId is supplied (run cannot be session-less, slice 1b invariant)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'no-session-link.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;

        // The session invariant is the single hard chokepoint: a session-less run is
        // rejected outright (undefined as the 3rd positional sessionId arg). The throw
        // fires AFTER the workflow lookup, so a valid workflow id still reaches it.
        expect(() => registry.createRun(workflowId, undefined, undefined)).toThrow(
          'WorkflowRegistry.createRun: sessionId is required (run cannot be session-less)',
        );

        // No half-created row is left behind (the throw precedes the INSERT tx).
        const count = db
          .prepare('SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow_id = ?')
          .get(workflowId) as { n: number };
        expect(count.n).toBe(0);
      });
    });

    // ───── explicit launch projectId stamping (migration 030) ─────

    it('stamps the EXPLICIT launch projectId on a GLOBAL workflow (not the workflow\'s NULL project)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        // Global built-in (project_id NULL) launched against project 5.
        registry.ensureGlobalBuiltIns(buildDescriptors(tmpDir));

        interface IdRow { id: string }
        const { id: workflowId } = db
          .prepare("SELECT id FROM workflows WHERE name = 'planner' AND project_id IS NULL")
          .get() as IdRow;
        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID, undefined, { projectId: 5 });

        interface ProjectRow { project_id: number }
        const row = db.prepare('SELECT project_id FROM workflow_runs WHERE id = ?').get(runId) as ProjectRow;
        expect(row.project_id).toBe(5);
      });
    });

    it('the explicit launch projectId OVERRIDES a per-project workflow\'s own project_id', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        // A per-project row (project 1), but launched explicitly against project 9.
        const path = writeTempMd(tmpDir, 'override-project.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID, undefined, { projectId: 9 });

        interface ProjectRow { project_id: number }
        const row = db.prepare('SELECT project_id FROM workflow_runs WHERE id = ?').get(runId) as ProjectRow;
        // The explicit launch project wins over the workflow row's own project.
        expect(row.project_id).toBe(9);
      });
    });

    it('falls back to the workflow\'s own project_id when no explicit projectId is supplied (per-project path)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'fallback-project.md', '---\n---\n');
        registry.seed(4, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare("SELECT id FROM workflows WHERE project_id = 4").get() as IdRow;
        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        interface ProjectRow { project_id: number }
        const row = db.prepare('SELECT project_id FROM workflow_runs WHERE id = ?').get(runId) as ProjectRow;
        expect(row.project_id).toBe(4);
      });
    });

    it('throws when a GLOBAL workflow is launched WITHOUT an explicit projectId (no project to stamp)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        registry.ensureGlobalBuiltIns(buildDescriptors(tmpDir));

        interface IdRow { id: string }
        const { id: workflowId } = db
          .prepare("SELECT id FROM workflows WHERE name = 'planner' AND project_id IS NULL")
          .get() as IdRow;
        // No opts.projectId, and workflow.project_id is NULL → cannot stamp the
        // NOT-NULL workflow_runs.project_id.
        expect(() => registry.createRun(workflowId, undefined, TEST_SESSION_ID)).toThrow(/global.*projectId is required/i);
      });
    });

    it("stamps 'interactive' from the injected global default substrate", async () => {
      // The substrate TODO closure: the injected config's getDefaultSubstrate()
      // is threaded into resolveSubstrate as the globalDefaultSubstrate rung.
      // Ensure no env override masks the global-default rung under test.
      const prev = process.env.CYBOFLOW_SUBSTRATE;
      delete process.env.CYBOFLOW_SUBSTRATE;
      try {
        await withTempDir('workflow-registry-test-', async (tmpDir) => {
          const path = writeTempMd(tmpDir, 'substrate-global-default.md', '---\n---\n');
          const cfgRegistry = new WorkflowRegistry(
            dbAdapter(db),
            logger,
            makeConfig('default', 'interactive'),
          );
          cfgRegistry.seed(1, [{ name: 'sprint', path }]);

          interface IdRow { id: string }
          const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
          const result = cfgRegistry.createRun(workflowId, undefined, TEST_SESSION_ID);

          expect(result.substrate).toBe('interactive');
        });
      } finally {
        if (prev === undefined) {
          delete process.env.CYBOFLOW_SUBSTRATE;
        } else {
          process.env.CYBOFLOW_SUBSTRATE = prev;
        }
      }
    });

    // ───── spec_hash freeze + workflow_revisions snapshot (spec-capture / migration 026) ─────

    it("stamps spec_hash = computeSpecHash(workflow.spec_json) onto the run row (frozen at creation)", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'spec-hash-stamp.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface SpecRow { id: string; spec_json: string }
        const wf = db.prepare('SELECT id, spec_json FROM workflows WHERE name = ?').get('planner') as SpecRow;
        const { runId } = registry.createRun(wf.id, undefined, TEST_SESSION_ID);

        interface HashRow { spec_hash: string | null }
        const row = db.prepare('SELECT spec_hash FROM workflow_runs WHERE id = ?').get(runId) as HashRow;
        // Seeded rows carry the '{}' default; the stamped hash matches it exactly.
        expect(row.spec_hash).toBe(computeSpecHash(wf.spec_json));
        expect(row.spec_hash).toBe(computeSpecHash('{}'));
      });
    });

    it("reflects an edited spec_json in the run's frozen spec_hash", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'spec-hash-edited.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const edited = makeDefinition('planner');
        registry.updateSpec(workflowId, edited);

        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        interface HashRow { spec_hash: string | null }
        const row = db.prepare('SELECT spec_hash FROM workflow_runs WHERE id = ?').get(runId) as HashRow;
        // The frozen hash is the EDITED spec's hash, not the empty default.
        expect(row.spec_hash).toBe(computeSpecHash(JSON.stringify(edited)));
        expect(row.spec_hash).not.toBe(computeSpecHash('{}'));
      });
    });

    it("INSERT-OR-IGNOREs a workflow_revisions snapshot for the run's frozen spec", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'spec-hash-revision.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface SpecRow { id: string; spec_json: string }
        const wf = db.prepare('SELECT id, spec_json FROM workflows WHERE name = ?').get('sprint') as SpecRow;
        registry.createRun(wf.id, undefined, TEST_SESSION_ID);

        interface RevRow { workflow_id: string; spec_hash: string; spec_json: string }
        const rev = db
          .prepare('SELECT workflow_id, spec_hash, spec_json FROM workflow_revisions WHERE workflow_id = ?')
          .get(wf.id) as RevRow | undefined;
        expect(rev).toBeDefined();
        expect(rev!.spec_hash).toBe(computeSpecHash(wf.spec_json));
        expect(rev!.spec_json).toBe(wf.spec_json);
      });
    });

    it("snapshots the spec of a workflow that ONLY ever ran (never explicitly edited)", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        // A freshly-seeded workflow carries the '{}' default and was never saved
        // via the editor. createRun must still record its revision so the frozen
        // hash is resolvable to its spec text.
        const path = writeTempMd(tmpDir, 'spec-hash-run-only.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        interface CountRow { count: number }
        const { count } = db
          .prepare('SELECT COUNT(*) AS count FROM workflow_revisions WHERE workflow_id = ? AND spec_hash = ?')
          .get(workflowId, computeSpecHash('{}')) as CountRow;
        expect(count).toBe(1);
      });
    });

    it("does NOT duplicate the revision when two runs share the same spec (OR IGNORE)", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'spec-hash-dedup.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        registry.createRun(workflowId, undefined, TEST_SESSION_ID);
        registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        interface CountRow { count: number }
        const { count } = db
          .prepare('SELECT COUNT(*) AS count FROM workflow_revisions WHERE workflow_id = ?')
          .get(workflowId) as CountRow;
        // Both runs froze the SAME '{}' spec → one revision row, not two.
        expect(count).toBe(1);
      });
    });

    it("leaves spec_hash unmodified after the run — no UPDATE path (frozen)", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'spec-hash-frozen.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        interface HashRow { spec_hash: string | null }
        const before = db.prepare('SELECT spec_hash FROM workflow_runs WHERE id = ?').get(runId) as HashRow;

        // Editing the workflow's live spec AFTER the run must not move the frozen
        // hash — createRun is the only writer and there is no UPDATE path.
        registry.updateSpec(workflowId, makeDefinition('planner'));

        const after = db.prepare('SELECT spec_hash FROM workflow_runs WHERE id = ?').get(runId) as HashRow;
        expect(after.spec_hash).toBe(before.spec_hash);
        expect(after.spec_hash).toBe(computeSpecHash('{}'));
      });
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
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

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
        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

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
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

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
        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

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
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const { runId, substrate } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

        const run = registry.getRunById(runId);
        expect(run).not.toBeNull();
        expect(run!.substrate).toBe(substrate);
        expect(run!.substrate).toBe('sdk');
      });
    });

    it("createRun stamps the explicit per-run substrate override ('interactive')", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'substrate-requested.md', '---\n---\n');
        registry.seed(1, [{ name: 'sprint', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;
        // The per-run UI choice (WorkflowPicker → runs.start → launch) is threaded
        // as the highest-precedence override and must be stamped onto the row.
        const { runId, substrate } = registry.createRun(workflowId, 'interactive', TEST_SESSION_ID);

        expect(substrate).toBe('interactive');
        const run = registry.getRunById(runId);
        expect(run!.substrate).toBe('interactive');
      });
    });

    it('substrate is immutable for the run — a second read returns the same value (no in-flight mutation path)', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        const path = writeTempMd(tmpDir, 'substrate-immutable.md', '---\n---\n');
        registry.seed(1, [{ name: 'planner', path }]);

        interface IdRow { id: string }
        const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;
        const { runId } = registry.createRun(workflowId, undefined, TEST_SESSION_ID);

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
        const row = registry.getById('wf-1-planner');
        expect(row).not.toBeNull();
        // Seeded rows fall back to the schema default of '{}'.
        expect(row!.spec_json).toBe('{}');
      });
    });

    it('getById round-trips a non-default spec_json written directly', () => {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-planner', 1, 'planner', ?, 'default')`,
      ).run(JSON.stringify(makeDefinition('planner')));

      const row = registry.getById('wf-1-planner');
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.spec_json)).toEqual(makeDefinition('planner'));
    });

    it('listByProject projects spec_json on every returned row', async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        registry.seed(1, buildDescriptors(tmpDir));
        const rows = registry.listByProject(1);
        expect(rows).toHaveLength(CYBOFLOW_WORKFLOW_NAMES.length);
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
         VALUES ('wf-1-planner', 1, 'planner', '{}', 'default')`,
      ).run();

      const definition = makeDefinition('planner');
      registry.updateSpec('wf-1-planner', definition);

      interface SpecRow { spec_json: string }
      const row = db.prepare('SELECT spec_json FROM workflows WHERE id = ?').get('wf-1-planner') as SpecRow;
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

    // ───── revision snapshot on edit (spec-capture / migration 026) ─────

    it('INSERT-OR-IGNOREs a workflow_revisions snapshot for the edited spec', () => {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-planner', 1, 'planner', '{}', 'default')`,
      ).run();

      const definition = makeDefinition('planner');
      registry.updateSpec('wf-1-planner', definition);

      interface RevRow { spec_hash: string; spec_json: string }
      const rev = db
        .prepare('SELECT spec_hash, spec_json FROM workflow_revisions WHERE workflow_id = ?')
        .get('wf-1-planner') as RevRow | undefined;
      expect(rev).toBeDefined();
      expect(rev!.spec_json).toBe(JSON.stringify(definition));
      expect(rev!.spec_hash).toBe(computeSpecHash(JSON.stringify(definition)));
    });

    it('adds a SECOND revision when the spec is edited to a distinct value', () => {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-planner', 1, 'planner', '{}', 'default')`,
      ).run();

      const first = makeDefinition('planner');
      const second = makeDefinition('planner');
      second.phases[0].label = 'Edited Plan'; // distinct spec text → distinct hash
      registry.updateSpec('wf-1-planner', first);
      registry.updateSpec('wf-1-planner', second);

      interface CountRow { count: number }
      const { count } = db
        .prepare('SELECT COUNT(*) AS count FROM workflow_revisions WHERE workflow_id = ?')
        .get('wf-1-planner') as CountRow;
      expect(count).toBe(2);
    });

    it('re-saving the SAME spec does NOT duplicate the revision (OR IGNORE)', () => {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-planner', 1, 'planner', '{}', 'default')`,
      ).run();

      const definition = makeDefinition('planner');
      registry.updateSpec('wf-1-planner', definition);
      registry.updateSpec('wf-1-planner', definition); // identical re-save

      interface CountRow { count: number }
      const { count } = db
        .prepare('SELECT COUNT(*) AS count FROM workflow_revisions WHERE workflow_id = ?')
        .get('wf-1-planner') as CountRow;
      // UNIQUE(workflow_id, spec_hash) makes the second save idempotent.
      expect(count).toBe(1);
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

    // ───── revision snapshot on reset (spec-capture / migration 026) ─────

    it("INSERT-OR-IGNOREs a workflow_revisions snapshot for the reset-to-'{}' spec", () => {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-sprint', 1, 'sprint', ?, 'default')`,
      ).run(JSON.stringify(makeDefinition('sprint')));

      registry.resetSpec('wf-1-sprint');

      interface RevRow { spec_hash: string; spec_json: string }
      const rev = db
        .prepare('SELECT spec_hash, spec_json FROM workflow_revisions WHERE workflow_id = ?')
        .get('wf-1-sprint') as RevRow | undefined;
      expect(rev).toBeDefined();
      expect(rev!.spec_json).toBe('{}');
      expect(rev!.spec_hash).toBe(computeSpecHash('{}'));
    });
  });

  // -------------------------------------------------------------------------
  // createCustom (editor "Save as new flow")
  // -------------------------------------------------------------------------

  describe('createCustom', () => {
    it('inserts a PROJECT-scoped row with a generated id and returns it with spec_json + permission_mode', () => {
      const definition = makeDefinition('my-flow');
      const row = registry.createCustom({
        projectId: 1,
        name: 'My Flow',
        specJson: JSON.stringify(definition),
        permissionMode: 'acceptEdits',
      });

      // Generated id for a project copy: wf-<projectId>-custom-<8 lowercase hex chars>.
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

    // ───── global scope (migration 030 — the new default) ─────

    it('inserts a GLOBAL row (project_id NULL, id wf-global-custom-<hex>) when projectId is null', () => {
      const definition = makeDefinition('global-flow');
      const row = registry.createCustom({
        projectId: null,
        name: 'Global Flow',
        specJson: JSON.stringify(definition),
        permissionMode: 'acceptEdits',
      });

      expect(row.id).toMatch(/^wf-global-custom-[0-9a-f]{8}$/);
      expect(row.project_id).toBeNull();
      expect(row.name).toBe('Global Flow');
      expect(row.permission_mode).toBe('acceptEdits');
      expect(JSON.parse(row.spec_json)).toEqual(definition);
    });

    it('a GLOBAL custom flow surfaces in EVERY project via listByProject', () => {
      const row = registry.createCustom({
        projectId: null,
        name: 'Everywhere Flow',
        specJson: JSON.stringify(makeDefinition('everywhere-flow')),
      });
      expect(registry.listByProject(1).map((r) => r.id)).toContain(row.id);
      expect(registry.listByProject(42).map((r) => r.id)).toContain(row.id);
    });

    it('defaults specJson to "{}" and permissionMode to "default" when omitted', () => {
      const row = registry.createCustom({ projectId: 7, name: 'Default Mode Flow' });
      expect(row.permission_mode).toBe('default');
      expect(row.spec_json).toBe('{}');
    });

    it('rejects a name that collides with a built-in workflow name (any scope)', () => {
      for (const builtIn of ['planner', 'sprint']) {
        expect(
          () => registry.createCustom({ projectId: 1, name: builtIn }),
          `built-in name '${builtIn}' should be rejected`,
        ).toThrow(/reserved/i);
        expect(
          () => registry.createCustom({ projectId: null, name: builtIn }),
          `built-in name '${builtIn}' should be rejected globally`,
        ).toThrow(/reserved/i);
      }
    });

    it('rejects the __quick__ sentinel name', () => {
      expect(
        () => registry.createCustom({ projectId: 1, name: QUICK_WORKFLOW_NAME }),
      ).toThrow(/reserved/i);
    });

    it('rejects a name that collides with an existing GLOBAL flow (for any scope)', () => {
      registry.createCustom({ projectId: null, name: 'Global Name' });
      // A second GLOBAL flow with the same name is rejected.
      expect(
        () => registry.createCustom({ projectId: null, name: 'Global Name' }),
      ).toThrow(/global workflow named/i);
      // A PROJECT copy that would shadow the global name is also rejected.
      expect(
        () => registry.createCustom({ projectId: 1, name: 'Global Name' }),
      ).toThrow(/global workflow named/i);
    });

    it('rejects a name that collides with an existing row in the SAME project', () => {
      registry.createCustom({ projectId: 1, name: 'Duplicate' });
      expect(
        () => registry.createCustom({ projectId: 1, name: 'Duplicate' }),
      ).toThrow(/already exists in this project/i);
    });

    it('allows the same name in a DIFFERENT project (project collision is per-project)', () => {
      const rowA = registry.createCustom({ projectId: 1, name: 'Shared Name' });
      const rowB = registry.createCustom({ projectId: 2, name: 'Shared Name' });
      expect(rowA.project_id).toBe(1);
      expect(rowB.project_id).toBe(2);
      expect(rowA.id).not.toBe(rowB.id);
    });

    it('does NOT insert a row when the name is rejected', () => {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-planner', 1, 'planner', '{}', 'default')`,
      ).run();

      expect(() => registry.createCustom({ projectId: 1, name: 'planner' })).toThrow();

      interface CountRow { count: number }
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM workflows WHERE project_id = 1').get() as CountRow;
      // Only the row we seeded directly — no custom row was inserted.
      expect(count).toBe(1);
    });

    it('a created project-scoped custom flow appears in listByProject', () => {
      // Seed a resolvable spec (the UI always seeds a non-empty skeleton): a custom
      // name with the default '{}' spec resolves to null and is filtered from the list.
      const row = registry.createCustom({
        projectId: 3,
        name: 'Listed Flow',
        specJson: JSON.stringify(WORKFLOW_DEFINITIONS.planner),
      });
      const rows = registry.listByProject(3);
      expect(rows.map((r) => r.id)).toContain(row.id);
    });

    it('resolveWorkflowDefinition-shaped: the persisted spec is the built-in clone when cloned from one', () => {
      // Custom flows are commonly created by cloning a built-in then renaming.
      // Confirm an arbitrary built-in definition survives the round-trip.
      const cloned = WORKFLOW_DEFINITIONS.planner;
      const row = registry.createCustom({
        projectId: 9,
        name: 'Cloned Planner',
        specJson: JSON.stringify(cloned),
      });
      expect(JSON.parse(row.spec_json)).toEqual(cloned);
    });
  });

  // -------------------------------------------------------------------------
  // deleteWorkflow (gallery "Delete")
  // -------------------------------------------------------------------------

  describe('deleteWorkflow', () => {
    it('deletes a project-scoped custom flow with no runs', () => {
      const row = registry.createCustom({
        projectId: 1,
        name: 'Disposable Flow',
        specJson: JSON.stringify(makeDefinition('disposable-flow')),
      });
      registry.deleteWorkflow(row.id);
      expect(registry.getById(row.id)).toBeNull();
    });

    it('deletes a GLOBAL custom flow with no runs', () => {
      const row = registry.createCustom({
        projectId: null,
        name: 'Global Disposable',
        specJson: JSON.stringify(makeDefinition('global-disposable')),
      });
      registry.deleteWorkflow(row.id);
      expect(registry.getById(row.id)).toBeNull();
    });

    it("throws 'not found' for an unknown id", () => {
      expect(() => registry.deleteWorkflow('nope')).toThrow(/not found/i);
    });

    it("refuses ('reserved') to delete a GLOBAL built-in, leaving the row intact", async () => {
      await withTempDir('workflow-registry-test-', async (tmpDir) => {
        registry.ensureGlobalBuiltIns(buildDescriptors(tmpDir));
        expect(() => registry.deleteWorkflow('wf-global-planner')).toThrow(/reserved/i);
        expect(registry.getById('wf-global-planner')).not.toBeNull();
      });
    });

    it("refuses ('reserved') to delete the __quick__ sentinel", () => {
      const quickId = registry.ensureQuickWorkflow(1);
      expect(() => registry.deleteWorkflow(quickId)).toThrow(/reserved/i);
      expect(registry.getById(quickId)).not.toBeNull();
    });

    it("refuses ('run history') to delete a flow that has runs, preserving the row", () => {
      const row = registry.createCustom({
        projectId: 1,
        name: 'Has Runs',
        specJson: JSON.stringify(makeDefinition('has-runs')),
      });
      registry.createRun(row.id, undefined, TEST_SESSION_ID);
      expect(() => registry.deleteWorkflow(row.id)).toThrow(/run history/i);
      // The flow is preserved so its run history is never orphaned/destroyed.
      expect(registry.getById(row.id)).not.toBeNull();
    });

    it('allows deleting an EDITED per-project built-in (project copy) with no runs', () => {
      // A per-project built-in row preserved by migration 030: the NAME is a
      // built-in but project_id is set → NOT a global built-in, so it is
      // deletable (the global built-in row is a separate wf-global-<name> row).
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json, permission_mode)
         VALUES ('wf-1-planner', 1, 'planner', ?, 'default')`,
      ).run(JSON.stringify(makeDefinition('planner')));
      registry.deleteWorkflow('wf-1-planner');
      expect(registry.getById('wf-1-planner')).toBeNull();
    });
  });
});
