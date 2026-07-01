/**
 * entitySchemaParity — pins the 3 entity row interfaces + EntityEventRow against
 * their SQL columns (migration 015_entity_model_rebuild.sql + the archived_at
 * column added by 024_archive_in_place.sql).
 *
 * Each table is introspected INDEPENDENTLY via PRAGMA table_info, then compared
 * to the explicit key list of its row interface. Listing the keys explicitly
 * (rather than from a runtime object) keeps the test compile-time-checked: a
 * row-interface field rename fails `tsc` (the `keyof X` array), and a column
 * rename fails the runtime assertion here.
 *
 * This is the P1 ATOMICITY gate — it guarantees IdeaRow/EpicRow/TaskRow/
 * EntityEventRow stay field-for-field consistent with the SQL the chokepoint
 * reads/writes.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IdeaRow, EpicRow, TaskRow, EntityEventRow, ReviewItemRow, AgentOverrideRow, RunEvalRow } from '../models';

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // Minimal projects table (the real one is created inline in database.ts).
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj One', '/tmp/p1');

  const migDir = join(__dirname, '..', 'migrations');
  // Production order: 006 (workflow_runs base) -> 011 (current_step_id) ->
  // 014 (unified tasks) -> 015 (entity-model rebuild) -> 016 (review_items) ->
  // 024 (archived_at archive-in-place stamp) -> 034 (findings-triage columns:
  // priority/staged_at/selected on review_items + seed_finding_ids on
  // workflow_runs).
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '029_agent_overrides.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '034_findings_triage.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '036_agent_override_model.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '038_agent_mcp_access.sql'), 'utf-8'));
  // run_evals (LLM-judge rollup) — FK -> workflow_runs(id) from 006 (loaded above).
  db.exec(readFileSync(join(migDir, '043_run_evals.sql'), 'utf-8'));
  return db;
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]).map((r) => r.name).sort();
}

describe('entity schema parity (migrations 015 + 024 + 028 + 034)', () => {
  it('IdeaRow field names match the `ideas` columns exactly', () => {
    const db = buildDb();
    const ideaRowKeys: Array<keyof IdeaRow> = [
      'id',
      'project_id',
      'ref',
      'title',
      'summary',
      'body',
      'scope',
      'priority',
      'repo',
      'board_id',
      'stage_id',
      'version',
      'created_at',
      'updated_at',
      'archived_at',
      'attachments',
    ];
    expect([...ideaRowKeys].sort()).toEqual(columnsOf(db, 'ideas'));
    db.close();
  });

  it('EpicRow field names match the `epics` columns exactly', () => {
    const db = buildDb();
    const epicRowKeys: Array<keyof EpicRow> = [
      'id',
      'project_id',
      'ref',
      'title',
      'summary',
      'body',
      'priority',
      'repo',
      'board_id',
      'stage_id',
      'originating_idea_id',
      'version',
      'created_at',
      'updated_at',
      'archived_at',
    ];
    expect([...epicRowKeys].sort()).toEqual(columnsOf(db, 'epics'));
    db.close();
  });

  it('TaskRow field names match the `tasks` columns exactly', () => {
    const db = buildDb();
    const taskRowKeys: Array<keyof TaskRow> = [
      'id',
      'project_id',
      'ref',
      'title',
      'summary',
      'body',
      'priority',
      'repo',
      'board_id',
      'stage_id',
      'entry_stage_id',
      'parent_epic_id',
      'originating_idea_id',
      'version',
      'created_at',
      'updated_at',
      'archived_at',
    ];
    expect([...taskRowKeys].sort()).toEqual(columnsOf(db, 'tasks'));
    db.close();
  });

  it('EntityEventRow field names match the `entity_events` columns exactly', () => {
    const db = buildDb();
    const entityEventRowKeys: Array<keyof EntityEventRow> = [
      'id',
      'entity_type',
      'entity_id',
      'seq',
      'kind',
      'actor',
      'run_id',
      'changes_json',
      'created_at',
    ];
    expect([...entityEventRowKeys].sort()).toEqual(columnsOf(db, 'entity_events'));
    db.close();
  });

  it('ReviewItemRow field names match the `review_items` columns exactly (migrations 016 + 034)', () => {
    const db = buildDb();
    const reviewItemRowKeys: Array<keyof ReviewItemRow> = [
      'id',
      'project_id',
      'run_id',
      'entity_type',
      'entity_id',
      'kind',
      'status',
      'blocking',
      'title',
      'body',
      'severity',
      'priority', // migration 034
      'staged_at', // migration 034
      'selected', // migration 034
      'source',
      'payload_json',
      'created_at',
      'updated_at',
      'resolved_by',
      'resolution',
    ];
    expect([...reviewItemRowKeys].sort()).toEqual(columnsOf(db, 'review_items'));
    db.close();
  });

  it('AgentOverrideRow field names match the agent_overrides columns exactly (migrations 029 + 036 model + 038 mcps)', () => {
    const db = buildDb();
    const agentOverrideRowKeys: Array<keyof AgentOverrideRow> = [
      'id',
      'project_id',
      'agent_key',
      'base_agent_key',
      'name',
      'role',
      'description',
      'system_prompt',
      'tools_json',
      'enabled_mcps_json',
      'is_custom',
      'version',
      'model',
      'created_at',
      'updated_at',
    ];
    expect([...agentOverrideRowKeys].sort()).toEqual(columnsOf(db, 'agent_overrides'));
    db.close();
  });

  it('RunEvalRow field names match the run_evals columns exactly (migration 043)', () => {
    const db = buildDb();
    const runEvalRowKeys: Array<keyof RunEvalRow> = [
      'run_id',
      'rubric_version',
      'eval_status',
      'base_sha',
      'diff_text',
      'diff_stats_json',
      'gate_results_json',
      'human_influenced',
      'snapshot_at',
      'overall_score',
      'band',
      'ci_low',
      'ci_high',
      'gated',
      'security_flag',
      'dimensions_json',
      'per_sample_json',
      'judge_model',
      'sample_count',
      'prompt_hash',
      'judge_build_id',
      'workflow_id',
      'workflow_name',
      'spec_hash',
      'run_model',
      'subagent_models_json',
      'difficulty_proxy_prerun',
      'error',
      'created_at',
      'updated_at',
    ];
    expect([...runEvalRowKeys].sort()).toEqual(columnsOf(db, 'run_evals'));
    db.close();
  });

  it('the agent_overrides UNIQUE(project_id, agent_key) constraint exists (migration 028)', () => {
    const db = buildDb();
    interface IndexListRow {
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }
    interface IndexInfoRow {
      seqno: number;
      cid: number;
      name: string;
    }
    const indexes = db.prepare(`PRAGMA index_list(agent_overrides)`).all() as IndexListRow[];
    const uniqueCols = indexes
      .filter((idx) => idx.unique === 1 && idx.origin === 'u')
      .map((idx) =>
        (db.prepare(`PRAGMA index_info(${idx.name})`).all() as IndexInfoRow[]).map((c) => c.name).sort(),
      );
    expect(uniqueCols).toContainEqual(['agent_key', 'project_id']);
    db.close();
  });

  it('the unified `task_events` table is gone (replaced by entity_events)', () => {
    const db = buildDb();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(names).not.toContain('task_events');
    expect(names).toContain('entity_events');
    db.close();
  });
});
