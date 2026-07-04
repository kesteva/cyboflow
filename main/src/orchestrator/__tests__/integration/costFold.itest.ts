/**
 * Tier-3 mocked-SDK integration — run-cost source-of-truth (cost fold).
 *
 * Repo invariant (`project_run_cost_source_of_truth`): `run_usage.cost_usd` is the
 * SDK `result.total_cost_usd` **verbatim** — it is NEVER recomputed from token
 * counts × a per-card rate. This drives the REAL terminal-seam writer
 * (`rollupRunUsage` → `selectRunUsageRollups`'s raw_events scan) over a
 * migration-replay DB (so the migration-026 `run_usage` table exists) seeded with
 * a fakeSdk assistant turn (nonzero tokens) + a terminal `result` carrying a
 * distinctive `total_cost_usd`, and asserts:
 *   1. the fake events narrow cleanly through the REAL TypedEventNarrowing (zero
 *      `__unknown__`) — the honesty check the whole suite shares;
 *   2. the materialized `run_usage.cost_usd` equals `total_cost_usd` to the last
 *      digit, EVEN THOUGH the run's token totals are large and unrelated (a
 *      token×rate recompute would land nowhere near it);
 *   3. token totals ARE derived (independently) from the assistant usage — proving
 *      cost and tokens are separate columns, cost taken as-is.
 *
 * DEVIATION from the plan's M6 sketch (code won): the harness (`headlessRun`) does
 * NOT run `RunExecutor`, so it never fires `rollupRunUsage` and never exposes its DB
 * — the rollup is a read-side derivation over `raw_events`. This test therefore
 * builds its own migration-replay DB (the exact bootstrap `headlessRun` uses
 * internally) and invokes the REAL `rollupRunUsage` on it. Recorded as a gap.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { DatabaseService } from '../../../database/database';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../../__test_fixtures__/loggerLikeSpy';
import { rollupRunUsage } from '../../runUsageRollup';
import { TypedEventNarrowing } from '../../../services/streamParser';
import { sdkAssistantText, sdkResultSuccess } from '../../../test/fakes/fakeSdk';

/** The SDK `total_cost_usd` the CLI reported — an arbitrary, precise value. */
const SDK_TOTAL_COST_USD = 0.4237;
/** Assistant usage — deliberately large + unrelated to the cost above. */
const INPUT_TOKENS = 1_234_000;
const OUTPUT_TOKENS = 567_800;
const NUM_TURNS = 3;
const RUN_ID = 'run-costfold-1';

describe('Tier-3: run_usage.cost_usd is the SDK total_cost_usd verbatim (never recomputed from tokens)', () => {
  let dbDir: string;
  let dbService: DatabaseService;
  let db: Database.Database;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-costfold-db-'));
    dbService = new DatabaseService(path.join(dbDir, 'costfold.db'));
    dbService.initialize();
    db = dbService.getDb();
    // Focused rollup test: FKs off so we can insert raw_events without seeding the
    // projects→workflows→workflow_runs chain the derivation itself never reads.
    db.pragma('foreign_keys = OFF');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  test('a result event with total_cost_usd folds into run_usage.cost_usd unchanged', () => {
    // An assistant turn (nonzero token usage) + a terminal result carrying the cost.
    const assistant = sdkAssistantText('folding the cost from the terminal result');
    const assistantWithUsage: SDKMessage = {
      ...assistant,
      message: {
        ...assistant.message,
        usage: { ...assistant.message.usage, input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
      },
    };
    const result: SDKMessage = sdkResultSuccess({
      totalCostUsd: SDK_TOTAL_COST_USD,
      numTurns: NUM_TURNS,
    });

    const insert = db.prepare(
      'INSERT INTO raw_events (run_id, event_type, payload_json) VALUES (?, ?, ?)',
    );
    for (const event of [assistantWithUsage, result]) {
      insert.run(RUN_ID, event.type, JSON.stringify(event));
    }

    // 1. Honesty check: both fake events narrow cleanly (the SAME payloads the
    //    rollup scan reads must survive the REAL narrowing with no __unknown__).
    const narrower = new TypedEventNarrowing();
    for (const event of [assistantWithUsage, result]) {
      const narrowed = narrower.narrow(event);
      expect('kind' in narrowed && narrowed.kind === '__unknown__').toBe(false);
    }

    // Drive the REAL terminal-seam writer.
    rollupRunUsage(dbAdapter(db), RUN_ID, makeSpyLogger());

    const row = db
      .prepare(
        'SELECT cost_usd AS costUsd, input_tokens AS inputTokens, output_tokens AS outputTokens, total_tokens AS totalTokens, num_turns AS numTurns FROM run_usage WHERE run_id = ?',
      )
      .get(RUN_ID) as
      | { costUsd: number | null; inputTokens: number; outputTokens: number; totalTokens: number; numTurns: number | null }
      | undefined;

    expect(row).toBeDefined();
    // 2. Cost is the SDK value VERBATIM — to the last digit.
    expect(row!.costUsd).toBe(SDK_TOTAL_COST_USD);
    // A token×rate recompute (any plausible per-Mtok price on 1.8M tokens) would be
    // dollars, not 0.4237 — so exact equality proves it was NOT recomputed.
    expect(row!.costUsd).not.toBe(row!.totalTokens);

    // 3. Token totals are derived INDEPENDENTLY from the assistant usage (result
    //    usage is intentionally never summed into the token totals).
    expect(row!.inputTokens).toBe(INPUT_TOKENS);
    expect(row!.outputTokens).toBe(OUTPUT_TOKENS);
    expect(row!.totalTokens).toBe(INPUT_TOKENS + OUTPUT_TOKENS);
    expect(row!.numTurns).toBe(NUM_TURNS);
  });
});
