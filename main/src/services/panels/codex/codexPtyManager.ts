import type { AgentProvider } from '../../../../../shared/types/agentRuntime';
import { AsyncLocalStorage } from 'node:async_hooks';
import type * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { ConversationMessage } from '../../../database/models';
import { getShellPath, findExecutableInPath } from '../../../utils/shellPath';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { probeCliVersion, type CliVersionProbeResult } from '../cli/cliVersionProbe';
import {
  prependCodexPathToEnvironment,
  resolveCodexExecutablePath,
  type ResolvedCodexExecutable,
} from './codexExecutablePath';
import { isPermissionMode, type PermissionMode } from '../../../../../shared/types/workflows';
import { resolveAgentModelAlias } from '../agentModelContext';
import type { ReasoningEffort } from '../../../../../shared/types/reasoningEffort';

interface CodexPtySpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  permissionMode?: 'approve' | 'ignore';
  agentPermissionMode?: PermissionMode;
  model?: string;
  runId?: string;
  /**
   * Per-agent reasoning-effort selection (IDEA-029). Stored for parity with the
   * Codex app-server (SDK) manager and the Claude managers; buildCommandArgs
   * does not yet emit an interactive-CLI flag for it — the PTY path has no
   * turn-options object that reaches runConfig's buildCodexAppServerTurnOptions.
   */
  reasoningEffort?: ReasoningEffort;
  [key: string]: unknown;
}

type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type CodexApprovalPolicy = 'on-request' | 'never';

interface CodexPermissionFlags {
  sandbox: CodexSandboxMode;
  approval: CodexApprovalPolicy;
}

interface CodexPtySpawnContext {
  panelId: string;
  sessionId: string;
  runId: string;
}

/**
 * The in-flight composer turn for one panel, plus every turn that arrived while
 * it was still waiting for its deferred Enter. See
 * {@link CodexPtyManager.relayUserTurn}.
 */
interface PendingComposerSubmit {
  /**
   * The EXACT pty the in-flight turn's body was written to. Every later step of
   * this chain re-checks identity against it, so a panel that is stopped — or
   * killed and respawned under the same panelId by continuePanel /
   * restartPanelWithHistory — never receives a body or an Enter meant for the
   * process it replaced.
   */
  target: pty.IPty;
  /** Bodies that arrived mid-chain, in arrival order. Drained one turn at a time. */
  queue: string[];
  /** The next scheduled step (Enter for the in-flight body, or a queued body). */
  timer: ReturnType<typeof setTimeout> | null;
}

const PTY_BACKLOG_CAP_BYTES = 200_000;

/**
 * How long to wait after writing a composer turn's BODY before writing the
 * SEPARATE '\r' (Enter) that submits it. See {@link CodexPtyManager.relayUserTurn}.
 *
 * WHY THE SPLIT EXISTS. The Codex TUI runs paste-burst detection over its stdin:
 * characters that arrive together are treated as a PASTE, and a '\r' riding
 * inside that same burst is inserted as a literal NEWLINE instead of acting as
 * Enter. The turn's text then just sits in the composer, unsubmitted, forever —
 * which is exactly the "the composer's follow-up never sends, but typing the
 * same thing into the terminal works" report. (InteractiveClaudeManager hit the
 * identical class of bug against `claude` and fixes it the same way; see its
 * SUBMIT_DELAY_MS / submitToRepl.)
 *
 * MEASURED against the bundled Codex CLI 0.144.3, driving the real TUI through a
 * node-pty harness and reading the rendered screen (short body, idle composer,
 * both on a fresh REPL and as a genuine 2nd turn after a `-- <prompt>` 1st turn):
 *   body + '\r' in ONE write ............... never submits (stuck in composer)
 *   '\r' 0ms / 5ms / 10ms / 15ms later ..... never submits
 *   '\r' 20ms / 60ms / 150ms later ......... submits
 *   char-by-char, then '\r' (human typing) . submits
 * So the burst window is >15ms and <=20ms. 150ms is ~7x that floor — margin for a
 * busy main-process event loop, still far below human perception.
 * RE-CONFIRMED on 0.153.3 (python pty.fork harness, submission = a user message
 * landing in the ~/.codex/sessions rollout): one-write burst never submits;
 * '\r' 30 / 60 / 100 / 150ms later submits.
 */
const COMPOSER_SUBMIT_DELAY_MS = 150;

