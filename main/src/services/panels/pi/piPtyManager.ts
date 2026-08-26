import { AsyncLocalStorage } from 'node:async_hooks';
import type * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { AgentProvider } from '../../../../../shared/types/agentRuntime';
import type { ConversationMessage } from '../../../database/models';
import type { PermissionMode } from '../../../../../shared/types/workflows';
import { isPermissionMode } from '../../../../../shared/types/workflows';
import { getShellPath, findExecutableInPath } from '../../../utils/shellPath';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { probeCliVersion, type CliVersionProbeResult } from '../cli/cliVersionProbe';
import { evaluatePiVersionPolicy, PI_MIN_SUPPORTED_VERSION, PI_TESTED_VERSION } from './piVersions';

interface PiPtySpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  permissionMode?: 'approve' | 'ignore';
  agentPermissionMode?: PermissionMode;
  model?: string;
  runId?: string;
  /**
   * Set by {@link PiPtyManager.continuePanel} to request `--continue`
   * (pi's per-project most-recent-session resume) on the respawn. Never set by
   * `startPanel` — a fresh panel always starts a fresh pi session.
   */
  isContinue?: boolean;
  [key: string]: unknown;
}

interface PiPtySpawnContext {
  panelId: string;
  sessionId: string;
  runId: string;
}

const PTY_BACKLOG_CAP_BYTES = 200_000;

/**
 * Every flag {@link PiPtyManager.buildCommandArgs} must NEVER omit, checked by
 * {@link assertPiRequiredSpawnFlags} right before the argv is returned.
 *
 * `--no-extensions`/`--no-skills` are the discovery-lockdown pair (the same
 * invariant OMP's PTY lane enforces): pi auto-discovers project-local
 * `.pi/extensions` and skills, which are arbitrary TypeScript executing at
 * startup before any gate exists. pi has NO approval-mode flag and NO built-in
 * sandbox (docs/security.md is explicit about both), so unlike OMP there is no
 * `--approval-mode` to pin — the interactive TUI IS the observation surface
 * for this lane. cyboflow's PermissionMode is deliberately NOT mapped onto
 * `--tools` allowlists here: a blanket list would silently widen or narrow the
 * trust boundary per mode without a producer-side gate to enforce it. If a
 * mode mapping is ever added it must go through an extension-based `tool_call`
 * bridge like the SDK lane's.
 */
const PI_REQUIRED_SPAWN_FLAGS = ['--no-extensions', '--no-skills'] as const;

/**
 * Throws if `args` is missing any of {@link PI_REQUIRED_SPAWN_FLAGS}. Exported
 * so the security invariant can be unit-tested directly, independent of
 * `buildCommandArgs`'s own call site — a subclass override that REPLACES
 * `buildCommandArgs` would otherwise bypass the inline call and prove nothing.
 */
export function assertPiRequiredSpawnFlags(args: readonly string[]): void {
  const missing = PI_REQUIRED_SPAWN_FLAGS.filter((flag) => !args.includes(flag));
  if (missing.length > 0) {
    throw new Error(
      `[PI] refusing to spawn: buildCommandArgs dropped required flag(s) ${missing.join(', ')}. Discovery lockdown (--no-extensions --no-skills) is a security invariant — a refactor must not silently ship without them.`,
    );
  }
}

export class PiPtyManager extends AbstractCliManager {
  private resolvedExecutablePath: string | null = null;
  private readonly panelRunIds = new Map<string, string>();
  private readonly ptyBacklog = new Map<string, string>();
  private readonly ptySpawnContext = new AsyncLocalStorage<PiPtySpawnContext>();

  protected getCliToolName(): string {
    return 'Pi';
  }

  /** Vendor for the provider-access guard (Settings → Integrations). */
  protected getAgentProvider(): AgentProvider {
    return 'pi';
  }

  /**
   * Resolve the pi CLI: explicit custom path first, else
   * `findExecutableInPath('pi')`. No bundled-binary rung — v1 spawns the USER's
   * install (`@earendil-works/pi-coding-agent`), same shape as OMP. The version
   * probe applies the floor+tested policy from `piVersions.ts`.
   */
  protected async testCliAvailability(customPath?: string): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    const configuredPath = customPath?.trim();

    getShellPath();
    const resolvedPath = configuredPath || findExecutableInPath('pi');
    if (!resolvedPath) {
      this.resolvedExecutablePath = null;
      return { available: false, error: 'pi executable not found in PATH' };
    }

