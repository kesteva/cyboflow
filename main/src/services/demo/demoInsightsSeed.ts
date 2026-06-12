/**
 * Demo Insights history seeding — fabricates ~3 weeks of plausible run history
 * for a freshly-created demo project so the Insights pane (stats cards, daily
 * usage chart, step drill-down, findings, version history) opens populated
 * instead of empty.
 *
 * Strategy: write the SAME durable rows the real pipeline would have left
 * behind, then let the real insights queries do the work — no UI mocking:
 *   - workflow_runs   : backdated terminal runs (mostly completed/merged)
 *   - raw_events      : per-run `step_transition` + `assistant` events with
 *                       usage payloads (powers the daily chart, usage trend,
 *                       and step token attribution)
 *   - run_usage       : the materialized rollup per run (powers the stats
 *                       cards' token/cost aggregates)
 *   - review_items    : a handful of findings via the ReviewItemRouter
 *                       chokepoint (powers the findings section; some resolved)
 *
 * Determinism: a fixed-seed LCG drives every "random" choice, so each demo
 * boot produces the same believable history.
 */

import type { Database } from 'better-sqlite3';
import type { WorkflowRegistry } from '../../orchestrator/workflowRegistry';
import { buildBuiltInWorkflows } from '../../orchestrator/workflows/builtInWorkflows';
import { ReviewItemRouter } from '../../orchestrator/reviewItemRouter';

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness (Park–Miller LCG)
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** Format a Date as SQLite's UTC DATETIME ('YYYY-MM-DD HH:MM:SS'). */
function sqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Model + step fixtures
// ---------------------------------------------------------------------------

interface ModelProfile {
  id: string;
  /** USD per input token / output token (current public per-MTok pricing). */
  inputRate: number;
  outputRate: number;
}

const MODELS: ModelProfile[] = [
  { id: 'claude-sonnet-4-6', inputRate: 3 / 1_000_000, outputRate: 15 / 1_000_000 },
  { id: 'claude-opus-4-8', inputRate: 15 / 1_000_000, outputRate: 75 / 1_000_000 },
  { id: 'claude-haiku-4-5', inputRate: 1 / 1_000_000, outputRate: 5 / 1_000_000 },
];

/** Step ids mirror the built-in flow definitions (planner.md / sprint.md). */
const FLOW_STEPS: Record<'planner' | 'sprint', string[]> = {
  planner: ['context', 'research', 'approve-idea', 'epics', 'tasks', 'approve-plan'],
  sprint: ['analyze-dependencies', 'execute-tasks', 'sprint-verify', 'sprint-review', 'human-review'],
};

// ---------------------------------------------------------------------------
// Findings fixtures — habit-tracker themed, attached to recent runs
// ---------------------------------------------------------------------------

interface FindingFixture {
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'error';
  category: string;
  suggestedFix: string;
  proposedTarget?: 'backlog' | 'docs' | 'prompt';
  /** 'pending' stays in the inbox; otherwise triaged with this resolution. */
  triage: 'pending' | 'resolved' | 'dismissed';
}

const FINDINGS: FindingFixture[] = [
  {
    title: 'checkIn accepts unknown habit ids silently',
    body: '`checkIn(999)` returns `undefined` and the server replies "not found", but nothing logs the bad id — repeated misses are invisible. Consider a counter or warn log.',
    severity: 'warning',
    category: 'correctness',
    suggestedFix: 'Track unknown-id check-ins (log or metric) in `checkIn`.',
    proposedTarget: 'backlog',
    triage: 'pending',
  },
  {
    title: 'Server returns 200 for unsupported routes',
    body: "`handleRequest` answers 'unsupported' with an implicit success status — clients can't distinguish a typo'd route from a real reply.",
    severity: 'warning',
    category: 'api',
    suggestedFix: 'Surface unsupported method/path combinations as an error result.',
    triage: 'pending',
  },
  {
    title: 'computeStreak re-derives day buckets on every call',
    body: 'The `Set` of day keys is rebuilt per call; for habits with long histories this is O(n) per render. Cheap now, but worth memoizing once lists render many habits.',
    severity: 'info',
    category: 'performance',
    suggestedFix: 'Memoize day-key sets per habit, invalidating on check-in.',
    triage: 'resolved',
  },
  {
    title: 'formatHabit pluralization breaks for zero check-ins',
    body: 'A habit with 0 completions renders no suffix by design, but the pluralization branch would print "(0 check-ins)" if the guard is ever loosened — add a test pinning the zero case.',
    severity: 'info',
    category: 'testing',
    suggestedFix: 'Add a zero-completions case to the formatter tests.',
    triage: 'resolved',
  },
  {
    title: 'Habit names are not trimmed before storage',
    body: '`addHabit("  Run ")` stores the padded name verbatim; duplicates differing only by whitespace are possible.',
    severity: 'info',
    category: 'consistency',
    suggestedFix: 'Trim (and collapse inner whitespace in) habit names on create.',
    triage: 'dismissed',
  },
];

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

export interface DemoInsightsSeedArgs {
  db: Database;
  projectId: number;
  workflowRegistry: WorkflowRegistry;
}

/**
 * Seed the demo project's Insights history. Fail-soft by contract at the call
 * site (like seedDemoProjectEntities) — this function itself throws on error.
 */