export function codexPermissionFlagsForMode(mode: PermissionMode): CodexPermissionFlags {
  switch (mode) {
    case 'default':
      return { sandbox: 'read-only', approval: 'on-request' };
    case 'acceptEdits':
      return { sandbox: 'workspace-write', approval: 'on-request' };
    case 'auto':
      return { sandbox: 'workspace-write', approval: 'on-request' };
    case 'dontAsk':
      return { sandbox: 'danger-full-access', approval: 'never' };
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unhandled Codex permission mode: ${_exhaustive}`);
    }
  }
}

export class CodexPtyManager extends AbstractCliManager {
  private resolvedExecutablePath: string | null = null;
  private bundledPathDir: string | null = null;
  private readonly panelRunIds = new Map<string, string>();
  private readonly ptyBacklog = new Map<string, string>();
  private readonly ptySpawnContext = new AsyncLocalStorage<CodexPtySpawnContext>();
  /** Per-panel composer chain; see {@link relayUserTurn}. Absent = nothing in flight. */
  private readonly pendingComposerSubmits = new Map<string, PendingComposerSubmit>();

  protected getCliToolName(): string {
    return 'Codex';
  }

  /** Vendor for the provider-access guard (Settings → Integrations). */
  protected getAgentProvider(): AgentProvider {
    return 'codex';
  }

  /**
   * Resolve the Codex CLI, preferring the binary Cyboflow ships over whatever
   * the user happens to have on PATH.
   *
   * WHY bundled-first: the app already vendors `@openai/codex` as a native
   * platform package, and every OTHER Codex consumer (the app-server/SDK
   * manager, the eval judge, the visual verifier) resolves it through
   * resolveCodexExecutablePath. This PTY lane alone hunted PATH, so a session
   * could fail with "Codex not available" at the same moment a codex-sdk run
   * was healthy. The bundled binary is native per-arch with no Node dependency,
   * which also removes the npm-shim shebang failure entirely.
   *
   * An explicit customPath still wins, and PATH remains the fallback for dev
   * trees where the platform package is not installed.
   */
  protected async testCliAvailability(customPath?: string): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    const configuredPath = customPath?.trim();

    if (!configuredPath) {
      const bundled = this.resolveBundledExecutable();
      if (bundled) {
        this.bundledPathDir = bundled.pathDir;
        try {
          const probe = await this.probeVersion(bundled.executablePath);
          this.resolvedExecutablePath = bundled.executablePath;
          return { available: true, version: probe.version, path: bundled.executablePath };
        } catch (err) {
          // Fall through to PATH resolution: a broken bundle should degrade to
          // the user's own install rather than take the lane down with it.
          this.bundledPathDir = null;
          this.logger?.warn(
            `[Codex] Bundled Codex executable at ${bundled.executablePath} failed its version probe, falling back to PATH: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    getShellPath();
    const resolvedPath = configuredPath || findExecutableInPath('codex');
    if (!resolvedPath) {
      this.resolvedExecutablePath = null;
      return { available: false, error: 'codex executable not found in PATH' };
    }

    try {
      const probe = await this.probeVersion(resolvedPath);
      if (probe.usedNodeFallback) {
        this.markNeedsNodeFallback();
      }
      this.resolvedExecutablePath = resolvedPath;
      return { available: true, version: probe.version, path: resolvedPath };
    } catch (err) {
      this.resolvedExecutablePath = null;
      return {
        available: false,
        error: `Failed to run "${resolvedPath} --version": ${err instanceof Error ? err.message : String(err)}`,
        path: resolvedPath,
      };
    }
  }

  /**
   * Resolve the vendored Codex binary, or null when this tree has no platform
   * package (a dev checkout that skipped the optional dependency).
   */
  protected resolveBundledExecutable(): ResolvedCodexExecutable | null {
    try {
      return resolveCodexExecutablePath();
    } catch (err) {
      this.logger?.verbose(
        `[Codex] No bundled Codex executable available, using PATH: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Probe `--version` with the SAME environment the spawn will use. Seam kept
   * protected so tests can drive availability without touching the real
   * filesystem or shelling out.
   */
  protected async probeVersion(executablePath: string): Promise<CliVersionProbeResult> {
    return probeCliVersion(executablePath, await this.getSystemEnvironment());
  }

  /**
   * Put the bundled distribution's `codex-path` directory on PATH, matching
   * what the app-server manager does — the Codex binary resolves its own helper
   * executables from there.
   */
  protected override async getSystemEnvironment(): Promise<{ [key: string]: string }> {
    const environment = await super.getSystemEnvironment();
    if (!this.bundledPathDir) {
      return environment;
    }
    return prependCodexPathToEnvironment(environment, this.bundledPathDir) as {
      [key: string]: string;
    };
  }

  protected async getCliExecutablePath(): Promise<string> {
    if (this.resolvedExecutablePath) {
      return this.resolvedExecutablePath;
    }
    const availability = await this.testCliAvailability();
    if (!availability.available || !availability.path) {
      throw new Error(`Codex CLI not available: ${availability.error ?? 'unknown error'}`);
    }
    return availability.path;
  }

  protected buildCommandArgs(options: CodexPtySpawnOptions): string[] {
    const args: string[] = [];
    const mode = options.agentPermissionMode ?? this.resolveSessionAgentPermissionMode(options.sessionId, options.permissionMode);
    const flags = codexPermissionFlagsForMode(mode);
    args.push('--sandbox', flags.sandbox, '--ask-for-approval', flags.approval);

    const resolvedModel = resolveAgentModelAlias('codex', options.model);
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }

    if (options.prompt.trim().length > 0) {
      args.push('--', options.prompt);
    }

    return args;
  }

  protected parseCliOutput(data: string, panelId: string, sessionId: string): Array<{ panelId: string; sessionId: string; type: 'json' | 'stdout' | 'stderr'; data: unknown; timestamp: Date }> {
    return [{
      panelId,
      sessionId,
      type: 'stdout',
      data,
      timestamp: new Date(),
    }];
  }

  protected async initializeCliEnvironment(_options: CodexPtySpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async getCliEnvironment(_options: CodexPtySpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  // Keyed by panelId, not by scanning `this.processes` for `sessionId` matches
  // — a session can host several Codex PTY panels (Add-chat), and the scan
  // form deleted panelRunIds/ptyBacklog for EVERY panel in the session,
  // including a still-live sibling whose process had not exited.
  protected async cleanupCliResources(panelId: string, _sessionId: string): Promise<void> {
    // Cancel any armed composer step for this panel. The identity guard already
    // makes a late step a no-op, so this is hygiene (no orphan timer, no map
    // entry surviving the process) rather than the correctness barrier.
    this.clearPendingComposerSubmit(panelId);
    const runId = this.panelRunIds.get(panelId);
    this.panelRunIds.delete(panelId);
    if (runId) {
      this.ptyBacklog.delete(runId);
    }
  }

  override async spawnCliProcess(options: CodexPtySpawnOptions): Promise<void> {
    const runId = options.runId ?? options.panelId;
    this.panelRunIds.set(options.panelId, runId);
    try {
      await this.runWithPtySpawnContext(
        { panelId: options.panelId, sessionId: options.sessionId, runId },
        () => super.spawnCliProcess({ ...options, runId }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit('pty-output', {
        panelId: options.panelId,
        sessionId: options.sessionId,
        runId,
        type: 'pty',
        data: `\r\n\x1b[31mCodex failed to start: ${message}\x1b[0m\r\n`,
        timestamp: new Date(),
      });
      this.emit('exit', {
        panelId: options.panelId,
        sessionId: options.sessionId,
        exitCode: 1,
        signal: null,
      });
      this.panelRunIds.delete(options.panelId);
      this.ptyBacklog.delete(runId);
      throw err;
    }
  }

  protected override async spawnPtyProcess(command: string, args: string[], cwd: string, env: { [key: string]: string }): Promise<pty.IPty> {
    const ptyProcess = await super.spawnPtyProcess(command, args, cwd, env);
    const context = this.ptySpawnContext.getStore();
    if (context) {
      ptyProcess.onData((data: string) => {
        this.recordPtyBacklog(context.runId, data);
        this.emit('pty-output', {
          panelId: context.panelId,
          sessionId: context.sessionId,
          runId: context.runId,
          type: 'pty',
          data,
          timestamp: new Date(),
        });
      });
    }
    return ptyProcess;
  }

  async startPanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    permissionMode?: 'approve' | 'ignore',
    model?: string,
    runId?: string,
    reasoningEffort?: ReasoningEffort,
  ): Promise<void> {
    await this.spawnCliProcess({
      panelId,
      sessionId,
      worktreePath,
      prompt,
      permissionMode,
      agentPermissionMode: this.resolveSessionAgentPermissionMode(sessionId, permissionMode),
      model,
      runId,
      reasoningEffort,
    });
  }

  async continuePanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    _conversationHistory: ConversationMessage[],
    permissionMode?: 'approve' | 'ignore',
    model?: string,
  ): Promise<void> {
    await this.killProcess(panelId);
    await this.startPanel(panelId, sessionId, worktreePath, prompt, permissionMode, model);
  }

  /**
   * Composer-relay seam: submit a chat-composer turn into the LIVE Codex REPL the
   * way a human types it — the BODY first, then '\r' (Enter) as its OWN, LATER
   * write once the TUI's paste-burst window has closed (COMPOSER_SUBMIT_DELAY_MS).
   * A single `body + '\r'` write is swallowed as a pasted newline and never
   * submits; see COMPOSER_SUBMIT_DELAY_MS for the measurements.
   *
   * The panel receives the message exactly once — nothing here restarts or
   * replaces the persistent PTY process.
   *
   * TURNS ARE SERIALIZED PER PANEL. The delay opens a ~150ms window in which a
   * second turn can arrive, and NOTHING upstream closes it: the IPC relays
   * (`ptyPanelDispatch`, `sessions:input`) call straight through, and
   * QuickSessionComposer deliberately never gates its busy state on the send, so
   * the composer is ready for the next message immediately. Writing the second
   * body during that window would concatenate it onto the FIRST, still-unsubmitted
   * one inside the TUI composer (`bodyAbodyB`, no separator) — the pending Enter
   * would then submit both as ONE turn and the second Enter would hit an empty
   * composer. So a turn that arrives mid-chain is QUEUED, and its body is not
   * written until the previous turn's Enter has actually gone out. Queued bodies
   * also wait a full COMPOSER_SUBMIT_DELAY_MS after that Enter, so they never ride
   * in the same burst as it (which would make the Enter itself a literal newline).
   *
   * Flushing the pending Enter EARLY instead of queueing would be wrong: a second
   * turn arriving a few ms after the first would fire that Enter inside the very
   * burst window the delay exists to clear, and the first turn would never submit.
   *
   * The raw-keystroke path (xterm -> relayRawInput, where Enter already arrives as
   * its own '\r') must NOT route through here: it is byte-for-byte passthrough.
   */
  relayUserTurn(panelId: string, input: string): void {
    const pending = this.pendingComposerSubmits.get(panelId);
    if (pending && this.getProcess(panelId)?.process === pending.target) {
      // A turn is mid-flight on the SAME process. Queue behind it; the chain
      // drains it once the in-flight Enter has been written.
      pending.queue.push(input);
      return;
    }
    if (pending) {
      // The chain belongs to a process that is gone or has been replaced. Drop
      // it (its remaining steps would be suppressed by the identity guard
      // anyway) so this turn starts clean against whatever is live now.
      this.clearPendingComposerSubmit(panelId);
    }
    this.beginComposerTurn(panelId, input);
  }

  /**
   * Write a turn's body immediately and arm its deferred Enter. Throws when the
   * panel has no live process — preserved from the original single-write form so
   * a dead-panel relay still surfaces to the IPC caller rather than silently
   * half-completing.
   */
  private beginComposerTurn(panelId: string, input: string): void {
    this.sendInput(panelId, input);
    // Pin the EXACT process the body went to. stopPanel / continuePanel /
    // restartPanelWithHistory can kill (and, for the latter two, respawn) this
    // panelId inside the delay window, so a presence-only `processes.has()` check
    // is not enough: it would let the deferred Enter land in an UNRELATED fresh
    // REPL that never received the body. Identity match or nothing.
    //
    // The `!target` guard cannot fire in practice (the sendInput above throws on
    // a missing process, and nothing awaits in between) — it is what NARROWS
    // `target` to a concrete IPty. Do not "simplify" it away: the comparisons in
    // the chain steps would then degrade to `undefined !== undefined` on a
    // torn-down panel, i.e. stop being identity checks at all.
    const target = this.getProcess(panelId)?.process;
    if (!target) return;
    const pending: PendingComposerSubmit = { target, queue: [], timer: null };
    this.pendingComposerSubmits.set(panelId, pending);
    pending.timer = this.scheduleComposerStep(() => this.submitPendingComposerTurn(panelId));
  }

  /**
   * COMPOSER_SUBMIT_DELAY_MS after a body write: send the Enter that submits it,
   * then either arm the next queued turn or retire the chain.
   */
  private submitPendingComposerTurn(panelId: string): void {
    const pending = this.pendingComposerSubmits.get(panelId);
    if (!pending) return;
    pending.timer = null;
    if (this.getProcess(panelId)?.process !== pending.target) {
      // Stopped or replaced inside the window. Neither this Enter nor anything
      // queued behind it belongs to whatever is live now — drop the whole chain
      // rather than commit a stranger's composer.
      this.pendingComposerSubmits.delete(panelId);
      return;
    }
    try {
      this.sendInput(panelId, '\r');
    } catch (err) {
      this.logger?.warn(
        `[Codex] deferred submit '\\r' failed for panel ${panelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.pendingComposerSubmits.delete(panelId);
      return;
    }
    const next = pending.queue.shift();
    if (next === undefined) {
      this.pendingComposerSubmits.delete(panelId);
      return;
    }
    pending.timer = this.scheduleComposerStep(() => this.writeQueuedComposerBody(panelId, next));
  }

  /** Write a queued turn's body onto the now-empty composer and re-arm its Enter. */
  private writeQueuedComposerBody(panelId: string, input: string): void {
    const pending = this.pendingComposerSubmits.get(panelId);
    if (!pending) return;
    pending.timer = null;
    if (this.getProcess(panelId)?.process !== pending.target) {
      this.pendingComposerSubmits.delete(panelId);
      return;
    }
    try {
      this.sendInput(panelId, input);
    } catch (err) {
      this.logger?.warn(
        `[Codex] queued composer body failed for panel ${panelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.pendingComposerSubmits.delete(panelId);
      return;
    }
    pending.timer = this.scheduleComposerStep(() => this.submitPendingComposerTurn(panelId));
  }

  /**
   * One step of a composer chain, one COMPOSER_SUBMIT_DELAY_MS out. Unref'd: a
   * pending Enter must never hold the event loop open at app quit.
   */
  private scheduleComposerStep(step: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(step, COMPOSER_SUBMIT_DELAY_MS);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    return timer;
  }

  /** Abandon a panel's composer chain, cancelling whatever step it had armed. */
  private clearPendingComposerSubmit(panelId: string): void {
    const pending = this.pendingComposerSubmits.get(panelId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingComposerSubmits.delete(panelId);
  }

  /**
   * Raw keystroke passthrough from the xterm pane. Deliberately a SINGLE
   * synchronous write of exactly the bytes received — no splitting, no delay, no
   * shared code with relayUserTurn's deferred Enter. The user's Enter is already
   * its own '\r' here, and the TUI's paste-burst detection is precisely what makes
   * a real paste into the terminal behave like a paste.
   */
  relayRawInput(panelId: string, input: string): void {
    this.sendInput(panelId, input);
  }

  resizePanel(panelId: string, cols: number, rows: number): void {
    const process = this.getProcess(panelId);
    if (!process) return;
    process.process.resize(cols, rows);
  }

  getPtyBacklog(runId: string): string {
    return this.ptyBacklog.get(runId) ?? '';
  }

  async stopPanel(panelId: string): Promise<void> {
    const runId = this.panelRunIds.get(panelId);
    await this.killProcess(panelId);
    this.panelRunIds.delete(panelId);
    if (runId) {
      this.ptyBacklog.delete(runId);
    }
  }

  async restartPanelWithHistory(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    initialPrompt: string,
    _conversationHistory: ConversationMessage[],
  ): Promise<void> {
    await this.killProcess(panelId);
    const permissionMode = this.sessionManager.getDbSession(sessionId)?.permission_mode;
    await this.startPanel(panelId, sessionId, worktreePath, initialPrompt, permissionMode);
  }

  protected getCliNotAvailableMessage(error?: string): string {
    const interpreterAdvice = this.missingInterpreterAdvice(error);
    return [
      `Error: ${error}`,
      '',
      'Codex CLI is not available.',
      '',
      interpreterAdvice ??
        'Install and sign in to Codex with ChatGPT auth, then verify `codex --version` works in your shell.',
    ].join('\n');
  }

  private resolveSessionAgentPermissionMode(
    sessionId: string,
    legacyPermissionMode?: 'approve' | 'ignore',
  ): PermissionMode {
    if (legacyPermissionMode === 'ignore') return 'dontAsk';
    const stored = this.sessionManager.getDbSession(sessionId)?.agent_permission_mode;
    if (isPermissionMode(stored)) return stored;
    return this.configManager?.getDefaultAgentPermissionMode() ?? 'default';
  }

  private recordPtyBacklog(runId: string, data: string): void {
    const next = (this.ptyBacklog.get(runId) ?? '') + data;
    this.ptyBacklog.set(
      runId,
      next.length > PTY_BACKLOG_CAP_BYTES ? next.slice(-PTY_BACKLOG_CAP_BYTES) : next,
    );
  }

  protected runWithPtySpawnContext<T>(
    context: CodexPtySpawnContext,
    operation: () => T,
  ): T {
    return this.ptySpawnContext.run(context, operation);
  }

  protected getActivePtySpawnContext(): CodexPtySpawnContext | undefined {
    return this.ptySpawnContext.getStore();
  }
}
