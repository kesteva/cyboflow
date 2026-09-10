/**
 * Unit coverage for relayOrSpawnPtyPanel — the panel-scoped relay/spawn seam
 * that gives every PTY chat panel (interactive Claude / Codex PTY / OMP PTY)
 * its OWN live REPL, keyed by the panel's own id. Guards the "second PTY chat
 * doesn't work" and "second codex chat shares a stream" regressions at the
 * routing layer:
 *   - an ADDED panel spawns a fresh REPL under its OWN panelId (identity
 *     registration + startPanel), not the session's first panel;
 *   - a live panel relays a real user turn (relayUserTurn), never re-spawning;
 *   - an eager-spawn probe (input=null) uses the runtime briefing and no-ops on
 *     an already-live panel;
 *   - SDK / demo panels are NOT handled (returns false → caller keeps its path).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  relayOrSpawnPtyPanel,
  type PtyPanelDispatchDeps,
  type PtyPanelLike,
} from '../ptyPanelDispatch';
import {
  QUICK_PTY_BRIEFING,
  QUICK_CODEX_PTY_BRIEFING,
  QUICK_OMP_PTY_BRIEFING,
} from '../quickSessionBriefings';

interface DbSessionStub {
  agent_runtime?: string | null;
  substrate?: 'sdk' | 'interactive' | null;
  chat_run_id?: string | null;
}

/** The three PTY managers are stubbed identically; only the routing differs. */
interface PtyManagerStub {
  isPanelRunning: ReturnType<typeof vi.fn>;
  relayUserTurn: ReturnType<typeof vi.fn>;
  startPanel: ReturnType<typeof vi.fn>;
}

function makeDeps(
  dbSession: DbSessionStub,
  overrides: {
    demoMode?: boolean;
    worktreePath?: string | null;
    running?: Set<string>;
    chatSentinelProvider?: (sessionId: string) => string;
  } = {},
): {
  deps: PtyPanelDispatchDeps;
  interactive: PtyManagerStub;
  codex: PtyManagerStub;
  omp: PtyManagerStub;
  registerLivePanel: ReturnType<typeof vi.fn>;
  registerCodexPtyPanel: ReturnType<typeof vi.fn>;
  registerOmpPtyPanel: ReturnType<typeof vi.fn>;
  updateSession: ReturnType<typeof vi.fn>;
} {
  const running = overrides.running ?? new Set<string>();
  const makeManager = (): PtyManagerStub => ({
    isPanelRunning: vi.fn((panelId: string) => running.has(panelId)),
    relayUserTurn: vi.fn(),
    startPanel: vi.fn(async () => {}),
  });
  const interactive = makeManager();
  const codex = makeManager();
  const omp = makeManager();
  const registerLivePanel = vi.fn();
  const registerCodexPtyPanel = vi.fn();
  const registerOmpPtyPanel = vi.fn();
  const updateSession = vi.fn(async () => {});

  const deps: PtyPanelDispatchDeps = {
    sessionManager: {
      getDbSession: vi.fn(() => dbSession),
      getSession: vi.fn(async () => ({
        worktreePath: overrides.worktreePath === undefined ? '/tmp/wt' : overrides.worktreePath,
        permissionMode: 'ignore' as const,
      })),
      updateSession,
    },
    databaseService: {
      getPanelSettings: vi.fn(() => ({ model: 'opus', fastMode: false, reasoningEffort: undefined })),
    },
    configManager: { isDemoMode: () => overrides.demoMode === true },
    interactiveCliManager: interactive,
    codexPtyManager: codex,
    ompPtyManager: omp,
    registerLivePanel,
    registerCodexPtyPanel,
    registerOmpPtyPanel,
    ...(overrides.chatSentinelProvider ? { chatSentinelProvider: overrides.chatSentinelProvider } : {}),
  };
  return {
    deps,
    interactive,
    codex,
    omp,
    registerLivePanel,
    registerCodexPtyPanel,
    registerOmpPtyPanel,
    updateSession,
  };
}

const panel = (id: string, sessionId = 'sess', substrate?: 'sdk' | 'interactive'): PtyPanelLike => ({
  id,
  sessionId,
  substrate,
});

beforeEach(() => vi.clearAllMocks());