export async function seedDemoInsightsHistory(args: DemoInsightsSeedArgs): Promise<void> {
  const { db, projectId, workflowRegistry } = args;
  const rng = makeRng(20260612);

  // The built-in workflows are normally reconciled lazily by the renderer's
  // workflows.list — force them now so the history runs have parents.
  workflowRegistry.reconcileBuiltIns(projectId, buildBuiltInWorkflows());

  const insertRun = db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, status, permission_mode_snapshot, substrate,
        outcome, created_at, updated_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, 'default', 'sdk', ?, ?, ?, ?, ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO raw_events (run_id, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  const insertUsage = db.prepare(
    `INSERT INTO run_usage
       (run_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        total_tokens, cost_usd, num_turns, assistant_message_count, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const completedRunIds: string[] = [];
  let runSeq = 0;

  const seedHistory = db.transaction(() => {
    // Walk ~3 weeks back to yesterday; skip ~1/3 of days for natural gaps.
    for (let daysAgo = 21; daysAgo >= 1; daysAgo--) {
      if (rng() < 0.33) continue;
      const runsToday = rng() < 0.35 ? 2 : 1;

      for (let i = 0; i < runsToday; i++) {
        runSeq += 1;
        const flow: 'planner' | 'sprint' = rng() < 0.4 ? 'planner' : 'sprint';
        const workflowId = `wf-${projectId}-${flow}`;
        const runId = `demohist${String(runSeq).padStart(4, '0')}${flow}`.padEnd(32, '0');

        // Start between 09:00 and 18:00 UTC; run for 6–25 minutes.
        const start = new Date();
        start.setUTCDate(start.getUTCDate() - daysAgo);
        start.setUTCHours(9 + Math.floor(rng() * 9), Math.floor(rng() * 60), Math.floor(rng() * 60), 0);
        const durationMs = (6 + rng() * 19) * 60_000;
        const end = new Date(start.getTime() + durationMs);

        const statusRoll = rng();
        const status = statusRoll < 0.8 ? 'completed' : statusRoll < 0.9 ? 'canceled' : 'failed';
        const outcome =
          status === 'completed' ? (rng() < 0.75 ? 'merged' : null)
          : status === 'canceled' ? (rng() < 0.5 ? 'dismissed' : null)
          : null;

        insertRun.run(
          runId, workflowId, projectId, status, outcome,
          sqliteUtc(start), sqliteUtc(end), sqliteUtc(start), sqliteUtc(end),
        );
        if (status === 'completed') completedRunIds.push(runId);

        // Model mix: mostly Sonnet, some Opus, occasional Haiku.
        const modelRoll = rng();
        const model = modelRoll < 0.7 ? MODELS[0] : modelRoll < 0.9 ? MODELS[1] : MODELS[2];

        // Per-step events: a step_transition marker then 1–3 assistant usages.
        const steps = FLOW_STEPS[flow];
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheRead = 0;
        let cacheCreation = 0;
        let assistantCount = 0;
        const stepSlice = durationMs / steps.length;

        steps.forEach((stepId, stepIndex) => {
          const stepStart = new Date(start.getTime() + stepSlice * stepIndex);
          insertEvent.run(
            runId, 'step_transition',
            JSON.stringify({ step_id: stepId, status: 'running' }),
            sqliteUtc(stepStart),
          );

          const messages = 1 + Math.floor(rng() * 3);
          for (let m = 0; m < messages; m++) {
            const at = new Date(stepStart.getTime() + (stepSlice / (messages + 1)) * (m + 1));
            const usage = {
              input_tokens: 2_000 + Math.floor(rng() * 12_000),
              output_tokens: 300 + Math.floor(rng() * 2_200),
              cache_read_input_tokens: 8_000 + Math.floor(rng() * 70_000),
              cache_creation_input_tokens: Math.floor(rng() * 3_000),
            };
            inputTokens += usage.input_tokens;
            outputTokens += usage.output_tokens;
            cacheRead += usage.cache_read_input_tokens;
            cacheCreation += usage.cache_creation_input_tokens;
            assistantCount += 1;
            insertEvent.run(
              runId, 'assistant',
              JSON.stringify({
                type: 'assistant',
                message: { model: model.id, role: 'assistant', usage },
              }),
              sqliteUtc(at),
            );
          }
        });

        // Materialized rollup — what the stats cards read. Cache reads priced
        // at 10% of the input rate (the public cache-hit discount).
        const cost =
          inputTokens * model.inputRate +
          outputTokens * model.outputRate +
          cacheRead * model.inputRate * 0.1;
        insertUsage.run(
          runId, inputTokens, outputTokens, cacheRead, cacheCreation,
          inputTokens + outputTokens, Math.round(cost * 10_000) / 10_000,
          assistantCount, assistantCount, sqliteUtc(end),
        );
      }
    }
  });
  seedHistory();

  // Findings through the chokepoint (audit trail + emits), bound to recent
  // completed runs so the Insights join resolves a workflow for each.
  const router = ReviewItemRouter.getInstance();
  for (let i = 0; i < FINDINGS.length; i++) {
    const fixture = FINDINGS[i];
    const runId = completedRunIds[completedRunIds.length - 1 - (i % Math.max(1, completedRunIds.length))];
    const { reviewItemId } = await router.applyReviewItem(projectId, {
      op: 'create',
      actor: 'agent:demo-code-review',
      kind: 'finding',
      title: fixture.title,
      body: fixture.body,
      severity: fixture.severity,
      source: 'agent:demo-code-review',
      blocking: false,
      runId: runId ?? null,
      payload: {
        kind: 'finding',
        category: fixture.category,
        suggestedFix: fixture.suggestedFix,
        ...(fixture.proposedTarget ? { proposedTarget: fixture.proposedTarget } : {}),
      },
    });
    if (fixture.triage !== 'pending') {
      await router.applyReviewItem(projectId, {
        op: fixture.triage === 'resolved' ? 'resolve' : 'dismiss',
        actor: 'user',
        reviewItemId,
        resolution: fixture.triage === 'resolved' ? 'triaged:accepted' : 'triaged:not-worth-it',
      });
    }
  }
}
