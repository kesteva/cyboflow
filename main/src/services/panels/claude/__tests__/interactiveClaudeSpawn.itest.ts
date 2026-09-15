/**
 * Tier-3 mocked-SDK integration coverage for the INTERACTIVE (PTY) Claude
 * substrate — the counterpart the suite was missing.
 *
 * `substrateParity.itest.ts` records (in its DEVIATION note) that it substituted
 * an EventEmitter stand-in for the real `InteractiveClaudeManager`; this is the
 * test it deferred. Everything below drives the REAL manager through the REAL
 * production dispatch path:
 *
 *   ClaudePanelManager.startPanel(config)
 *     -> AbstractAIPanelManager.startPanel  (getCliManager -> resolveSubstrate)
 *     -> InteractiveClaudeManager.startPanel
 *     -> InteractiveClaudeManager.spawnCliProcess
 *
 * What is REAL here: the manager, its `InteractiveSettingsWriter` /
 * `InteractiveMcpEnabler` / `WorkflowBundleWriter` deps, the per-run
 * `EventRouter` + `RawEventsSink` pipeline over a real better-sqlite3 DB, the
 * substrate resolver, and — the point of the exercise — the REAL
 * `TranscriptTailSource` + `transcriptNormalizer`, tailing REAL transcript-shaped
 * JSONL written to the exact on-disk path production watches.
 *
 * Only two things are faked, both hard I/O boundaries with no in-process seam:
 *   - `spawnPtyProcess` returns a `FakePty` (shared fixture, `test/fakes/fakePty`)
 *     instead of forking a terminal, and the availability probe / executable
 *     resolution short-circuit so no real `claude` binary is required;
 *   - `$HOME` is repointed at a temp dir for the duration of each test, so
 *     `TranscriptTailSource`'s PRODUCTION `os.homedir()/.claude/projects` default
 *     resolves into the fixture instead of the developer's real transcript store.
 *     The source's own `projectsRoot` injection point is deliberately NOT used —
 *     that would be a test-only path around the production default.
 *
 * DEVIATION from the brief: it asked for an assertion that
 * `interactiveSettingsWriter` wrote `.claude/settings.local.json`. It does not —
 * on this substrate the settings writer only ever REMOVES a legacy on-disk hook
 * entry (`interactiveSettingsWriter.ts` header: "inline delivery writes NOTHING
 * into the working tree", which is what allows in-place sessions), and the
 * gating/turn-end hooks ride the inline `--settings '<json>'` argv flag.
 * `.claude/settings.local.json` is written by `interactiveMcpEnabler` instead.
 * Scenario (b) asserts what production actually does: the enabler's file content,
 * the per-run `.cyboflow/interactive-mcp.json` content, and the hooks inside the
 * inline `--settings` argv element.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type Database from 'better-sqlite3';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import { FakePty } from '../../../../test/fakes/fakePty';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { countRawEvents } from '../../../../orchestrator/__test_fixtures__/rawEvents';
import { QUICK_WORKFLOW_NAME } from '../../../../orchestrator/workflowRegistry';
import { encodeCwd } from '../../../../../../shared/utils/encodeCwd';
import { InteractiveClaudeManager } from '../interactiveClaudeManager';
import { ClaudePanelManager } from '../claudePanelManager';
import { ModelAvailabilityService } from '../../../modelAvailabilityService';
import type { SessionManager } from '../../../sessionManager';
import type { ConfigManager } from '../../../configManager';
import type { Logger } from '../../../../utils/logger';
import type { TranscriptSource } from '../transcript/transcriptSource';

vi.mock('../../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));

vi.mock('../../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));

const PANEL_ID = 'panel-interactive';
const SESSION_ID = 'session-interactive';
const ORCH_SOCKET = '/tmp/interactive-itest.sock';
/** The transcript filename UUID the fixture writes — the id the manager persists. */
const TRANSCRIPT_UUID = 'efde13c6-0001-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// Real-shaped transcript fixture lines (Probe-E inventory; the same shapes
// transcriptTailSource.test.ts / transcriptNormalizer.test.ts pin).
// ---------------------------------------------------------------------------

function fileHistorySnapshotLine(): string {
  // The real first physical line — carries NO top-level `cwd`.
  return JSON.stringify({
    type: 'file-history-snapshot',
    messageId: '01bc38e2',
    snapshot: { trackedFileBackups: {} },
    isSnapshotUpdate: false,
  });
}

