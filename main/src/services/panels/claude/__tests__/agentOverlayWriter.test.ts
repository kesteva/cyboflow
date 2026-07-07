/**
 * Tests for agentOverlayWriter (agent gallery / migration 028).
 *
 * Covers:
 *   (AC-P1-8 overlay-content) renderAgentMarkdown output for an override and a
 *     custom agent is well-formed frontmatter (name → description → tools),
 *     contains a "## Result" section, and never contains a `cyboflow_` MCP token.
 *   (AC-P1-6 integration) over a real tmp worktree + in-memory DB:
 *     - a run with NULL workflow_path (custom/quick flow) still gets the full
 *       built-in overlay (cyboflow-implement.md) PLUS any custom agent
 *       (cyboflow-foo.md);
 *     - a builtin-implement override is written with the override BODY;
 *     - deleting the override row + re-running reverts cyboflow-implement.md to
 *       the bundled content (verbatim rawContent).
 *
 * Hermetic: each test uses a fresh os.tmpdir() worktree + a fresh :memory: DB.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { installAgentOverlay } from '../agentOverlayWriter';
import { renderAgentMarkdown } from '../../../../orchestrator/agents/agentMarkdown';
import { ensureResultSection } from '../../../../orchestrator/agents/agentValidation';
import { loadBuiltInAgents } from '../../../../orchestrator/agents/agentCatalogue';
import { makeSpyLogger } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';

function tmpWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-overlay-'));
}

const agentsDir = (wt: string) => path.join(wt, '.claude', 'agents');
const agentFile = (wt: string, key: string) =>
  path.join(agentsDir(wt), `cyboflow-${key}.md`);

/**
 * Minimal schema sufficient for installAgentOverlay: projects, workflow_runs
 * (only id + project_id are read), and the migration-028 agent_overrides table.
 */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, project_id INTEGER, workflow_path TEXT);
    CREATE TABLE agent_overrides (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      agent_key TEXT NOT NULL,
      base_agent_key TEXT,
      name TEXT NOT NULL,
      role TEXT,
      description TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      is_custom INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, agent_key)
    );
  `);
  return db;
}

function insertProject(db: Database.Database, name: string): number {
  const info = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

function insertRun(
  db: Database.Database,
  id: string,
  projectId: number,
  workflowPath: string | null,
): void {
  db.prepare('INSERT INTO workflow_runs (id, project_id, workflow_path) VALUES (?, ?, ?)').run(
    id,
    projectId,
    workflowPath,
  );
}

interface OverrideInput {
  agentKey: string;
  baseAgentKey: string | null;
  description: string;
  systemPrompt: string;
  tools: string[];
  isCustom: boolean;
  /** Optional pinned model alias (migration 036); omit/null = inherit run model. */
  model?: string | null;
}

function insertOverride(db: Database.Database, projectId: number, o: OverrideInput): void {
  db.prepare(
    `INSERT INTO agent_overrides
       (id, project_id, agent_key, base_agent_key, name, role, description, system_prompt, tools_json, is_custom, version, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    `ago_${o.agentKey}`,
    projectId,
    o.agentKey,
    o.baseAgentKey,
    `cyboflow-${o.agentKey}`,
    o.isCustom ? 'custom' : null,
    o.description,
    o.systemPrompt,
    JSON.stringify(o.tools),
    o.isCustom ? 1 : 0,
    o.model ?? null,
  );
}