describe('relayOrSpawnPtyPanel — interactive Claude', () => {
  it('eager-spawns an added interactive panel under its OWN id, briefing on the system prompt', async () => {
    const { deps, interactive, registerLivePanel } = makeDeps({ substrate: 'interactive', chat_run_id: 'chat-run' });

    const handled = await relayOrSpawnPtyPanel(deps, panel('added-P'), null);

    expect(handled).toBe(true);
    // Identity registration: panelId === runId (NOT the shared chat sentinel).
    expect(registerLivePanel).toHaveBeenCalledWith('added-P', 'added-P');
    expect(interactive.startPanel).toHaveBeenCalledTimes(1);
    const args = interactive.startPanel.mock.calls[0];
    expect(args[0]).toBe('added-P'); // panelId
    // The briefing is session CONTEXT, not a turn: it rides
    // --append-system-prompt and the REPL opens idle rather than spending its
    // first turn acknowledging a message the user never sent.
    expect(args[3]).toBe(''); // prompt — no user turn on an eager spawn
    expect(args[11]).toBe(QUICK_PTY_BRIEFING); // systemPromptAppend
    expect(interactive.relayUserTurn).not.toHaveBeenCalled();
  });

  it('resolves the per-panel interactive override on an otherwise-SDK session', async () => {
    const { deps, interactive } = makeDeps({ substrate: 'sdk' });
    const handled = await relayOrSpawnPtyPanel(deps, panel('override-P', 'sess', 'interactive'), 'hi');
    expect(handled).toBe(true);
    expect(interactive.startPanel).toHaveBeenCalledTimes(1);
    // Fresh spawn with the user's text as the first prompt.
    expect(interactive.startPanel.mock.calls[0][3]).toBe('hi');
  });

  it('a spawn carrying a user turn STILL gets the briefing (the old `input ?? briefing` gap)', async () => {
    // Keying the briefing off `input ?? …` meant the common add-a-chat path —
    // a panel spawned BY the user's first message — silently ran with no
    // session context at all. Separate channels make both reachable at once.
    const { deps, interactive } = makeDeps({ substrate: 'interactive' });
    await relayOrSpawnPtyPanel(deps, panel('with-input-P'), 'fix the parser');
    const args = interactive.startPanel.mock.calls[0];
    expect(args[3]).toBe('fix the parser');
    expect(args[11]).toBe(QUICK_PTY_BRIEFING);
  });

  it('relays a real user turn into a LIVE panel (no re-spawn)', async () => {
    const running = new Set<string>(['live-P']);
    const { deps, interactive, registerLivePanel } = makeDeps({ substrate: 'interactive' }, { running });

    const handled = await relayOrSpawnPtyPanel(deps, panel('live-P'), 'a message');

    expect(handled).toBe(true);
    expect(interactive.relayUserTurn).toHaveBeenCalledWith('live-P', 'a message');
    expect(interactive.startPanel).not.toHaveBeenCalled();
    expect(registerLivePanel).not.toHaveBeenCalled();
  });

  it('is a strict no-op relay for an eager-spawn probe on an already-live panel', async () => {
    const running = new Set<string>(['live-P']);
    const { deps, interactive } = makeDeps({ substrate: 'interactive' }, { running });

    const handled = await relayOrSpawnPtyPanel(deps, panel('live-P'), null);

    expect(handled).toBe(true);
    expect(interactive.relayUserTurn).not.toHaveBeenCalled();
    expect(interactive.startPanel).not.toHaveBeenCalled();
  });
});