function userTextLine(text: string, cwd: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    cwd,
    sessionId: TRANSCRIPT_UUID,
    uuid: 'user-0001',
  });
}

function assistantTextLine(text: string, cwd: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 7 },
    },
    cwd,
    sessionId: TRANSCRIPT_UUID,
    uuid: 'asst-0001',
  });
}

function localCommandNoiseLine(cwd: string): string {
  // Unmodeled `system` subtype — the normalizer must DROP it (never a panel event).
  return JSON.stringify({ type: 'system', subtype: 'local_command', cwd, sessionId: TRANSCRIPT_UUID });
}

function stopHookSummaryLine(cwd: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount: 2,
    cwd,
    sessionId: TRANSCRIPT_UUID,
  });
}

// ---------------------------------------------------------------------------
// Test harness — the REAL manager with only the PTY / binary-probe boundaries faked.
// ---------------------------------------------------------------------------

class ItestInteractiveClaudeManager extends InteractiveClaudeManager {
  readonly ptys: FakePty[] = [];
  /** argv of each spawn, captured at the PTY boundary. */
  readonly spawnArgs: string[][] = [];

  protected override async testCliAvailability(): Promise<{
    available: boolean;
    error?: string;
    version?: string;
    path?: string;
  }> {
    return { available: true, version: '2.1.207', path: '/fake/bin/claude' };
  }

  protected override async getCliExecutablePath(): Promise<string> {
    return '/fake/bin/claude';
  }

  protected override async getSystemEnvironment(): Promise<{ [key: string]: string }> {
    return { PATH: '/usr/bin' };
  }

  protected override async spawnPtyProcess(_command: string, args: string[]): Promise<IPty> {
    this.spawnArgs.push(args);
    const fake = new FakePty();
    this.ptys.push(fake);
    return fake as unknown as IPty;
  }

  /**
   * The fixture's "claude" writes its transcript under TRANSCRIPT_UUID, so the
   * manager must hand it exactly that id as `--session-id` — which is what pins
   * discovery to that file in production too.
   */
  protected override mintSessionUuid(): string {
    return TRANSCRIPT_UUID;
  }

  /** Test accessors for the private per-panel maps (leak checks). */
  publicTailSources(): Map<string, TranscriptSource> {
    return (this as unknown as { tailSources: Map<string, TranscriptSource> }).tailSources;
  }
  publicProcesses(): Map<string, unknown> {
    return (this as unknown as { processes: Map<string, unknown> }).processes;
  }
}

interface OutputEvent {
  panelId: string;
  sessionId: string;
  type: string;
  data: unknown;
}

interface TurnEndEvent {
  panelId: string;
  sessionId: string;
  runId: string;
}

