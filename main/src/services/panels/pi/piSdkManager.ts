import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Writable, Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentProvider } from '../../../../../shared/types/agentRuntime';
import type { ConversationMessage } from '../../../database/models';
import type { PermissionMode } from '../../../../../shared/types/workflows';
import { isPermissionMode } from '../../../../../shared/types/workflows';
import type { CliSpawnOutcome } from '../../../../../shared/types/cliPanels';
import type { ClaudeSpawnerOptions } from '../../../orchestrator/runExecutor';
import { getShellPath, findExecutableInPath } from '../../../utils/shellPath';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { probeCliVersion, type CliVersionProbeResult } from '../cli/cliVersionProbe';
import { evaluatePiVersionPolicy, PI_MIN_SUPPORTED_VERSION, PI_TESTED_VERSION } from './piVersions';
import {
  PI_GATE_ENV_KEYS,
  PI_GATE_EXTENSION_SOURCE,
  piGateModeForMode,
} from './piGateExtension';
import { assertPiRequiredSpawnFlags } from './piPtyManager';

/** The gate mode stashed per turn; 'gated' is the fail-closed default. */
type PiGateModeLike = 'dontAsk' | 'gated';

interface PiSdkSpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  permissionMode?: 'approve' | 'ignore';
  agentPermissionMode?: PermissionMode;
  model?: string;
  runId?: string;
}

interface PiTurnState {
  gateMode: PiGateModeLike;
  /** The pi-side session id WE chose (`--session-id` creates-if-missing), so
   *  resume across turns is deterministic instead of most-recent-wins. */
  piSessionId: string;
  model?: string;
  cwd: string;
  child: ChildProcess | null;
}

/** Per-line JSON event from `pi --mode json` (docs/json.md, header version 3). */
interface PiJsonEvent {
  type: string;
  // message_* events carry { message }; agent_end closes the turn. Parsed
  // loosely on purpose — unknown members are ignored.
  message?: {
    id?: string;
    role?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  [key: string]: unknown;
}

/**
 * PiSdkManager — the structured pi lane. One SHORT-LIVED `pi --mode json`
 * child PER TURN (not a persistent RPC child): every turn resumes the same
 * deterministic pi session via `--session-id`, streams JSON-lines events, and
 * projects them onto the Claude-shaped wire the chat projection already
 * consumes.
 *
 * Why turn-spawn instead of an OMP-style persistent RPC for v1: pi's rpc mode
 * needs its own frame client (OMP's is ~2.4k lines); turn-spawn gets a fully
 * working workflow-launchable lane now with resume semantics that are
 * STRONGER than most-recent-wins (`--session-id` pins the exact session).
 * Documented v1 limits: no mid-turn steer (a user message queues until the
 * child exits and a follow-up turn spawns), one process start per turn, and
 * no usage persistence yet.
 */
export class PiSdkManager extends AbstractCliManager {
  private resolvedExecutablePath: string | null = null;
  private readonly turns = new Map<string, PiTurnState>();

  protected getCliToolName(): string {
    return 'Pi';
  }

  protected getAgentProvider(): AgentProvider {
    return 'pi';
  }