describe('relayOrSpawnPtyPanel — Codex PTY', () => {
  it('eager-spawns an added codex-pty panel under its own id with the Codex briefing', async () => {
    const { deps, codex, registerCodexPtyPanel } = makeDeps({ agent_runtime: 'codex-pty', chat_run_id: 'chat-run' });

    const handled = await relayOrSpawnPtyPanel(deps, panel('codex-P'), null);

    expect(handled).toBe(true);
    expect(registerCodexPtyPanel).toHaveBeenCalledWith('codex-P', 'codex-P');
    expect(codex.startPanel).toHaveBeenCalledTimes(1);
    const args = codex.startPanel.mock.calls[0];
    expect(args[0]).toBe('codex-P'); // panelId
    expect(args[3]).toBe(QUICK_CODEX_PTY_BRIEFING); // briefing
    expect(args[6]).toBe('chat-run'); // runId aligned with the session chat sentinel
  });

  it('relays a real turn into a live codex-pty panel', async () => {
    const running = new Set<string>(['codex-P']);
    const { deps, codex } = makeDeps({ agent_runtime: 'codex-pty' }, { running });

    await relayOrSpawnPtyPanel(deps, panel('codex-P'), 'ping');

    expect(codex.relayUserTurn).toHaveBeenCalledWith('codex-P', 'ping');
    expect(codex.startPanel).not.toHaveBeenCalled();
  });

  it('keeps a codex-pty session on the Codex terminal when substrate was never stamped', async () => {
    // The substrate resolver floors an absent value to 'sdk'; the lane resolver
    // supplies 'interactive' for codex-pty so an older session row cannot lose
    // its terminal to the SDK lane.
    const { deps, codex } = makeDeps({ agent_runtime: 'codex-pty' });
    const handled = await relayOrSpawnPtyPanel(deps, panel('legacy-P'), 'ping');
    expect(handled).toBe(true);
    expect(codex.startPanel).toHaveBeenCalledTimes(1);
  });

  /**
   * The Codex gate vehicle must come from the chat-sentinel PROVIDER, not a raw
   * `chat_run_id` read — the provider is what revives a `__quick__` sentinel that
   * boot recovery force-failed on app restart. Reading the column directly baked a
   * TERMINAL run into the spawn's CYBOFLOW_RUN_ID, so a resumed Codex terminal
   * lost its cyboflow_* MCP writes (`run_not_active`) and its approval gate
   * (`UPDATE … WHERE status='running'` matched nothing). The Claude lanes never
   * had this hole: their managers resolve the gate via resolveGateRunId.
   */
  it('resolves the codex runId through the chat-sentinel provider, not the raw column', async () => {
    const chatSentinelProvider = vi.fn(() => 'revived-run');
    const { deps, codex } = makeDeps(
      { agent_runtime: 'codex-pty', chat_run_id: 'parked-run' },
      { chatSentinelProvider },
    );

    await relayOrSpawnPtyPanel(deps, panel('codex-P', 'sess-42'), 'ping');

    expect(chatSentinelProvider).toHaveBeenCalledWith('sess-42');
    expect(codex.startPanel.mock.calls[0][6]).toBe('revived-run');
  });

  it('falls back to the raw chat_run_id when no provider is injected (tests/boot)', async () => {
    const { deps, codex } = makeDeps({ agent_runtime: 'codex-pty', chat_run_id: 'chat-run' });

    await relayOrSpawnPtyPanel(deps, panel('codex-P'), 'ping');

    expect(codex.startPanel.mock.calls[0][6]).toBe('chat-run');
  });
});

describe('relayOrSpawnPtyPanel — OMP PTY', () => {
  it('eager-spawns an added omp-pty panel under its own id with the OMP briefing', async () => {
    const { deps, omp, codex, interactive, registerOmpPtyPanel } = makeDeps({
      agent_runtime: 'omp-pty',
      chat_run_id: 'chat-run',
    });

    const handled = await relayOrSpawnPtyPanel(deps, panel('omp-P'), null);

    expect(handled).toBe(true);
    expect(registerOmpPtyPanel).toHaveBeenCalledWith('omp-P', 'omp-P');
    expect(omp.startPanel).toHaveBeenCalledTimes(1);
    const args = omp.startPanel.mock.calls[0];
    expect(args[0]).toBe('omp-P'); // panelId
    expect(args[3]).toBe(QUICK_OMP_PTY_BRIEFING); // briefing
    expect(args[6]).toBe('chat-run'); // runId aligned with the session chat sentinel
    // OMP's TUI takes no per-turn thinking flag, so nothing follows the runId.
    expect(args).toHaveLength(7);
    // Neither sibling terminal may answer for OMP.
    expect(codex.startPanel).not.toHaveBeenCalled();
    expect(interactive.startPanel).not.toHaveBeenCalled();
  });

  it('relays a real turn into a live omp-pty panel', async () => {
    const running = new Set<string>(['omp-P']);
    const { deps, omp } = makeDeps({ agent_runtime: 'omp-pty' }, { running });

    await relayOrSpawnPtyPanel(deps, panel('omp-P'), 'ping');

    expect(omp.relayUserTurn).toHaveBeenCalledWith('omp-P', 'ping');
    expect(omp.startPanel).not.toHaveBeenCalled();
  });

  it('keeps an omp-pty session on the OMP terminal when substrate was never stamped', async () => {
    const { deps, omp } = makeDeps({ agent_runtime: 'omp-pty' });
    const handled = await relayOrSpawnPtyPanel(deps, panel('legacy-omp-P'), 'ping');
    expect(handled).toBe(true);
    expect(omp.startPanel).toHaveBeenCalledTimes(1);
  });

  it('resolves the omp runId through the chat-sentinel provider, not the raw column', async () => {
    const chatSentinelProvider = vi.fn(() => 'revived-run');
    const { deps, omp } = makeDeps(
      { agent_runtime: 'omp-pty', chat_run_id: 'parked-run' },
      { chatSentinelProvider },
    );

    await relayOrSpawnPtyPanel(deps, panel('omp-P', 'sess-42'), 'ping');

    expect(chatSentinelProvider).toHaveBeenCalledWith('sess-42');
    expect(omp.startPanel.mock.calls[0][6]).toBe('revived-run');
  });

  it('routes an interactive override in an omp-SDK session to the OMP terminal, not Claude', async () => {
    const { deps, omp, interactive } = makeDeps({
      agent_runtime: 'omp-sdk',
      substrate: 'sdk',
      chat_run_id: 'chat-run',
    });

    const handled = await relayOrSpawnPtyPanel(deps, panel('omp-override-P', 'sess', 'interactive'), 'hi');

    expect(handled).toBe(true);
    expect(omp.startPanel).toHaveBeenCalledTimes(1);
    expect(interactive.startPanel).not.toHaveBeenCalled();
  });

  it('leaves an sdk override in an omp-PTY session to the caller (the RPC path)', async () => {
    const { deps, omp } = makeDeps({ agent_runtime: 'omp-pty', substrate: 'interactive' });

    const handled = await relayOrSpawnPtyPanel(deps, panel('omp-sdk-override-P', 'sess', 'sdk'), 'hi');

    expect(handled).toBe(false); // not a PTY lane — panels:continue starts an OMP SDK turn
    expect(omp.startPanel).not.toHaveBeenCalled();
  });
});

