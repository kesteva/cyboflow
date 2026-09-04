import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Writable, Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { AgentProvider } from '../../../../../shared/types/agentRuntime';
import type { ConversationMessage } from '../../../database/models';
import type { PermissionMode } from '../../../../../shared/types/workflows';
import { isPermissionMode } from '../../../../../shared/types/workflows';
import type { CliSpawnOutcome } from '../../../../../shared/types/cliPanels';
import type { ClaudeSpawnerOptions } from '../../../orchestrator/runExecutor';
import { getShellPath, findExecutableInPath } from '../../../utils/shellPath';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { probeCliVersion, type CliVersionProbeResult } from '../cli/cliVersionProbe';
import { evaluateAgyVersionPolicy, AGY_MIN_SUPPORTED_VERSION, AGY_TESTED_VERSION } from './agyVersions';

interface AgyTurnState {
  conversationId: string | null;
  model?: string;
  effort?: string;
  agentPermissionMode?: PermissionMode;
  cwd: string;
  child: ChildProcess | null;
}

interface AgyStreamEvent {
  event: string;
  conversation_id?: string;
  init?: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: string;
    step_type?: string;
    text_delta?: string;
    duration_seconds?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    };
  };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    duration_seconds?: number;
    num_turns?: number;
    denied_actions?: unknown[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    };
  };
}

/**
 * AgySdkManager — structured Antigravity lane.
 *
 * Spawns `agy -p <prompt> --output-format stream-json [--conversation <id>]`
 * child per turn. First turn obtains conversation_id from the stream, and follow-up
 * turns resume by supplying `--conversation <id>`.
 */
export class AgySdkManager extends AbstractCliManager {
  private static readonly panelConversationIds = new Map<string, string>();
  private resolvedExecutablePath: string | null = null;
  private readonly turns = new Map<string, AgyTurnState>();
  private readonly lastResultText = new Map<string, string>();