/** Poll until `predicate()` holds, yielding to the macrotask queue each tick. */
async function waitFor(predicate: () => boolean, label: string, maxTicks = 600): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function makeLogger(): Logger {
  return {
    verbose: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeConfigManager(): ConfigManager {
  return {
    getConfig: vi.fn(() => ({ claudeExecutablePath: undefined })),
    getDefaultAgentPermissionMode: vi.fn(() => undefined),
    getFanOutDispatch: vi.fn(() => 'prose'),
  } as unknown as ConfigManager;
}

describe('interactive (PTY) Claude substrate — real-stack spawn integration', () => {
  let db: Database.Database;
  let mgr: ItestInteractiveClaudeManager;
  let panelManager: ClaudePanelManager;
  let sessionManager: SessionManager;
  let updateSession: ReturnType<typeof vi.fn>;
  let addPanelOutput: ReturnType<typeof vi.fn>;
  let worktreePath: string;
  let fakeHome: string;
  let realHome: string | undefined;
  let keyDir: string;
  let transcriptPath: string;
  let outputs: OutputEvent[];
  let turnEnds: TurnEndEvent[];

  beforeEach(() => {
    realHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-itest-home-'));
    // TranscriptTailSource resolves its projects root from os.homedir(), which on
    // POSIX reads $HOME. Repointing it keeps the PRODUCTION default path in play
    // while sandboxing the fixture away from the developer's real ~/.claude.
    process.env.HOME = fakeHome;

    worktreePath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'icm-itest-wt-')));
    keyDir = path.join(fakeHome, '.claude', 'projects', encodeCwd(worktreePath));
    transcriptPath = path.join(keyDir, `${TRANSCRIPT_UUID}.jsonl`);

    // A committed project `.mcp.json` — what makes InteractiveMcpEnabler write
    // `.claude/settings.local.json` (the launch-modal bypass).
    fs.writeFileSync(
      path.join(worktreePath, '.mcp.json'),
      JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['playwright-mcp'] } } }),
      'utf8',
    );

    ModelAvailabilityService._resetForTesting();
    ModelAvailabilityService.initialize();

    db = createTestDb();
    // raw_events FKs workflow_runs, and the run row is also what the manager's
    // prompt/bundle readers resolve against. `__quick__` is the sentinel a quick
    // PTY session really runs under (workflow appends suppressed by name).
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json, workflow_path) VALUES (?, ?, ?, ?, ?)`,
    ).run('wf-quick', 1, QUICK_WORKFLOW_NAME, '{}', null);
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status) VALUES (?, ?, ?, ?)`,
    ).run(PANEL_ID, 'wf-quick', 1, 'running');

    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);

    updateSession = vi.fn();
    addPanelOutput = vi.fn();
    sessionManager = {
      getDbSession: vi.fn(() => ({
        id: SESSION_ID,
        substrate: 'interactive',
        permission_mode: 'approve',
        run_id: null,
        chat_run_id: null,
        in_place: 0,
        skip_continue_next: false,
      })),
      getPanelClaudeSessionId: vi.fn(() => undefined),
      getProjectById: vi.fn(() => undefined),
      updateSession: vi.fn(),
      addPanelOutput,
      // The interactive substrate's claude_session_id write seam.
      db: { updateSession },
    } as unknown as SessionManager;

    mgr = new ItestInteractiveClaudeManager(sessionManager, makeLogger(), makeConfigManager(), db);
    mgr.setOrchSocketPath(ORCH_SOCKET);

    // The real production dispatcher: substrate routing lives in getCliManager.
    panelManager = new ClaudePanelManager(
      // The SDK manager must never be reached in these scenarios; a throwing stub
      // makes a mis-routed spawn a loud failure rather than a silent pass.
      {
        startPanel: vi.fn(async () => {
          throw new Error('SDK manager reached on an interactive-substrate panel');
        }),
        continuePanel: vi.fn(),
        stopPanel: vi.fn(),
        on: vi.fn(),
        emit: vi.fn(),
      } as unknown as InteractiveClaudeManager,
      sessionManager,
      undefined,
      undefined,
      mgr,
    );
    panelManager.registerPanel(PANEL_ID, SESSION_ID);

    outputs = [];
    turnEnds = [];
    mgr.on('output', (e: OutputEvent) => outputs.push(e));
    mgr.on('turn-end', (e: TurnEndEvent) => turnEnds.push(e));
  });

  afterEach(async () => {
    await mgr.killProcess(PANEL_ID).catch(() => {});
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    ModelAvailabilityService._resetForTesting();
    db.close();
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  /**
   * Write the turn's transcript once the manager's TranscriptTailSource has
   * started. Discovery is PINNED to `<--session-id>.jsonl` (the id
   * mintSessionUuid handed claude), so ordering is no longer load-bearing for
   * correctness — but writing after start() still exercises the real
   * "file appears while the source is watching" path rather than a pre-existing
   * file.
   *
   * `spawned` is emitted synchronously immediately BEFORE `createTranscriptSource`
   * + `start()`, and `start()`'s body runs to completion synchronously, so a
   * macrotask scheduled from this listener is guaranteed to run after the snapshot.
   */
  function scheduleTranscriptAfterSnapshot(lines: string[]): void {
    mgr.once('spawned', () => {
      setTimeout(() => {
        fs.mkdirSync(keyDir, { recursive: true });
        fs.writeFileSync(transcriptPath, lines.map((l) => `${l}\n`).join(''), 'utf8');
      }, 0);
    });
  }

  /** Start the panel through the production dispatcher without awaiting the
   *  spawn promise — a persistent REPL's promise settles only on PTY exit. */
  function startPanelDetached(prompt: string): Promise<void> {
    const p = panelManager.startPanel({
      panelId: PANEL_ID,
      worktreePath,
      prompt,
    });
    p.catch(() => undefined);
    return p;
  }

  it('(a) spawns a real PTY-substrate turn: transcript discovery binds, normalized output reaches the session store and raw_events, and the transcript marker drives turn-end', async () => {
    scheduleTranscriptAfterSnapshot([
      fileHistorySnapshotLine(),
      userTextLine('hello from the composer', worktreePath),
      localCommandNoiseLine(worktreePath),
      assistantTextLine('hello back', worktreePath),
    ]);

    const spawnPromise = startPanelDetached('hello from the composer');

    // The assistant line is the panel-critical one; it only arrives once the REAL
    // TranscriptTailSource discovered the file and normalized its lines.
    await waitFor(
      () => outputs.some((e) => (e.data as { type?: string } | null)?.type === 'assistant'),
      'assistant transcript line normalized into a panel output event',
    );

    const assistant = outputs.find((e) => (e.data as { type?: string }).type === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.panelId).toBe(PANEL_ID);
    expect(assistant?.sessionId).toBe(SESSION_ID);
    expect(assistant?.type).toBe('json');
    // Normalizer projection: transcript `sessionId` -> wire `session_id`.
    const assistantData = assistant?.data as {
      message: { role: string; content: Array<{ type: string; text: string }> };
      session_id?: string;
    };
    expect(assistantData.message.role).toBe('assistant');
    expect(assistantData.message.content[0].text).toBe('hello back');
    expect(assistantData.session_id).toBe(TRANSCRIPT_UUID);

    // The STRING-content user line is wrapped, not dropped.
    const user = outputs.find((e) => (e.data as { type?: string }).type === 'user');
    expect(user).toBeDefined();
    const userContent = (user?.data as { message: { content: Array<{ content: string }> } }).message
      .content;
    expect(userContent[0].content).toBe('hello from the composer');

    // Noise (`system`/`local_command`) and the file-history-snapshot line are
    // dropped by the normalizer — they must never surface as panel envelopes.
    expect(
      outputs.some((e) => {
        const t = (e.data as { type?: string } | null)?.type;
        return t === 'system' || t === 'file-history-snapshot';
      }),
    ).toBe(false);

    // Production consumption: the panel manager forwards `output` into the
    // session-output store.
    expect(addPanelOutput).toHaveBeenCalled();
    expect(addPanelOutput.mock.calls.every(([panelId]) => panelId === PANEL_ID)).toBe(true);

    // The manager owns raw_events persistence for this substrate — one row per
    // normalized line, keyed by the resolved gate runId (= panelId here).
    expect(countRawEvents(db, PANEL_ID)).toBe(2);

    // single-writer-per-substrate: claude_session_id comes from the DISCOVERED
    // transcript filename, not an SDK event.
    expect(updateSession).toHaveBeenCalledWith(SESSION_ID, {
      claude_session_id: TRANSCRIPT_UUID,
    });

    // Turn-end is transcript-driven: append the marker and the REAL tail loop
    // picks it up on its next tick.
    expect(turnEnds).toHaveLength(0);
    fs.appendFileSync(transcriptPath, `${stopHookSummaryLine(worktreePath)}\n`, 'utf8');
    await waitFor(() => turnEnds.length > 0, 'turn-end from the transcript stop_hook_summary marker');

    expect(turnEnds[0]).toEqual({ panelId: PANEL_ID, sessionId: SESSION_ID, runId: PANEL_ID });
    // A PERSISTENT REPL survives its turn end: no EOF/`/exit` is written and the
    // PTY stays live (this is the TASK-808 regression IDEA-030 fixed).
    const pty = mgr.ptys[0];
    expect(pty.writes.join('')).not.toContain('\x04');
    expect(mgr.publicProcesses().has(PANEL_ID)).toBe(true);

    // Only a real PTY exit settles the spawn promise (after the drain window).
    pty.fireExit(0);
    await expect(spawnPromise).resolves.toBeUndefined();
  });

  it('(b) writes the worktree spawn artifacts production depends on: the MCP-modal bypass, the per-run cyboflow MCP config, and the inline gating + turn-end hooks', async () => {
    scheduleTranscriptAfterSnapshot([
      fileHistorySnapshotLine(),
      assistantTextLine('ack', worktreePath),
    ]);

    const spawnPromise = startPanelDetached('do the thing');
    // Wait for the transcript to bind rather than merely for the PTY: killing or
    // exiting a PTY while `TranscriptTailSource` is still in discovery leaves
    // `waitForFirstLine` pending forever (`stop()` clears the discovery timer
    // without settling the promise), so `spawnCliProcess` would never return.
    await waitFor(
      () => outputs.some((e) => (e.data as { type?: string } | null)?.type === 'assistant'),
      'transcript bound (assistant line normalized)',
    );

    // (1) InteractiveMcpEnabler: the project's `.mcp.json` servers are pre-enabled
    // so the REPL never renders the blocking "N new MCP servers found" modal.
    const settingsLocal = JSON.parse(
      fs.readFileSync(path.join(worktreePath, '.claude', 'settings.local.json'), 'utf8'),
    ) as { enabledMcpjsonServers?: string[] };
    expect(settingsLocal.enabledMcpjsonServers).toContain('playwright');

    // (2) The per-run MCP config `--mcp-config` points at, carrying the run's
    // orchestrator-socket credentials.
    const mcpConfigPath = path.join(worktreePath, '.cyboflow', 'interactive-mcp.json');
    const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')) as {
      mcpServers: {
        cyboflow: { command: string; args: string[]; env: Record<string, string>; alwaysLoad: boolean };
      };
    };
    expect(mcpConfig.mcpServers.cyboflow.command).toBe('node');
    expect(mcpConfig.mcpServers.cyboflow.args).toEqual(['/mock/mcp-server.js']);
    expect(mcpConfig.mcpServers.cyboflow.env.CYBOFLOW_RUN_ID).toBe(PANEL_ID);
    expect(mcpConfig.mcpServers.cyboflow.env.CYBOFLOW_ORCH_SOCKET).toBe(ORCH_SOCKET);
    expect(mcpConfig.mcpServers.cyboflow.alwaysLoad).toBe(true);

    const args = mgr.spawnArgs[0];
    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(mcpConfigPath);

    // (3) The hooks ride the INLINE `--settings` argv element — nothing is written
    // into the worktree's `.claude/settings.json` (that is what makes in-place
    // sessions possible on this substrate).
    const inlineSettings = JSON.parse(args[args.indexOf('--settings') + 1]) as {
      hooks: {
        PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
        Stop: Array<{ hooks: Array<{ command: string }> }>;
      };
    };
    // permission_mode 'approve' keeps the wildcard gate.
    expect(
      inlineSettings.hooks.PreToolUse.some(
        (g) => g.matcher === '*' && g.hooks.some((h) => h.command.includes('preToolUseShellHook')),
      ),
    ).toBe(true);
    expect(
      inlineSettings.hooks.PreToolUse.some((g) => g.matcher === 'AskUserQuestion'),
    ).toBe(true);
    expect(inlineSettings.hooks.Stop[0].hooks[0].command).toContain('stopShellHook');
    expect(fs.existsSync(path.join(worktreePath, '.claude', 'settings.json'))).toBe(false);

    // The interactive argv never carries the headless print / stream-json flags.
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--output-format');
    // The transcript pin: claude is told which file to write, before `--`.
    expect(args[args.indexOf('--session-id') + 1]).toBe(TRANSCRIPT_UUID);
    expect(args.indexOf('--session-id')).toBeLessThan(args.indexOf('--'));
    // The prompt is the lone positional operand behind an end-of-options `--`
    // (otherwise the variadic `--mcp-config` swallows it and claude exits 1).
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('do the thing');

    mgr.ptys[0].fireExit(0);
    await expect(spawnPromise).resolves.toBeUndefined();
  });

  it('(c) stopping the panel tears the run down: the PTY is killed, the transcript tail stops, and later transcript appends produce no further output', async () => {
    scheduleTranscriptAfterSnapshot([
      fileHistorySnapshotLine(),
      assistantTextLine('first', worktreePath),
    ]);

    startPanelDetached('work');
    await waitFor(
      () => outputs.some((e) => (e.data as { type?: string } | null)?.type === 'assistant'),
      'first assistant line',
    );
    const beforeStop = outputs.length;

    await panelManager.stopPanel(PANEL_ID);

    expect(mgr.ptys[0].killed).toBe(true);
    expect(mgr.publicProcesses().has(PANEL_ID)).toBe(false);
    expect(mgr.publicTailSources().has(PANEL_ID)).toBe(false);

    // The tail source is genuinely stopped, not merely dereferenced: an append
    // that the live tail loop would have picked up within ~50ms yields nothing.
    fs.appendFileSync(transcriptPath, `${assistantTextLine('after stop', worktreePath)}\n`, 'utf8');
    await new Promise((r) => setTimeout(r, 300));
    expect(outputs).toHaveLength(beforeStop);
    expect(countRawEvents(db, PANEL_ID)).toBe(1);
  });
});
