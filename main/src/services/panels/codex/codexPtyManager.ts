import { execFileSync } from 'child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import type * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { ConversationMessage } from '../../../database/models';
import { getShellPath, findExecutableInPath } from '../../../utils/shellPath';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { isPermissionMode, type PermissionMode } from '../../../../../shared/types/workflows';
import { resolveAgentModelAlias } from '../agentModelContext';

interface CodexPtySpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  permissionMode?: 'approve' | 'ignore';
  agentPermissionMode?: PermissionMode;
  model?: string;
  runId?: string;
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

const PTY_BACKLOG_CAP_BYTES = 200_000;

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
  private readonly panelRunIds = new Map<string, string>();
  private readonly ptyBacklog = new Map<string, string>();
  private readonly ptySpawnContext = new AsyncLocalStorage<CodexPtySpawnContext>();

  protected getCliToolName(): string {
    return 'Codex';
  }

  protected async testCliAvailability(customPath?: string): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    getShellPath();
    const resolvedPath = customPath?.trim() || findExecutableInPath('codex');
    if (!resolvedPath) {
      this.resolvedExecutablePath = null;
      return { available: false, error: 'codex executable not found in PATH' };
    }

    try {
      const version = execFileSync(resolvedPath, ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
      }).trim();
      this.resolvedExecutablePath = resolvedPath;
      return { available: true, version, path: resolvedPath };
    } catch (err) {
      this.resolvedExecutablePath = null;
      return {
        available: false,
        error: `Failed to run "${resolvedPath} --version": ${err instanceof Error ? err.message : String(err)}`,
        path: resolvedPath,
      };
    }
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
    await this.startPanel(panelId, sessionId, worktreePath, prompt, permissionMode, model);
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
    return [
      `Error: ${error}`,
      '',
      'Codex CLI is not available.',
      '',
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
