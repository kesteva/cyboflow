/**
 * Tier-2 chokepoint integration harness (M4).
 *
 * Unlike the sibling unit suites — which hand-roll a partial migration replay
 * (006 → 011 → 014 → 015 → …) — these tests build the DB via the REAL, full
 * migration chain through DatabaseService.initialize() over a throwaway temp
 * file, then seed project 1 + its default board via the production
 * createProject/seedDefaultBoard path (stages at positions 1/6/9/10). This
 * anchors the chokepoint tests onto the exact schema the app ships, so a future
 * migration that renames/relocates a column the routers read fails HERE.
 *
 * Nothing below the MCP handler is faked: McpQueryHandler.handleMessage drives
 * the live TaskChangeRouter / ReviewItemRouter / SprintLaneStore chokepoints
 * against this DB. No SDK mock is needed at this tier.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type * as net from 'net';
import type Database from 'better-sqlite3';
import { DatabaseService } from '../../../database/database';
import type { McpQueryResponse } from '../../mcpServer/mcpQueryHandler';

export interface IntegrationDb {
  svc: DatabaseService;
  db: Database.Database;
  tmpDir: string;
  cleanup(): void;
}

/**
 * Fresh temp-file DB run through the whole migration chain, with project 1 +
 * its default 4-stage board seeded exactly as production does on project
 * creation. The caller owns cleanup() (close + rm) in afterEach.
 */
export function createIntegrationDb(): IntegrationDb {
  const tmpDir = mkdtempSync(join(tmpdir(), `cyboflow-integ-${randomUUID().slice(0, 8)}-`));
  const svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  // project id 1 (fresh autoincrement) + seedDefaultBoard → board-1-default with
  // stages at positions 1/6/9/10 (all write_policy='asserted').
  svc.createProject('Proj', join(tmpDir, 'repo'));
  const db = svc.getDb();
  return {
    svc,
    db,
    tmpDir,
    cleanup(): void {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Canonical stage id for project 1's default board at a given board position. */
export function stageId(position: number): string {
  return `stage-board-1-default-${position}`;
}

export interface SeedRunOpts {
  runId: string;
  /** Workflow name — 'planner'/'ship' are plan-gated fallbacks; 'sprint' is not. */
  workflowName?: string;
  status?: string;
  currentStepId?: string | null;
  /** Frozen { [stepId]: agentLabel } snapshot; include 'approve-plan' to make the run plan-gated. */
  stepsSnapshot?: Record<string, string> | null;
  substrate?: string | null;
  batchId?: string | null;
  /** workflow_runs.task_id link (the execution-run→task binding the active-run guard reads). */
  taskId?: string | null;
}

/**
 * Seed a workflows + workflow_runs pair. Mirrors the column set proven in
 * mcpCreateSprintBatch.test.ts (worktree_path/policy_json are nullable across
 * the full chain, so they are omitted).
 */
export function seedWorkflowRun(db: Database.Database, opts: SeedRunOpts): void {
  const workflowName = opts.workflowName ?? 'sprint';
  const workflowId = `wf-${workflowName}`;
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, '{}')`,
  ).run(workflowId, workflowName);
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json, substrate, batch_id, task_id)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId,
    workflowId,
    opts.status ?? 'running',
    opts.currentStepId ?? null,
    opts.stepsSnapshot ? JSON.stringify(opts.stepsSnapshot) : null,
    // workflow_runs.substrate is NOT NULL DEFAULT 'sdk' (migration 013); an
    // explicit NULL violates the constraint, so default the omitted case here.
    opts.substrate ?? 'sdk',
    opts.batchId ?? null,
    opts.taskId ?? null,
  );
}

/** net.Socket test double capturing every newline-framed write() body. */
export function makeSocketDouble(): { socket: net.Socket; writes: string[] } {
  const writes: string[] = [];
  const socket = {
    write: (chunk: string | Buffer): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
  } as unknown as net.Socket;
  return { socket, writes };
}

export function parseLastWrite(writes: string[]): McpQueryResponse {
  return JSON.parse(writes[writes.length - 1]) as McpQueryResponse;
}