  protected getCliToolName(): string {
    return 'Antigravity';
  }

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
        return {
          available: false,
          error:
            verdict.reason === 'below-floor'
              ? `agy ${probe.version} is older than the minimum supported version ${AGY_MIN_SUPPORTED_VERSION}`
              : `could not parse agy version output "${probe.version}"`,
          version: probe.version,
          path: resolvedPath,
        };
      }
      if (verdict.aboveTested) {
        this.logger?.warn(
          `[AGY] detected version ${probe.version} is newer than the last tested version (${AGY_TESTED_VERSION}); proceeding unverified.`,
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

  async startPanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    permissionMode?: 'approve' | 'ignore',
    model?: string,
    runId?: string,
  ): Promise<void> {
    this.turns.set(panelId, {
      conversationId: AgySdkManager.panelConversationIds.get(panelId) ?? null,
      model,
      cwd: worktreePath,
      child: null,
      agentPermissionMode: this.resolveSessionAgentPermissionMode(sessionId, permissionMode),
    });
    await this.runTurn(panelId, sessionId, worktreePath, prompt, runId);
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
    let state = this.turns.get(panelId);
    if (!state) {
      state = {
        conversationId: AgySdkManager.panelConversationIds.get(panelId) ?? null,
        cwd: worktreePath,
        child: null,
      };
      this.turns.set(panelId, state);
    }
    state.agentPermissionMode = this.resolveSessionAgentPermissionMode(sessionId, permissionMode);
    if (model && model.trim().length > 0) state.model = model;
    await this.runTurn(panelId, sessionId, worktreePath, prompt, undefined);
  }

  async stopPanel(panelId: string): Promise<void> {
    const state = this.turns.get(panelId);
    if (state?.child && !state.child.killed) {
      state.child.kill('SIGTERM');
    }
    if (state) state.child = null;
    this.lastResultText.delete(panelId);
  }

  async restartPanelWithHistory(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    initialPrompt: string,
    _conversationHistory: ConversationMessage[],
  ): Promise<void> {
    const prior = this.turns.get(panelId);
    await this.stopPanel(panelId);
    this.turns.set(panelId, {
      conversationId: null, // Fresh conversation on restart
      model: prior?.model,
      effort: prior?.effort,
      cwd: worktreePath,
      child: null,
      agentPermissionMode: prior?.agentPermissionMode ?? 'default',
    });
    await this.runTurn(panelId, sessionId, worktreePath, initialPrompt, undefined);
  }

  private async runTurn(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    runId?: string,
  ): Promise<void> {
    const state = this.turns.get(panelId);
    if (!state) throw new Error(`[AGY] no turn state for panel ${panelId}`);

    const executable = await this.getCliExecutablePath();
    const args: string[] = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--print-timeout', '0',
    ];

    if (state.conversationId) {
      args.push('--conversation', state.conversationId);
    }

    if (state.model && state.model.trim().length > 0) {
      args.push('--model', state.model.trim());
    }

    if (state.effort && state.effort.trim().length > 0) {
      args.push('--effort', state.effort.trim());
    }

    if (state.agentPermissionMode === 'dontAsk') {
      args.push('--dangerously-skip-permissions');
    } else if (state.agentPermissionMode === 'acceptEdits') {
      args.push('--mode', 'accept-edits');
    }

    const effRunId = runId ?? panelId;
    await new Promise<void>((resolve) => {
      let buffer = '';
      let sawResult = false;

      const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
        executable,
        args,
        {
          cwd: worktreePath,
          env: {
            ...process.env,
            PATH: getShellPath(),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      state.child = child;

      let settled = false;
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        state.child = null;
        if (exitCode !== 0) {
          this.emit('output', {
            panelId,
            sessionId,
            type: 'json',
            data: { type: 'system', subtype: 'result', is_error: true },
            timestamp: new Date(),
          });
        }
        this.emit('turn-end', { panelId, sessionId, runId: effRunId });
        this.emit('exit', { panelId, sessionId, exitCode, signal: null });
        resolve();
      };

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          if (this.handleEventLine(line, panelId, sessionId, state)) {
            sawResult = true;
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        this.emit('output', {
          panelId,
          sessionId,
          type: 'stderr',
          data: chunk.toString('utf8'),
          timestamp: new Date(),
        });
      });

      child.on('error', (e: Error) => {
        this.emit('output', {
          panelId,
          sessionId,
          type: 'stdout',
          data: `\r\n\x1b[31mAntigravity failed to start: ${e.message}\x1b[0m\r\n`,
          timestamp: new Date(),
        });
        finish(1);
      });

      child.on('close', (code) => {
        const rest = buffer.trim();
        buffer = '';
        if (rest && this.handleEventLine(rest, panelId, sessionId, state)) {
          sawResult = true;
        }
        if (code === 0 && !sawResult) {
          this.logger?.warn(`[AGY] turn for panel ${panelId} exited 0 without result; synthesizing result`);
          this.emit('output', {
            panelId,
            sessionId,
            type: 'json',
            data: { type: 'system', subtype: 'result', is_error: false },
            timestamp: new Date(),
          });
        }
        finish(code ?? 1);
      });
    });
  }

  private handleEventLine(
    line: string,
    panelId: string,
    sessionId: string,
    state: AgyTurnState,
  ): boolean {
    let evt: AgyStreamEvent;
    try {
      evt = JSON.parse(line) as AgyStreamEvent;
    } catch {
      return false;
    }

    if (evt.event === 'init' && evt.conversation_id) {
      state.conversationId = evt.conversation_id;
      AgySdkManager.panelConversationIds.set(panelId, evt.conversation_id);
      this.emit('output', {
        panelId,
        sessionId,
        type: 'json',
        data: {
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          external_session_id: state.conversationId,
        },
        timestamp: new Date(),
      });
      return false;
    }

    if (evt.event === 'result' && evt.result) {
      let response = evt.result.response ?? '';
      if (evt.result.conversation_id) {
        state.conversationId = evt.result.conversation_id;
        AgySdkManager.panelConversationIds.set(panelId, evt.result.conversation_id);
      }
      const hasDeniedActions =
        Array.isArray(evt.result.denied_actions) && evt.result.denied_actions.length > 0;
      if (hasDeniedActions && !response.trim()) {
        response = '[Antigravity] Action was denied by permission policy.';
      }
      this.lastResultText.set(panelId, response);

      if (response.length > 0) {
        this.emit('output', {
          panelId,
          sessionId,
          type: 'json',
          data: {
            type: 'assistant',
            message: {
              id: `agy-${randomUUID()}`,
              model: state.model ?? 'agy',
              role: 'assistant',
              content: [{ type: 'text', text: response }],
            },
            session_id: sessionId,
            external_session_id: state.conversationId,
          },
          timestamp: new Date(),
        });
      }

      const isError =
        evt.result.status !== 'SUCCESS' ||
        (hasDeniedActions && !evt.result.response?.trim());
      this.emit('output', {
        panelId,
        sessionId,
        type: 'json',
        data: {
          type: 'system',
          subtype: 'result',
          is_error: isError,
          session_id: sessionId,
          external_session_id: state.conversationId,
        },
        timestamp: new Date(),
      });
      return true;
    }

    return false;
  }

  override async spawnCliProcess(options: ClaudeSpawnerOptions): Promise<CliSpawnOutcome> {
    this.assertProviderEnabled(options);
    const panelId = options.spawnKey ?? options.panelId;
    const sessionId = options.sessionId ?? panelId;
    let state = this.turns.get(panelId);
    if (!state) {
      state = {
        conversationId:
          options.resumeSessionId ??
          AgySdkManager.panelConversationIds.get(panelId) ??
          null,
        model: typeof options.model === 'string' ? options.model : undefined,
        effort: typeof options.reasoningEffort === 'string' ? options.reasoningEffort : undefined,
        cwd: options.worktreePath ?? process.cwd(),
        child: null,
        agentPermissionMode: 'default',
      };
      this.turns.set(panelId, state);
    } else {
      if (typeof options.model === 'string') state.model = options.model;
      if (typeof options.reasoningEffort === 'string') state.effort = options.reasoningEffort;
      if (options.worktreePath) state.cwd = options.worktreePath;
      if (options.resumeSessionId && !state.conversationId) {
        state.conversationId = options.resumeSessionId;
      }
    }

    const runMode = options.agentPermissionMode;
    state.agentPermissionMode = isPermissionMode(runMode) ? runMode : 'default';

    if (state.child && !state.child.killed) {
      throw new Error(`[AGY] a turn is already running for panel ${panelId}`);
    }
    await this.runTurn(panelId, sessionId, state.cwd, options.prompt ?? '', options.runId);
    const resultText = this.lastResultText.get(panelId) ?? null;
    this.lastResultText.delete(panelId);
    return { resultText };
  }

  override isPanelRunning(panelId: string): boolean {
    const child = this.turns.get(panelId)?.child;
    return child !== null && child !== undefined && !child.killed;
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

  // ── AbstractCliManager abstract members ────────────────────────────────
  protected buildCommandArgs(_options: { prompt: string; model?: string }): string[] {
    throw new Error('[AGY] sdk lane does not use buildCommandArgs; turns go through spawnCliProcess/runTurn');
  }

  protected parseCliOutput(data: string, panelId: string, sessionId: string): Array<{ panelId: string; sessionId: string; type: 'json' | 'stdout' | 'stderr'; data: unknown; timestamp: Date }> {
    return [{ panelId, sessionId, type: 'stdout', data, timestamp: new Date() }];
  }

  protected async initializeCliEnvironment(_options: unknown): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async getCliEnvironment(_options: unknown): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async cleanupCliResources(sessionId: string): Promise<void> {
    this.turns.delete(sessionId);
    this.lastResultText.delete(sessionId);
  }
}
