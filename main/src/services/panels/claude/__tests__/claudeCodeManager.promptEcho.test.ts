/**
 * Prompt echo — maybeEchoPromptUserTurn.
 *
 * The Claude SDK never re-emits the prompt it was driven with (neither a cold
 * `--resume` spawn nor a warm push), so a flow-run chat send (nudge / queued
 * input / resume) reached the agent but never appeared in the run transcript:
 * selectRunUnifiedMessages reads raw_events, the user turn was never persisted,
 * and the renderer's pending-send 'SENDING' row never reconciled away.
 *
 * The manager now SYNTHESIZES the echo — a parentless user event routed through
 * the per-spawn RawEventsSink pipeline (→ raw_events) and the live 'output'
 * stream — once per LOGICAL turn, mirroring the Codex app-server's native
 * userMessage echo and its `hideUserMessage` suppression seam. This suite pins:
 *
 *   (1) a cold flow-run turn persists + emits the user echo;
 *   (2) `hidePromptFromTranscript: true` (the launch turn / lane step prompts)
 *       suppresses it;
 *   (3) a WARM push (resume continuation) echoes the pushed turn's text;
 *   (4) a caller-injected eventsSink (global-agent transcript) suppresses it —
 *       the custom-sink caller owns its own user-turn persistence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import {
  createModuleFakeSdk,
  scenario,
  type ScenarioBuilder,
  type FakeQueryParams,
} from '../../../../test/fakes/fakeSdk';
import { ClaudeCodeManager } from '../claudeCodeManager';
import { ModelAvailabilityService } from '../../../modelAvailabilityService';
import type { SessionManager } from '../../../sessionManager';
import type { SpawnEventsSink } from '../claudeCodeManager';

const SESSION_UUID = 'sess-echo-uuid';

const fakeSdk = createModuleFakeSdk();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: FakeQueryParams) => fakeSdk.query(params),
}));

vi.mock('../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));
vi.mock('../../../utils/promptEnhancer', () => ({
  // Divergent enhanced prompt proves the echo carries options.prompt, not finalPrompt.
  enhancePromptForStructuredCommit: vi.fn((prompt: string) => `${prompt}\n\n<structured-commit boilerplate>`),
}));
vi.mock('../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => SESSION_UUID),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function getSdkRuns(mgr: ClaudeCodeManager): Map<string, unknown> {
  return (mgr as unknown as { sdkRuns: Map<string, unknown> }).sdkRuns;
}

/** All persisted user-event payloads for a run, oldest-first. */
function persistedUserEvents(db: Database.Database, runId: string): Array<{ text: string }> {
  const rows = db
    .prepare(
      `SELECT payload_json AS payloadJson FROM raw_events
        WHERE run_id = ? AND event_type = 'user' ORDER BY id ASC`,
    )
    .all(runId) as Array<{ payloadJson: string }>;
  return rows.map((r) => {
    const payload = JSON.parse(r.payloadJson) as {
      message: { content: Array<{ type: string; text?: string }> };
    };
    return {
      text: payload.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n'),
    };
  });
}

describe('ClaudeCodeManager — flow-run prompt echo (user turn)', () => {
  let db: Database.Database;
  let mgr: ClaudeCodeManager;

  beforeEach(() => {
    fakeSdk.reset();
    delete process.env.CYBOFLOW_DISABLE_WARM_SDK;
    ModelAvailabilityService._resetForTesting();
    ModelAvailabilityService.initialize();
    db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new ClaudeCodeManager(createMockSessionManager(), undefined, undefined, db);
  });

  afterEach(async () => {
    for (const key of Array.from(getSdkRuns(mgr).keys())) {
      await mgr.killProcess(key).catch(() => {});
    }
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    ModelAvailabilityService._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  function oneTurnScenario(): ScenarioBuilder {
    return scenario()
      .systemInit({ sessionId: SESSION_UUID })
      .assistantText('reply one')
      .resultSuccess();
  }

  function twoTurnScenario(): ScenarioBuilder {
    return scenario()
      .systemInit({ sessionId: SESSION_UUID })
      .assistantText('reply one')
      .resultSuccess()
      .assistantText('reply two')
      .resultSuccess();
  }

  // (1) Cold flow-run turn → user echo persisted + emitted.
  it('persists and emits the prompt as a parentless user event on a cold flow-run turn', async () => {
    const panelId = 'run-echo-cold';
    seedRun(db, { id: panelId });
    fakeSdk.setScenario(oneTurnScenario());

    const outputs: unknown[] = [];
    mgr.on('output', (payload: { data?: { type?: string } }) => {
      if (payload?.data?.type === 'user') outputs.push(payload.data);
    });

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'can you confirm one thing I saw?',
      permissionMode: 'ignore',
    });

    const persisted = persistedUserEvents(db, panelId);
    expect(persisted).toHaveLength(1);
    // options.prompt verbatim — the structured-commit enhancement must NOT leak in.
    expect(persisted[0].text).toBe('can you confirm one thing I saw?');
    const raw = db
      .prepare(`SELECT payload_json AS p FROM raw_events WHERE run_id = ? AND event_type = 'user'`)
      .get(panelId) as { p: string };
    expect(JSON.parse(raw.p).parent_tool_use_id).toBeNull();
    expect(outputs).toHaveLength(1);
  });

  // (2) hidePromptFromTranscript: true (launch / lane plumbing) → no echo.
  it('suppresses the echo when hidePromptFromTranscript is true', async () => {
    const panelId = 'run-echo-hidden';
    seedRun(db, { id: panelId });
    fakeSdk.setScenario(oneTurnScenario());

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'You are the planner. <workflow prompt>',
      permissionMode: 'ignore',
      hidePromptFromTranscript: true,
    });

    expect(persistedUserEvents(db, panelId)).toHaveLength(0);
  });

  // (3) Warm push (resume continuation) → the pushed turn's text is echoed too.
  it('echoes a warm-pushed nudge turn', async () => {
    const panelId = 'run-echo-warm';
    seedRun(db, { id: panelId });
    const builder = twoTurnScenario();
    fakeSdk.setScenario(builder);

    // Turn 1 — the flow launch (hidden).
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'You are the sprint orchestrator. <workflow prompt>',
      permissionMode: 'ignore',
      hidePromptFromTranscript: true,
    });
    expect(persistedUserEvents(db, panelId)).toHaveLength(0);

    // Turn 2 — an idle-chat nudge resumes the SAME conversation via warm push.
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'Alright, can you create a separate ticket for that?',
      permissionMode: 'ignore',
      resumeSessionId: SESSION_UUID,
    });
    expect(fakeSdk.calls).toHaveLength(1); // warm push, no respawn
    expect(builder.pushed).toEqual(['Alright, can you create a separate ticket for that?']);
    const persisted = persistedUserEvents(db, panelId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].text).toBe('Alright, can you create a separate ticket for that?');
  });

  // (4) Caller-injected eventsSink (global-agent transcript) → no echo.
  it('suppresses the echo for a custom-sink spawn', async () => {
    const panelId = 'run-echo-sink';
    seedRun(db, { id: panelId });
    fakeSdk.setScenario(oneTurnScenario());

    const sink: SpawnEventsSink = {
      attachToRouter: vi.fn(),
      dispose: vi.fn(),
    } as unknown as SpawnEventsSink;

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'assistant thread turn',
      permissionMode: 'ignore',
      eventsSink: sink,
    });

    expect(persistedUserEvents(db, panelId)).toHaveLength(0);
  });
});