  /** Same ladder/policy as {@link PiPtyManager.testCliAvailability}. */
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
        return {
          available: false,
          error:
            verdict.reason === 'below-floor'
              ? `pi ${probe.version} is older than the minimum supported version ${PI_MIN_SUPPORTED_VERSION}`
              : `could not parse pi version output "${probe.version}"`,
          version: probe.version,
          path: resolvedPath,
        };
      }
      if (verdict.aboveTested) {
        this.logger?.warn(
          `[PI] detected version ${probe.version} is newer than the last tested version (${PI_TESTED_VERSION}); proceeding unverified.`,
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
    if (this.resolvedExecutablePath) return this.resolvedExecutablePath;
    const availability = await this.testCliAvailability();
    if (!availability.available || !availability.path) {
      throw new Error(`Pi CLI not available: ${availability.error ?? 'unknown error'}`);
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
    // Deterministic per-panel pi session id: `--session-id` creates it on the
    // first turn and RESUMES it on every later turn.
    this.turns.set(panelId, {
      // Pinned to `<cyboflow session>-<panel>`: BOTH halves are restart-
      // stable (tool_panels.id is a persisted PK; sessions.active_panel_id
      // carries it), so each panel gets its own pi conversation that survives
      // relaunch. Random ids made resume die whenever the in-memory map was
      // lost; bare-session pins would cross-wire two panels onto one
      // conversation.
      piSessionId: `cyboflow-${sessionId}-${panelId}`,
      model,
      cwd: worktreePath,
      child: null,
      gateMode: this.resolveGateMode(sessionId, permissionMode),
    });
    this.ensureGateFile();
    await this.runTurn(panelId, sessionId, worktreePath, prompt, runId);
  }

  /**
   * A follow-up turn. Resume is implicit — the SAME pinned `--session-id`
   * carries the full prior conversation, so `_conversationHistory` needs no
   * replay and no most-recent-wins gamble.
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
    let state = this.turns.get(panelId);
    if (!state) {
      // Post-restart path: rehydrate from the DETERMINISTIC pin instead of
      // minting a fresh id (which silently restarted the conversation).
      state = {
        piSessionId: `cyboflow-${sessionId}-${panelId}`,
        cwd: worktreePath,
        child: null,
        gateMode: 'gated',
      };
      this.turns.set(panelId, state);
    }
    state.gateMode = this.resolveGateMode(sessionId, permissionMode);
    if (model && model.trim().length > 0) state.model = model;
    await this.runTurn(panelId, sessionId, worktreePath, prompt, undefined);
  }

  async stopPanel(panelId: string): Promise<void> {
    const state = this.turns.get(panelId);
    if (state?.child && !state.child.killed) {
      state.child.kill('SIGTERM');
    }
    if (state) state.child = null;
    // DELIBERATELY keep the turns entry: the pinned piSessionId IS the
    // conversation. Deleting it here made the next continuePanel mint a fresh
    // id and silently reset the conversation after a mere cancel.
  }

  async restartPanelWithHistory(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    initialPrompt: string,
    _conversationHistory: ConversationMessage[],
  ): Promise<void> {
    // Preserve the PINNED session id across the restart: stopPanel tears the
    // turn down, but the whole point of --session-id is that the conversation
    // survives. Recreate the state before spawning so runTurn never sees a
    // missing record.
    const prior = this.turns.get(panelId);
    await this.stopPanel(panelId);
    this.turns.set(panelId, {
      // Deterministic pin survives even a lost in-memory record.
      piSessionId: prior?.piSessionId ?? `cyboflow-${sessionId}-${panelId}`,
      model: prior?.model,
      cwd: worktreePath,
      child: null,
      gateMode: prior?.gateMode ?? 'gated',
    });
    await this.runTurn(panelId, sessionId, worktreePath, initialPrompt, undefined);
  }

  /**
   * Spawn one turn and stream its projected events. Resolves when the child
   * exits; failures emit `exit` (code 1) after a red diagnostic line, never
   * throw past the lifecycle caller.
   */
  private async runTurn(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    runId?: string,
  ): Promise<void> {
    const state = this.turns.get(panelId);
    if (!state) throw new Error(`[PI] no turn state for panel ${panelId}`);

    const executable = await this.getCliExecutablePath();
    const args: string[] = [
      '--mode', 'json',
      '--session-id', state.piSessionId,
      '--no-extensions', '--no-skills',
      // The tool-call gate rides as an EXPLICIT extension: --no-extensions
      // disables DISCOVERY only, explicit -e paths still load (pi --help).
      '-e', this.ensureGateFile(),
    ];
    if (state.model && state.model.trim().length > 0) {
      args.push('--model', state.model);
    }
    // The PROMPT travels on STDIN, not argv: pi's parser rejects a bare `--`
    // separator (verified live) and would read a dash-leading prompt as
    // flags — including ones that re-enable discovery. Stdin is the
    // non-injectable channel.
    args.push('--print');

    // Same spawn-time invariant as the PTY lane, asserted on THIS argv too:
    // the lockdown pair survives every future edit to this builder.
    assertPiRequiredSpawnFlags(args);

    const effRunId = runId ?? panelId;
    await new Promise<void>((resolve) => {
      let buffer = '';
      let sawAgentEnd = false;
      // stdin must be a PIPE (the prompt rides it); typing the tuple gives a
      // non-null `stdin` instead of the `Writable | null` default.
      const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
        executable,
        args,
        {
          cwd: worktreePath,
          env: {
            ...process.env,
            PATH: getShellPath(),
            [PI_GATE_ENV_KEYS.mode]: state.gateMode,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      state.child = child;
      child.stdin.write(prompt);
      child.stdin.end();

      let settled = false;
      const finish = (exitCode: number) => {
        if (settled) return; // 'error' + 'close' both fire; settle once.
        settled = true;
        state.child = null;
        if (exitCode !== 0) {
          // A failed turn must still REST the session: emit the same
          // system/result envelope the quick-session rest path listens for,
          // flagged as an error, so nothing strands in 'running'.
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
          if (this.handleEventLine(line, panelId, sessionId)) sawAgentEnd = true;
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // Auth/provider notices print here; surface as stderr output so the
        // Output view shows WHY a turn produced nothing.
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
          data: `\r\n\x1b[31mPi failed to start: ${e.message}\x1b[0m\r\n`,
          timestamp: new Date(),
        });
        finish(1);
      });
      child.on('close', (code) => {
        // pi's final line may lack a trailing newline — flush the remainder
        // through the projector BEFORE deciding how the turn ended.
        const rest = buffer.trim();
        buffer = '';
        if (rest && this.handleEventLine(rest, panelId, sessionId)) sawAgentEnd = true;
        if (code === 0 && !sawAgentEnd) {
          // Clean exit without agent_end still has to REST the session.
          this.logger?.warn(`[PI] turn for panel ${panelId} exited 0 without agent_end; synthesizing result`);
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

  /**
   * Project one JSON-lines event onto the Claude-shaped wire:
   * - `message_end`(assistant) → `{type:'assistant', message:{content:[…]}}`
   * - `agent_end`              → the `{type:'system', subtype:'result'}`
   *   envelope the quick-session rest path listens for.
   * Deltas (`message_update`) are intentionally dropped: projection is
   * end-of-message, matching how codex-sdk emits whole messages. Returns true
   * when the event closed the turn.
   */
  private handleEventLine(line: string, panelId: string, sessionId: string): boolean {
    let evt: PiJsonEvent;
    try {
      evt = JSON.parse(line) as PiJsonEvent;
    } catch {
      // Not JSON (banner/noise) — ignore rather than guess.
      return false;
    }

    if (evt.type === 'message_end' && evt.message?.role === 'assistant') {
      const text = (evt.message.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
      if (text.length === 0) return false;
      this.lastResultText.set(panelId, text);
      this.emit('output', {
        panelId,
        sessionId,
        type: 'json',
        data: {
          type: 'assistant',
          message: {
            id: evt.message.id ?? `pi-${randomUUID()}`,
            model: 'pi',
            role: 'assistant',
            content: [{ type: 'text', text }],
          },
          session_id: sessionId,
        },
        timestamp: new Date(),
      });
      return false;
    }

    if (evt.type === 'agent_end') {
      this.emit('output', {
        panelId,
        sessionId,
        type: 'json',
        data: { type: 'system', subtype: 'result', is_error: false },
        timestamp: new Date(),
      });
      return true;
    }
    return false;
  }

  /**
   * The RunExecutor/workflow entry point. Mirrors startPanel but honors the
   * spawner options' runId/spawnKey and returns the turn's final assistant
   * text as the step-output channel (null when the turn produced none).
   */
  override async spawnCliProcess(options: ClaudeSpawnerOptions): Promise<CliSpawnOutcome> {
    this.assertProviderEnabled(options);
    const panelId = options.spawnKey ?? options.panelId;
    const sessionId = options.sessionId ?? panelId;
    let state = this.turns.get(panelId);
    if (!state) {
      state = {
        piSessionId: `cyboflow-${sessionId}-${panelId}`,
        model: typeof options.model === 'string' ? options.model : undefined,
        cwd: options.worktreePath ?? process.cwd(),
        child: null,
        gateMode: 'gated',
      };
      this.turns.set(panelId, state);
    } else {
      // Workflow re-runs against an existing panel must pick up CHANGED
      // model/worktree/permission values, not ride stale first-turn ones.
      if (typeof options.model === 'string') state.model = options.model;
      if (options.worktreePath) state.cwd = options.worktreePath;
    }
    // The run's permission_mode_snapshot is authoritative per turn: an
    // explicit dontAsk unlocks the yolo policy, anything else stays gated.
    const runMode = options.agentPermissionMode;
    state.gateMode = piGateModeForMode(
      isPermissionMode(runMode) ? runMode : 'default',
    );
    if (state.child && !state.child.killed) {
      throw new Error(`[PI] a turn is already running for panel ${panelId}`);
    }
    await this.runTurn(panelId, sessionId, state.cwd, options.prompt ?? '', options.runId);
    return { resultText: this.lastResultText.get(panelId) ?? null };
  }

  /** Final assistant text of the most recent turn, for {@link CliSpawnOutcome}. */
  private readonly lastResultText = new Map<string, string>();

  /** A panel is running while its pinned-session turn child is alive. */
  override isPanelRunning(panelId: string): boolean {
    const child = this.turns.get(panelId)?.child;
    return child !== null && child !== undefined && !child.killed;
  }


  // ── AbstractCliManager abstract members ────────────────────────────────
  // The turn-spawn lane never drives the PTY argv machinery, but the base
  // class declares these abstract. Kept as honest no-ops so a future
  // persistent-rpc upgrade can repurpose them instead of fighting them.

  protected buildCommandArgs(_options: { prompt: string; model?: string }): string[] {
    // FAIL CLOSED: this lane's argv is built inside runTurn (json mode +
    // pinned session + lockdown pair). Reaching this base-class hook means a
    // PTY-style caller bypassed spawnCliProcess — refuse rather than launch a
    // bare interactive pi with extensions enabled.
    throw new Error(
      '[PI] sdk lane does not use buildCommandArgs; turns must go through spawnCliProcess/runTurn (which pin --session-id and the discovery-lockdown flags).',
    );
  }

  protected parseCliOutput(data: string, panelId: string, sessionId: string): Array<{ panelId: string; sessionId: string; type: 'json' | 'stdout' | 'stderr'; data: unknown; timestamp: Date }> {
    return [{ panelId, sessionId, type: 'stdout', data, timestamp: new Date() }];
  }

  protected async initializeCliEnvironment(_options: PiSdkSpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async getCliEnvironment(_options: PiSdkSpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async cleanupCliResources(sessionId: string): Promise<void> {
    void sessionId;
  }

  /** 'dontAsk' only when the session itself recorded it; everything else gated. */
  private resolveGateMode(sessionId: string, legacyPermissionMode?: 'approve' | 'ignore'): PiGateModeLike {
    if (legacyPermissionMode === 'ignore') return 'dontAsk';
    const stored = this.sessionManager.getDbSession(sessionId)?.agent_permission_mode;
    if (isPermissionMode(stored)) return piGateModeForMode(stored);
    return this.configManager?.getDefaultAgentPermissionMode() === 'dontAsk'
      ? 'dontAsk'
      : 'gated';
  }

  private gateFilePathCached: string | null = null;

  /**
   * Write the gate extension once per manager and return its path. Idempotent:
   * rewritten only when the embedded source changes, so concurrent spawns share
   * one file and a version bump lands on the next boot.
   */
  private ensureGateFile(): string {
    if (this.gateFilePathCached) return this.gateFilePathCached;
    const dir = path.join(os.homedir(), '.cyboflow');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'pi-gate.mjs');
    fs.writeFileSync(filePath, PI_GATE_EXTENSION_SOURCE, { mode: 0o600 });
    this.gateFilePathCached = filePath;
    return filePath;
  }
}