describe('agentOverlayWriter — overlay content (AC-P1-8)', () => {
  it('renders well-formed frontmatter with a Result section and no cyboflow_ token', () => {
    const overrideMd = renderAgentMarkdown({
      agentKey: 'implement',
      description: 'Implements: tasks (colon forces YAML quoting)',
      tools: ['Read', 'Edit', 'Write', 'Bash'],
      enabledMcps: [],
      systemPrompt: ensureResultSection('Do the work carefully.'),
    });

    expect(overrideMd).toMatch(/^---[\s\S]*name:[\s\S]*description:[\s\S]*tools:/);
    expect(overrideMd).toContain('name: cyboflow-implement');
    expect(overrideMd).toContain('## Result');
    expect(overrideMd).not.toMatch(/cyboflow_/);

    const customMd = renderAgentMarkdown({
      agentKey: 'foo',
      description: 'A custom helper agent.',
      tools: ['Read', 'Grep'],
      enabledMcps: [],
      systemPrompt: ensureResultSection('Help with foo.'),
    });

    expect(customMd).toMatch(/^---[\s\S]*name:[\s\S]*description:[\s\S]*tools:/);
    expect(customMd).toContain('name: cyboflow-foo');
    expect(customMd).toContain('## Result');
    expect(customMd).not.toMatch(/cyboflow_/);
  });

  it('emits a model: frontmatter line ONLY when a model is pinned (after tools)', () => {
    const inheritMd = renderAgentMarkdown({
      agentKey: 'implement',
      description: 'Inherits the run model.',
      tools: ['Read', 'Edit'],
      enabledMcps: [],
      systemPrompt: ensureResultSection('Do the work.'),
    });
    expect(inheritMd).not.toMatch(/^model:/m);

    const pinnedMd = renderAgentMarkdown({
      agentKey: 'implement',
      description: 'Pinned to a concrete model.',
      tools: ['Read', 'Edit'],
      enabledMcps: [],
      systemPrompt: ensureResultSection('Do the work.'),
      model: 'claude-sonnet-5',
    });
    // model is rendered last, after tools, inside the frontmatter fence.
    expect(pinnedMd).toMatch(/tools:[^\n]*\nmodel: claude-sonnet-5\n---/);
  });
});

