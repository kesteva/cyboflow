/**
 * End-to-end coverage for the tuning-level `promptAddendum` append (plan D5) at
 * the seam that actually feeds a spawn: `resolveRunEffectiveAgents` /
 * `installAgentOverlay`.
 *
 * The unit-level behaviour lives in
 * `orchestrator/agents/__tests__/effectiveAgents.applyPromptAddenda.test.ts`.
 * What THIS file proves is the wiring the unit test cannot see:
 *   - the addendum is read off the run's FROZEN workflow spec (the same source
 *     `readWorkflowAgentConfigs` already uses), and
 *   - it survives all the way onto the written `.claude/agents/cyboflow-*.md`,
 *     which only happens because the append drops `rawContent` — an unoverridden
 *     builtin is otherwise written verbatim from the bundle and the addendum would
 *     be silently lost.
 *
 * Hermetic: fresh tmp worktree + fresh :memory: DB per test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { installAgentOverlay, resolveRunEffectiveAgents } from '../agentOverlayWriter';
import { materializeForLevel } from '../../../../../../shared/tuning/workflowTuning';

const ADDENDUM_HEADING = '## Tuning-level addendum';

/**
 * Minimal schema for the frozen-spec read path: `resolveRunFrozenSpec` joins
 * `workflow_runs` -> `workflows`, then probes `spec_hash`. The column is absent
 * here on purpose — that is the documented degrade-to-live-spec path, and it lets
 * the fixture put the materialized preset straight in `workflows.spec_json`.
 */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, spec_json TEXT);
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, project_id INTEGER, workflow_id TEXT);
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
      enabled_mcps_json TEXT,
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

/** Seed a project + a sprint workflow frozen at `specJson` + a run pointing at it. */
function seedRun(db: Database.Database, specJson: string): string {
  const projectId = Number(
    db.prepare("INSERT INTO projects (name) VALUES ('p')").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO workflows (id, name, spec_json) VALUES ('wf1', 'sprint', ?)").run(
    specJson,
  );
  db.prepare(
    "INSERT INTO workflow_runs (id, project_id, workflow_id) VALUES ('run1', ?, 'wf1')",
  ).run(projectId);
  return 'run1';
}

/** The sprint-efficient preset spec — the real calibration, not a hand-built fake. */
const EFFICIENT_SPRINT_SPEC = materializeForLevel('sprint', '', 'efficient');

let worktree: string;
let db: Database.Database;

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-addendum-'));
  db = makeDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(worktree, { recursive: true, force: true });
});

describe('resolveRunEffectiveAgents — promptAddendum from the frozen spec', () => {
  it('appends the efficient preset addendum to the implement agent only', () => {
    const runId = seedRun(db, EFFICIENT_SPRINT_SPEC);
    const effective = resolveRunEffectiveAgents(db, runId);

    const implement = effective.find((a) => a.agentKey === 'implement');
    expect(implement).toBeDefined();
    expect(implement?.systemPrompt).toContain(ADDENDUM_HEADING);
    expect(implement?.systemPrompt).toContain('MERGED implementation lane');
    // The builtin body is still there, underneath the addendum.
    expect(implement?.systemPrompt).toContain('cyboflow Sprint **implement** subagent');

    // No other agent picks it up.
    for (const agent of effective) {
      if (agent.agentKey === 'implement') continue;
      expect(agent.systemPrompt).not.toContain(ADDENDUM_HEADING);
    }
  });

  it('a standard run applies ONLY the aligned model pins — the prompts stay untouched', () => {
    // Standard carries the aligned-defaults pins (model/effort per agent) and
    // nothing else: modulo the fields pin-application touches (the pin values,
    // the dropped rawContent, the builtin -> builtin-override source flip, and
    // the runtime keys it materializes as undefined) the agents are
    // byte-identical to a run with no spec at all, and no prompt anywhere gains
    // an addendum.
    const stripPins = (agents: ReturnType<typeof resolveRunEffectiveAgents>) =>
      agents.map(
        ({
          model: _m,
          effort: _e,
          rawContent: _r,
          source: _s,
          runtime: _rt,
          providerModel: _pm,
          codexModel: _cm,
          ...rest
        }) => rest,
      );

    const standardRunId = seedRun(db, materializeForLevel('sprint', '', 'standard'));
    const standard = resolveRunEffectiveAgents(db, standardRunId);
    expect(standard.find((a) => a.agentKey === 'implement')?.model).toBe('sonnet');

    const bare = makeDb();
    try {
      const bareRunId = seedRun(bare, '');
      expect(stripPins(standard)).toEqual(stripPins(resolveRunEffectiveAgents(bare, bareRunId)));
    } finally {
      bare.close();
    }
    // And nothing anywhere carries an addendum.
    for (const agent of standard) {
      expect(agent.systemPrompt).not.toContain(ADDENDUM_HEADING);
    }
  });

  it('the addendum reaches the written .md (rawContent is not used as a shortcut)', () => {
    const runId = seedRun(db, EFFICIENT_SPRINT_SPEC);
    installAgentOverlay(db, runId, worktree);

    const written = fs.readFileSync(
      path.join(worktree, '.claude', 'agents', 'cyboflow-implement.md'),
      'utf8',
    );
    expect(written).toContain(ADDENDUM_HEADING);
    expect(written).toContain('you also author the unit tests covering it');
    // The frontmatter still names the agent correctly and the base body survives.
    expect(written.startsWith('---\nname: cyboflow-implement\n')).toBe(true);
    expect(written).toContain('cyboflow Sprint **implement** subagent');
  });
});