/**
 * The provider (session-wide) and the substrate (per-panel) resolve
 * INDEPENDENTLY. Both cells below were unreachable while this seam tested
 * `agent_runtime === 'codex-pty'` alone.
 */
describe('relayOrSpawnPtyPanel — per-panel overrides stay inside the session provider', () => {
  it('routes an interactive override in a codex-SDK session to the CODEX terminal, not Claude', async () => {
    const { deps, codex, interactive, registerCodexPtyPanel } = makeDeps({
      agent_runtime: 'codex-sdk',
      substrate: 'sdk',
      chat_run_id: 'chat-run',
    });

    const handled = await relayOrSpawnPtyPanel(deps, panel('codex-override-P', 'sess', 'interactive'), 'hi');

    expect(handled).toBe(true);
    expect(codex.startPanel).toHaveBeenCalledTimes(1);
    expect(registerCodexPtyPanel).toHaveBeenCalledWith('codex-override-P', 'codex-override-P');
    // The provider must NOT flip mid-session.
    expect(interactive.startPanel).not.toHaveBeenCalled();
  });

  it('leaves an sdk override in a codex-PTY session to the caller (the app-server path)', async () => {
    const { deps, codex, interactive } = makeDeps({ agent_runtime: 'codex-pty', substrate: 'interactive' });

    const handled = await relayOrSpawnPtyPanel(deps, panel('sdk-override-P', 'sess', 'sdk'), 'hi');

    expect(handled).toBe(false); // not a PTY lane — panels:continue starts a Codex SDK turn
    expect(codex.startPanel).not.toHaveBeenCalled();
    expect(interactive.startPanel).not.toHaveBeenCalled();
  });

  it('still honors demo mode only for the Claude terminal, never for Codex', async () => {
    const { deps, codex } = makeDeps({ agent_runtime: 'codex-sdk', substrate: 'sdk' }, { demoMode: true });
    const handled = await relayOrSpawnPtyPanel(deps, panel('codex-demo-P', 'sess', 'interactive'), null);
    expect(handled).toBe(true);
    expect(codex.startPanel).toHaveBeenCalledTimes(1);
  });

  it('does not let demo mode swallow an OMP terminal either', async () => {
    const { deps, omp } = makeDeps({ agent_runtime: 'omp-pty' }, { demoMode: true });
    const handled = await relayOrSpawnPtyPanel(deps, panel('omp-demo-P'), null);
    expect(handled).toBe(true);
    expect(omp.startPanel).toHaveBeenCalledTimes(1);
  });
});

describe('relayOrSpawnPtyPanel — not handled', () => {
  it('returns false for an SDK panel (caller keeps its structured path)', async () => {
    const { deps, interactive, codex } = makeDeps({ substrate: 'sdk' });
    const handled = await relayOrSpawnPtyPanel(deps, panel('sdk-P'), 'hi');
    expect(handled).toBe(false);
    expect(interactive.startPanel).not.toHaveBeenCalled();
    expect(codex.startPanel).not.toHaveBeenCalled();
  });

  it('returns false for a demo interactive session (real REPL never spawns)', async () => {
    const { deps, interactive } = makeDeps({ substrate: 'interactive' }, { demoMode: true });
    const handled = await relayOrSpawnPtyPanel(deps, panel('demo-P'), null);
    expect(handled).toBe(false);
    expect(interactive.startPanel).not.toHaveBeenCalled();
  });

  it('returns false when the session has no worktree to spawn in', async () => {
    const { deps, interactive } = makeDeps({ substrate: 'interactive' }, { worktreePath: null });
    const handled = await relayOrSpawnPtyPanel(deps, panel('no-wt-P'), null);
    expect(handled).toBe(false);
    expect(interactive.startPanel).not.toHaveBeenCalled();
  });
});
