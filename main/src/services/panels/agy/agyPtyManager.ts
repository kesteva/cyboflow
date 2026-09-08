import { AsyncLocalStorage } from 'node:async_hooks';
import type * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { AgentProvider } from '../../../../../shared/types/agentRuntime';
import type { ConversationMessage } from '../../../database/models';
import type { PermissionMode } from '../../../../../shared/types/workflows';
import { isPermissionMode } from '../../../../../shared/types/workflows';
import { getShellPath, findExecutableInPath } from '../../../utils/shellPath';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { probeCliVersion, type CliVersionProbeResult } from '../cli/cliVersionProbe';
import { evaluateAgyVersionPolicy, AGY_MIN_SUPPORTED_VERSION, AGY_TESTED_VERSION } from './agyVersions';

interface AgyPtySpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  permissionMode?: 'approve' | 'ignore';
  agentPermissionMode?: PermissionMode;
  model?: string;
  reasoningEffort?: string | null;
  runId?: string;
  isContinue?: boolean;
  [key: string]: unknown;
}

interface AgyPtySpawnContext {
  panelId: string;
  sessionId: string;
  runId: string;
}

const PTY_BACKLOG_CAP_BYTES = 200_000;

export class AgyPtyManager extends AbstractCliManager {
  private resolvedExecutablePath: string | null = null;
  private readonly panelRunIds = new Map<string, string>();
  private readonly ptyBacklog = new Map<string, string>();
  private readonly ptySpawnContext = new AsyncLocalStorage<AgyPtySpawnContext>();

  protected getCliToolName(): string {
    return 'Antigravity';
  }

  /** Vendor for the provider-access guard (Settings → Integrations). */
  protected getAgentProvider(): AgentProvider {
    return 'agy';
  }

  protected async testCliAvailability(customPath?: string): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    const configuredPath = customPath?.trim();

    getShellPath();
    const resolvedPath = configuredPath || findExecutableInPath('agy');
    if (!resolvedPath) {
      this.resolvedExecutablePath = null;
      return { available: false, error: 'agy executable not found in PATH' };
    }

    try {
      const probe = await this.probeVersion(resolvedPath);
      if (probe.usedNodeFallback) {
        this.markNeedsNodeFallback();
      }

      const verdict = evaluateAgyVersionPolicy(probe.version);
      if (!verdict.ok) {
        this.resolvedExecutablePath = null;
        const reason =
          verdict.reason === 'below-floor'
            ? `agy ${probe.version} is older than the minimum supported version ${AGY_MIN_SUPPORTED_VERSION}`
            : `could not parse agy version output "${probe.version}"`;
        return { available: false, error: reason, version: probe.version, path: resolvedPath };
      }
      if (verdict.aboveTested) {
        this.logger?.warn(
          `[AGY] detected version ${probe.version} is newer than the last version this integration was tested against (${AGY_TESTED_VERSION}); proceeding, but behavior beyond the tested version is unverified.`,
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

  protected async probeVersion(executablePath: string): Promise<CliVersionProbeResult> {
    return probeCliVersion(executablePath, await this.getSystemEnvironment());
  }

  protected async getCliExecutablePath(): Promise<string> {
    if (this.resolvedExecutablePath) {
      return this.resolvedExecutablePath;
    }
    const availability = await this.testCliAvailability();
    if (!availability.available || !availability.path) {
      throw new Error(`Antigravity CLI not available: ${availability.error ?? 'unknown error'}`);
    }
    return availability.path;
  }

  protected buildCommandArgs(options: AgyPtySpawnOptions): string[] {
    const args: string[] = [];

    if (options.model && options.model.trim().length > 0) {
      args.push('--model', options.model.trim());
    }

    if (options.reasoningEffort) {
      args.push('--effort', String(options.reasoningEffort));
    }

    if (options.agentPermissionMode === 'dontAsk') {
      args.push('--dangerously-skip-permissions');
    } else if (options.agentPermissionMode === 'acceptEdits') {
      args.push('--mode', 'accept-edits');
    }

    if (options.isContinue) {
      args.push('--continue');
    }

    const prompt = options.prompt?.trim();
    if (prompt && prompt.length > 0) {
      args.push(`-i=${prompt}`);
    } else {
      args.push('-i');
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

  protected async initializeCliEnvironment(_options: AgyPtySpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async getCliEnvironment(_options: AgyPtySpawnOptions): Promise<{ [key: string]: string }> {
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

  override async spawnCliProcess(options: AgyPtySpawnOptions): Promise<void> {
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
        data: `\r\n\x1b[31mAntigravity failed to start: ${message}\x1b[0m\r\n`,
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
        'Antigravity CLI is installed but too old for this integration. Update it with:',
        '  agy update',
      ].join('\n');
    }
    return [
      `Error: ${error}`,
      '',
      'Antigravity CLI (agy) is not available.',
      '',
      'Install agy and authenticate in your terminal, then verify `agy --version` works.',
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

  protected runWithPtySpawnContext<T>(context: AgyPtySpawnContext, operation: () => T): T {
    return this.ptySpawnContext.run(context, operation);
  }

  protected getActivePtySpawnContext(): AgyPtySpawnContext | undefined {
    return this.ptySpawnContext.getStore();
  }
}