    try {
      const probe = await this.probeVersion(resolvedPath);
      if (probe.usedNodeFallback) {
        this.markNeedsNodeFallback();
      }

      const verdict = evaluatePiVersionPolicy(probe.version);
      if (!verdict.ok) {
        this.resolvedExecutablePath = null;
        const reason =
          verdict.reason === 'below-floor'
            ? `pi ${probe.version} is older than the minimum supported version ${PI_MIN_SUPPORTED_VERSION}`
            : `could not parse pi version output "${probe.version}"`;
        return { available: false, error: reason, version: probe.version, path: resolvedPath };
      }
      if (verdict.aboveTested) {
        this.logger?.warn(
          `[PI] detected version ${probe.version} is newer than the last version this integration was tested against (${PI_TESTED_VERSION}); proceeding, but behavior beyond the tested version is unverified.`,
        );
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

  /** Probe `--version` with the SAME environment the spawn will use. */
  protected async probeVersion(executablePath: string): Promise<CliVersionProbeResult> {
    return probeCliVersion(executablePath, await this.getSystemEnvironment());
  }

  protected async getCliExecutablePath(): Promise<string> {
    if (this.resolvedExecutablePath) {
      return this.resolvedExecutablePath;
    }
    const availability = await this.testCliAvailability();
    if (!availability.available || !availability.path) {
      throw new Error(`Pi CLI not available: ${availability.error ?? 'unknown error'}`);
    }
    return availability.path;
  }

  /**
   * The PTY argv: `--no-extensions --no-skills [--model <selection>]
   * [--continue] [-- <prompt>]`.
   *
   * No `--thinking` flag: effort is unsupported on this lane
   * (RUNTIME_CAPABILITIES carries false for both pi runtimes — same
   * stored-but-dropped reasoning as codex-pty). `options.model` passes through
   * VERBATIM: pi takes `provider/id` patterns natively and Cyboflow persists Pi
   * selections in exactly that canonical form.
   *
   * {@link assertPiRequiredSpawnFlags} runs on every call, right before
   * returning — the discovery-lockdown invariant as a spawn-time assertion.
   */
  protected buildCommandArgs(options: PiPtySpawnOptions): string[] {
    const args: string[] = [];
    args.push('--no-extensions', '--no-skills');

    if (options.model && options.model.trim().length > 0) {
      args.push('--model', options.model);
    }

    if (options.isContinue) {
      args.push('--continue');
    }

    // pi's parser has NO `--` terminator (verified live: 'Unknown option:
    // --'), so a dash-leading prompt would parse as flags. A single leading
    // space is the parser-safe encoding — content otherwise verbatim.
    const prompt =
      options.prompt.startsWith('-') ? ` ${options.prompt}` : options.prompt;
    if (prompt.trim().length > 0) {
      args.push(prompt);
    }

    assertPiRequiredSpawnFlags(args);
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

  protected async initializeCliEnvironment(_options: PiPtySpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async getCliEnvironment(_options: PiPtySpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async cleanupCliResources(sessionId: string): Promise<void> {
    for (const [panelId, process] of this.processes.entries()) {
      if (process.sessionId !== sessionId) continue;
      const runId = this.panelRunIds.get(panelId);
      this.panelRunIds.delete(panelId);
      if (runId) {
        this.ptyBacklog.delete(runId);
      }
    }
  }

  override async spawnCliProcess(options: PiPtySpawnOptions): Promise<void> {
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
        data: `\r\n\x1b[31mPi failed to start: ${message}\x1b[0m\r\n`,
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
    });
  }

  /**
   * Respawn with `--continue`, scoped to `worktreePath` as the pi process cwd.
   * A REAL resume, like OMP's: pi persists sessions per-project and
   * `--continue` picks up that worktree's most-recent session, so prior turns
   * are genuinely still there for the model.
   */
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
    await this.spawnCliProcess({
      panelId,
      sessionId,
      worktreePath,
      prompt,
      permissionMode,
      agentPermissionMode: this.resolveSessionAgentPermissionMode(sessionId, permissionMode),
      model,
      isContinue: true,
    });
  }

  relayUserTurn(panelId: string, input: string): void {
    this.sendInput(panelId, `${input}\r`);
  }

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
    if (interpreterAdvice) {
      return [`Error: ${error}`, '', interpreterAdvice].join('\n');
    }
    if (error && /older than the minimum supported version/.test(error)) {
      return [
        `Error: ${error}`,
        '',
        'Pi is installed but too old for this integration. Update it with:',
        '  pi update self',
        'or:',
        '  npm install -g @earendil-works/pi-coding-agent@latest',
      ].join('\n');
    }
    return [
      `Error: ${error}`,
      '',
      'Pi CLI is not available.',
      '',
      'Install pi with:',
      '  npm install -g @earendil-works/pi-coding-agent',
      '',
      'Then verify `pi --version` works in your shell.',
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

  protected runWithPtySpawnContext<T>(context: PiPtySpawnContext, operation: () => T): T {
    return this.ptySpawnContext.run(context, operation);
  }

  protected getActivePtySpawnContext(): PiPtySpawnContext | undefined {
    return this.ptySpawnContext.getStore();
  }
}
