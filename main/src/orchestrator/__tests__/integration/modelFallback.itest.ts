/**
 * Tier-3 mocked-SDK integration — model-availability fallback + retry.
 *
 * When a run is pinned to a GUARDED model (Fable 5) that the CLI reports as
 * unavailable MID-CALL (an `is_error` `result` event naming the model — NOT a
 * thrown error), `ClaudeCodeManager.runSdkQuery` marks it unavailable on the REAL
 * `ModelAvailabilityService` and transparently RETRIES the SAME turn on the
 * fallback family (Opus), discarding the error result. This is the ONLY production
 * path that issues a "second `query()` call", so this scenario drives the real
 * `ClaudeCodeManager` with a module-mocked `query()` (a shared `fakeSdk` handle
 * that captures every call's options) rather than the `headlessRun` harness, which
 * bypasses `ClaudeCodeManager` and never retries.
 *
 * Asserts:
 *   1. exactly TWO `query()` calls — attempt 1 pinned to `claude-fable-5`, attempt
 *      2 (the retry) pinned to Opus (`claude-opus-4-8[1m]`, the resolved fallback);
 *   2. the guarded model is marked `unavailable` on the singleton after the run;
 *   3. availability state RESETS cleanly between cases (a second test starts with
 *      Fable usable again — proving `integration.setup.ts`'s per-test
 *      `_resetForTesting()` cleared the prior case's state, no bleed under
 *      `singleFork`);
 *   4. only the retry's (well-formed) events reach `raw_events`, all narrowing to a
 *      typed variant — ZERO `__unknown__` (the discarded error result is dropped
 *      BEFORE narrowing/persist, so the honesty check holds).
 *
 * DEVIATION from the plan's M6 sketch: the sanctioned M6a harness cannot drive the
 * mid-call retry (it has no `ClaudeCodeManager`), so this test stands up a real
 * `ClaudeCodeManager` with a module `vi.mock` — mirroring the proven
 * `claudeCodeManagerWiring.test.ts` pattern — and OVERRIDES the defensive throwing
 * SDK mock `integration.setup.ts` installs (a file-local `vi.mock` wins). Recorded
 * as a gap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalRouter } from '../../approvalRouter';
import { QuestionRouter } from '../../questionRouter';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { makeProdLoggerSpy } from '../../__test_fixtures__/loggerLikeSpy';
import { createTestDb } from '../../__test_fixtures__/orchestratorTestDb';
import {
  createModuleFakeSdk,
  sdkResultSuccess,
  type FakeQueryParams,
} from '../../../test/fakes/fakeSdk';
import { ModelAvailabilityService } from '../../../services/modelAvailabilityService';
import { ClaudeCodeManager } from '../../../services/panels/claude/claudeCodeManager';
import type { SessionManager } from '../../../services/sessionManager';
import type { ConfigManager } from '../../../services/configManager';
import type { Logger } from '../../../utils/logger';

// ---------------------------------------------------------------------------
// Shared fake SDK — a module mock backed by the shared handle. It captures each
// query() call's options (so we can read `model` on the first vs the second
// call). A file-local vi.mock overrides integration.setup.ts's defensive throwing
// mock; `...actual` preserves every other real export the graph may touch.
// ---------------------------------------------------------------------------
const fakeSdk = createModuleFakeSdk();

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/claude-agent-sdk')>(
    '@anthropic-ai/claude-agent-sdk',
  );
  return { ...actual, query: (params: FakeQueryParams) => fakeSdk.query(params) };
});

// Neutralize the filesystem/node-resolution side effects of spawnCliProcess —
// mirrors claudeCodeManagerWiring.test.ts (paths resolve relative to THIS file).
vi.mock('../../mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));
vi.mock('../../../utils/promptEnhancer', () => ({
  enhancePromptForStructuredCommit: vi.fn((prompt: string) => prompt),
}));
vi.mock('../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));

/** The resolved concrete ids the spawn seam pins for each family. */
const FABLE_CONCRETE = 'claude-fable-5';
const OPUS_FALLBACK_CONCRETE = 'claude-opus-4-8[1m]';

/** Options captured on a query() call, narrowed to the field under test. */
function callModel(index: number): string | undefined {
  const opts = fakeSdk.calls[index] as { model?: string } | undefined;
  return opts?.model;
}

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function createManager(db: Database.Database, logger: Logger): ClaudeCodeManager {
  return new ClaudeCodeManager(
    createMockSessionManager(),
    logger,
    {
      getSystemPromptAppend: vi.fn(() => undefined),
      getConfig: vi.fn(() => ({ verbose: false })),
    } as unknown as ConfigManager,
    db,
  );
}