describe('agentOverlayWriter — installAgentOverlay integration (AC-P1-6)', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = tmpWorktree();
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('writes the full builtin overlay + custom agent for a NULL-workflow_path run', () => {
    const db = makeDb();
    const projectId = insertProject(db, 'Acme');
    insertRun(db, 'run-custom', projectId, null);
    insertOverride(db, projectId, {
      agentKey: 'foo',
      baseAgentKey: null,
      description: 'Custom foo agent.',
      systemPrompt: 'Foo work.\n\n## Result\nstub',
      tools: ['Read', 'Grep'],
      isCustom: true,
    });

    installAgentOverlay(db, 'run-custom', worktree, makeSpyLogger());

    // A builtin lands even with no sibling bundle (custom/quick flow).
    expect(fs.existsSync(agentFile(worktree, 'implement'))).toBe(true);
    // The custom agent lands too.
    expect(fs.existsSync(agentFile(worktree, 'foo'))).toBe(true);

    const fooMd = fs.readFileSync(agentFile(worktree, 'foo'), 'utf8');
    expect(fooMd).toContain('name: cyboflow-foo');
    expect(fooMd).toContain('Foo work.');

    db.close();
  });

  it('writes the override body for a builtin-implement override, and reverts after delete', () => {
    const db = makeDb();
    const projectId = insertProject(db, 'Acme');
    insertRun(db, 'run-override', projectId, null);

    const OVERRIDE_BODY = 'OVERRIDDEN implement body — do it my way.\n\n## Result\nstub';
    insertOverride(db, projectId, {
      agentKey: 'implement',
      baseAgentKey: 'implement',
      description: 'My implement override.',
      systemPrompt: OVERRIDE_BODY,
      tools: ['Read', 'Edit', 'Write'],
      isCustom: false,
    });

    installAgentOverlay(db, 'run-override', worktree, makeSpyLogger());

    const overriddenMd = fs.readFileSync(agentFile(worktree, 'implement'), 'utf8');
    expect(overriddenMd).toContain('name: cyboflow-implement');
    expect(overriddenMd).toContain('OVERRIDDEN implement body');

    // Bundled content (the verbatim rawContent the builtin would write unoverridden).
    const bundled = loadBuiltInAgents().get('implement')?.rawContent;
    expect(bundled).toBeTruthy();
    expect(overriddenMd).not.toBe(bundled);

    // Delete the override + re-run → reverts to the bundled rawContent verbatim.
    db.prepare('DELETE FROM agent_overrides WHERE project_id = ? AND agent_key = ?').run(
      projectId,
      'implement',
    );
    installAgentOverlay(db, 'run-override', worktree, makeSpyLogger());

    const revertedMd = fs.readFileSync(agentFile(worktree, 'implement'), 'utf8');
    expect(revertedMd).toBe(bundled);

    db.close();
  });

  it('resolves a pinned model alias to its bare concrete id in the written .md', () => {
    const db = makeDb();
    const projectId = insertProject(db, 'Acme');
    insertRun(db, 'run-model', projectId, null);

    // A builtin override pinned to Opus, a custom agent pinned to Sonnet, and an
    // inherit-model custom (no model) — assert the frontmatter per case.
    insertOverride(db, projectId, {
      agentKey: 'implement',
      baseAgentKey: 'implement',
      description: 'Opus implement.',
      systemPrompt: 'Body.\n\n## Result\nstub',
      tools: ['Read', 'Edit'],
      isCustom: false,
      model: 'opus',
    });
    insertOverride(db, projectId, {
      agentKey: 'sonnet-helper',
      baseAgentKey: null,
      description: 'Sonnet helper.',
      systemPrompt: 'Body.\n\n## Result\nstub',
      tools: ['Read'],
      isCustom: true,
      model: 'sonnet',
    });
    insertOverride(db, projectId, {
      agentKey: 'inherit-helper',
      baseAgentKey: null,
      description: 'Inherits the run model.',
      systemPrompt: 'Body.\n\n## Result\nstub',
      tools: ['Read'],
      isCustom: true,
      model: null,
    });

    installAgentOverlay(db, 'run-model', worktree, makeSpyLogger());

    // Opus pins the bare default-window snapshot (the [1m] marker is stripped).
    expect(fs.readFileSync(agentFile(worktree, 'implement'), 'utf8')).toContain(
      'model: claude-opus-4-8\n',
    );
    expect(fs.readFileSync(agentFile(worktree, 'sonnet-helper'), 'utf8')).toContain(
      'model: claude-sonnet-5\n',
    );
    // An inherit-model agent emits NO model line.
    expect(fs.readFileSync(agentFile(worktree, 'inherit-helper'), 'utf8')).not.toMatch(/^model:/m);

    db.close();
  });

  it('is a no-op (no throw, no dir) when the run row is missing', () => {
    const db = makeDb();
    const logger = makeSpyLogger();

    expect(() => installAgentOverlay(db, 'nonexistent', worktree, logger)).not.toThrow();
    expect(fs.existsSync(agentsDir(worktree))).toBe(false);

    db.close();
  });

  it('writes the pure builtin set (no throw) when agent_overrides table is absent', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, project_id INTEGER, workflow_path TEXT);
    `);
    const projectId = insertProject(db, 'Acme');
    insertRun(db, 'run-no-table', projectId, null);

    expect(() => installAgentOverlay(db, 'run-no-table', worktree, makeSpyLogger())).not.toThrow();
    expect(fs.existsSync(agentFile(worktree, 'implement'))).toBe(true);

    db.close();
  });
});

describe('agentOverlayWriter — variant agent deltas (A/B testing, migration 048)', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = tmpWorktree();
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  /** DB with the migration-048 variant surface: run.variant_id + workflow_variants. */
  function makeVariantDb(): Database.Database {
    const db = makeDb();
    db.exec('ALTER TABLE workflow_runs ADD COLUMN variant_id TEXT');
    db.exec(`
      CREATE TABLE workflow_variants (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, label TEXT NOT NULL,
        spec_json TEXT NOT NULL DEFAULT '{}', agent_overrides_json TEXT, model TEXT, execution_model TEXT,
        weight INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT, updated_at TEXT
      );
    `);
    return db;
  }

  function insertVariant(db: Database.Database, id: string, agentOverridesJson: string | null): void {
    db.prepare(
      "INSERT INTO workflow_variants (id, workflow_id, label, agent_overrides_json) VALUES (?, 'wf-1', ?, ?)",
    ).run(id, id, agentOverridesJson);
  }

  function insertVariantRun(db: Database.Database, id: string, projectId: number, variantId: string | null): void {
    db.prepare('INSERT INTO workflow_runs (id, project_id, workflow_path, variant_id) VALUES (?, ?, NULL, ?)').run(
      id,
      projectId,
      variantId,
    );
  }

  it('applies a variant prompt delta over an unoverridden builtin (renders the variant body, not the bundled one)', () => {
    const db = makeVariantDb();
    const projectId = insertProject(db, 'Acme');
    insertVariant(db, 'wfv_1', JSON.stringify({ implement: { systemPrompt: 'VARIANT IMPLEMENT BODY.\n\n## Result\nstub' } }));
    insertVariantRun(db, 'run-variant', projectId, 'wfv_1');

    installAgentOverlay(db, 'run-variant', worktree, makeSpyLogger());

    const md = fs.readFileSync(agentFile(worktree, 'implement'), 'utf8');
    expect(md).toContain('VARIANT IMPLEMENT BODY.');
    const bundled = loadBuiltInAgents().get('implement')?.rawContent;
    expect(md).not.toBe(bundled); // rawContent dropped, rendered via renderAgentMarkdown

    db.close();
  });

  it('variant delta WINS over a project override for the touched agent', () => {
    const db = makeVariantDb();
    const projectId = insertProject(db, 'Acme');
    insertOverride(db, projectId, {
      agentKey: 'implement',
      baseAgentKey: 'implement',
      description: 'Project override.',
      systemPrompt: 'PROJECT BODY.\n\n## Result\nstub',
      tools: ['Read', 'Edit'],
      isCustom: false,
    });
    insertVariant(db, 'wfv_1', JSON.stringify({ implement: { systemPrompt: 'VARIANT BODY.\n\n## Result\nstub' } }));
    insertVariantRun(db, 'run-variant', projectId, 'wfv_1');

    installAgentOverlay(db, 'run-variant', worktree, makeSpyLogger());

    const md = fs.readFileSync(agentFile(worktree, 'implement'), 'utf8');
    expect(md).toContain('VARIANT BODY.');
    expect(md).not.toContain('PROJECT BODY.');

    db.close();
  });

  it('is fail-soft: malformed agent_overrides_json writes the project overlay unchanged', () => {
    const db = makeVariantDb();
    const projectId = insertProject(db, 'Acme');
    insertVariant(db, 'wfv_bad', '{not valid json');
    insertVariantRun(db, 'run-bad', projectId, 'wfv_bad');

    expect(() => installAgentOverlay(db, 'run-bad', worktree, makeSpyLogger())).not.toThrow();
    // The builtin overlay still lands verbatim (no delta applied).
    const md = fs.readFileSync(agentFile(worktree, 'implement'), 'utf8');
    const bundled = loadBuiltInAgents().get('implement')?.rawContent;
    expect(md).toBe(bundled);

    db.close();
  });

  it('applies nothing for a baseline run (variant_id NULL)', () => {
    const db = makeVariantDb();
    const projectId = insertProject(db, 'Acme');
    insertVariantRun(db, 'run-baseline', projectId, null);

    installAgentOverlay(db, 'run-baseline', worktree, makeSpyLogger());

    const md = fs.readFileSync(agentFile(worktree, 'implement'), 'utf8');
    const bundled = loadBuiltInAgents().get('implement')?.rawContent;
    expect(md).toBe(bundled);

    db.close();
  });
});