/**
 * An `is_error` `result` event whose message names the guarded model as
 * unavailable — the exact shape the CLI emits for an unusable `--model` (an
 * SDKResultSuccess with `is_error` flipped true; its `result` string is what
 * `resultErrorText` reads and `isModelUnavailableError` matches).
 */
function modelUnavailableResult(): SDKMessage {
  return {
    ...sdkResultSuccess({
      result: `API Error: model \`${FABLE_CONCRETE}\` not_found_error: model not found or not available`,
    }),
    is_error: true,
  };
}

describe('Tier-3: guarded model unavailable mid-call → marked unavailable + retried on Opus', () => {
  let db: Database.Database;
  let logger: ReturnType<typeof makeProdLoggerSpy>;

  beforeEach(() => {
    fakeSdk.reset();
    // FK enforcement off so RawEventsSink can persist the retry's events under a
    // panelId run_id without seeding the workflows → workflow_runs FK chain
    // (mirrors the TASK-730 narrowing suite in claudeCodeManagerWiring.test.ts).
    db = createTestDb({ disableForeignKeys: true });
    logger = makeProdLoggerSpy();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    // Real availability service so markUnavailable() records (integration.setup.ts
    // resets it in afterEach — the between-cases isolation this test asserts).
    ModelAvailabilityService.initialize();
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  it('attempt 1 pins Fable and fails model-unavailable; attempt 2 retries on Opus and marks Fable unavailable', async () => {
    const service = ModelAvailabilityService.getInstance();
    // Precondition: a freshly-initialized service treats the guarded model as usable.
    expect(service.isUsable(FABLE_CONCRETE)).toBe(true);

    // Call 1 → the model-unavailable error result (discarded by the retry).
    // Call 2 → a clean success on the fallback model.
    let callCount = 0;
    fakeSdk.setImplementation(() => {
      callCount += 1;
      const attempt = callCount;
      return (async function* stream(): AsyncGenerator<SDKMessage, void> {
        yield attempt === 1 ? modelUnavailableResult() : sdkResultSuccess();
      })();
    });

    const mgr = createManager(db, logger as unknown as Logger);
    await mgr.spawnCliProcess({
      panelId: 'panel-model-fallback',
      sessionId: 'session-model-fallback',
      worktreePath: '/tmp/test',
      prompt: 'run on fable',
      permissionMode: 'ignore',
      model: 'fable',
    });

    // 1. Exactly two query() calls; the retry swapped Fable → Opus fallback.
    expect(fakeSdk.calls).toHaveLength(2);
    expect(callModel(0)).toBe(FABLE_CONCRETE);
    expect(callModel(1)).toBe(OPUS_FALLBACK_CONCRETE);

    // 2. The guarded model is now marked unavailable on the singleton.
    expect(service.isUsable(FABLE_CONCRETE)).toBe(false);
    expect(service.snapshot()[FABLE_CONCRETE]?.status).toBe('unavailable');

    // 4. Only the retry's (well-formed) success reached raw_events; the discarded
    //    error result never narrowed, so NOTHING is __unknown__.
    const rows = db
      .prepare('SELECT payload_json AS payloadJson FROM raw_events WHERE run_id = ?')
      .all('panel-model-fallback') as Array<{ payloadJson: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      const parsed = JSON.parse(row.payloadJson) as Record<string, unknown>;
      expect(parsed['kind']).not.toBe('__unknown__');
    }
  });

  it('_resetForTesting clears unavailability so a fresh initialize starts clean', () => {
    // 3. Exercise the reset seam DIRECTLY rather than trusting beforeEach's
    //    unconditional initialize() (which constructs a brand-new instance and
    //    would mask a broken reset): mark unavailable → reset → the singleton is
    //    gone → a fresh initialize seeds the model usable again. This is the
    //    contract integration.setup.ts's per-test _resetForTesting() relies on
    //    for between-file isolation under singleFork.
    const service = ModelAvailabilityService.getInstance();
    service.markUnavailable(FABLE_CONCRETE, 'itest');
    expect(service.isUsable(FABLE_CONCRETE)).toBe(false);

    ModelAvailabilityService._resetForTesting();
    expect(ModelAvailabilityService.tryGetInstance()).toBeNull();

    ModelAvailabilityService.initialize();
    expect(ModelAvailabilityService.getInstance().isUsable(FABLE_CONCRETE)).toBe(true);
  });
});
