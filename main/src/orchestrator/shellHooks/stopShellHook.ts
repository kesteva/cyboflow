#!/usr/bin/env node
/**
 * stopShellHook — the INTERACTIVE-substrate deterministic turn-end signal
 * (IDEA-030 turn-end-detection fix).
 *
 * Quick PTY sessions detect "assistant turn ended" by tailing the CLI
 * transcript for `system/turn_duration` / `stop_hook_summary` markers
 * (transcriptNormalizer). Newer `claude` CLIs (2.1.207+) no longer reliably
 * emit those markers, so the run gets stuck at status 'running' forever and
 * the UI Merge button (disabled while running) never enables. This script is
 * registered as the `.claude/settings.json` `hooks.Stop` entry by
 * interactiveSettingsWriter.ts (ALWAYS present, unlike the PreToolUse gate —
 * see that file's permissionMode opt-out). `claude` spawns it once per
 * assistant turn and delivers the Stop payload on stdin (probe-verified on CLI
 * 2.1.207: a Stop hook supplied via `--settings` FIRES in -p mode; there is no
 * `TaskCompleted` hook event to use instead):
 *
 *   1. Drain stdin (the Stop payload; its contents are not needed — we only
 *      need the FACT that a turn ended).
 *   2. Read CYBOFLOW_ORCH_SOCKET + CYBOFLOW_RUN_ID from process.env. Either
 *      missing → nothing to notify; done.
 *   3. net.createConnection(socketPath) and write a newline-delimited
 *      {type:'interactive-turn-end',requestId,runId} — the same framing
 *      preToolUseShellHook.ts / cyboflowMcpServer.ts use.
 *   4. Wait for EITHER a correlated response line OR the socket closing,
 *      bounded by a hard ACK_TIMEOUT_MS. Unlike the PreToolUse gate (which
 *      blocks for the full human-decision window because its verdict GATES
 *      the tool call), this is a fire-and-forget notification with nothing to
 *      wait on beyond "did the write get a chance to land" — a bounded wait
 *      keeps a stalled/unreachable orchestrator from hanging the CLI's Stop
 *      hook indefinitely.
 *
 * CRITICAL SEMANTICS — READ BEFORE TOUCHING THIS FILE: a Stop hook's exit code
 * is a STOP/CONTINUE decision, not a pass/fail report. Exit 0 lets the model
 * stop; any non-zero exit (especially 2) BLOCKS the stop and forces the model
 * to keep going. This script's entire job is a best-effort side-channel
 * notification — it must NEVER influence whether the turn is allowed to end.
 * Every path (success, missing env, connect error, timeout, malformed
 * anything, an unexpected throw) MUST exit 0. There is no failure mode for
 * this script other than "the notification didn't get through," which is
 * recoverable elsewhere (the transcript-marker path, a future turn's hook
 * firing, or the user noticing and re-syncing) — it must never surface as a
 * blocked stop. All diagnostics go to stderr only; stdout is left empty.
 *
 * Standalone-typecheck invariant (mirrors preToolUseShellHook.ts): this file
 * imports only node built-ins (`net`). No 'electron', no 'better-sqlite3', no
 * service imports.
 */
import * as net from 'net';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal logger surface for connect/disconnect/timeout diagnostics. Mirrors
 * preToolUseShellHook.ts's ShellHookLogger but kept locally so this file has
 * no cross-file coupling within shellHooks/ (each hook script typechecks and
 * ships standalone). The production entry point passes a stderr-backed
 * logger (stdout is reserved — see the header); tests pass a spy.
 */
export interface StopHookLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * The socket factory the hook uses to reach the orchestrator. Injectable so
 * tests can supply a stubbed `net.Socket` without a real Unix socket; the
 * production entry point defaults to `net.createConnection`.
 */
export type StopHookConnect = (socketPath: string) => net.Socket;

export interface StopHookOptions {
  /** Resolved CYBOFLOW_ORCH_SOCKET. */
  socketPath: string;
  /** Resolved CYBOFLOW_RUN_ID (workflow_runs.id). */
  runId: string;
  /** Logger for connect/disconnect/timeout diagnostics (stderr-backed in prod). */
  logger: StopHookLogger;
  /** Socket factory (defaults to net.createConnection). */
  connect?: StopHookConnect;
}

/**
 * Hard bound (ms) on waiting for an ack before proceeding. Unlike the
 * PreToolUse gate's deliberate NO-timeout (a verdict gates the tool call, so a
 * slow human must never be treated as a deny), this notification gates
 * NOTHING — the bound exists purely so an unreachable/stalled orchestrator
 * cannot hang the CLI's Stop hook.
 */
const ACK_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Env resolution (testable in isolation, without touching the network)
// ---------------------------------------------------------------------------

/** The two env vars this hook needs, once both are confirmed present. */
export interface StopHookEnv {
  socketPath: string;
  runId: string;
}

/**
 * Resolve the socket path + runId out of a process.env-shaped object. Returns
 * null when either is missing — the caller's ONLY response to null is "skip
 * the notification," never an error or a non-zero exit.
 */
export function resolveStopHookEnv(env: Record<string, string | undefined>): StopHookEnv | null {
  const socketPath = env.CYBOFLOW_ORCH_SOCKET;
  const runId = env.CYBOFLOW_RUN_ID;
  if (!socketPath || !runId) return null;
  return { socketPath, runId };
}

// ---------------------------------------------------------------------------
// Core hook flow (testable in isolation)
// ---------------------------------------------------------------------------

/**
 * Notify the orchestrator that this run's turn ended, over the held-open
 * socket. NEVER rejects and carries no meaningful resolved value — every path
 * (ack received, socket closed, socket error, or the hard timeout) simply
 * resolves once the attempt is over.
 */
export function runStopHook(opts: StopHookOptions): Promise<void> {
  const { socketPath, runId, logger } = opts;
  const connect = opts.connect ?? ((p: string) => net.createConnection(p));

  // Mirrors preToolUseShellHook.ts's requestId generation.
  const requestId = `stop-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  return new Promise<void>((resolve) => {
    let settled = false;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.end();
      } catch {
        // best-effort close
      }
      resolve();
    };

    const socket = connect(socketPath);

    // Rolling receive buffer — mirrors preToolUseShellHook.ts / cyboflowMcpServer.ts.
    let recvBuffer = '';

    const timer = setTimeout(() => {
      logger.warn(
        `[Cyboflow Stop hook] no ack within ${ACK_TIMEOUT_MS}ms (run ${runId}) — proceeding (Stop must never block)`,
      );
      settle();
    }, ACK_TIMEOUT_MS);

    socket.on('connect', () => {
      logger.debug(`[Cyboflow Stop hook] connected to orchestrator (run ${runId})`);
      const line = JSON.stringify({ type: 'interactive-turn-end', requestId, runId }) + '\n';
      socket.write(line);
    });

    socket.on('data', (buf: Buffer) => {
      recvBuffer += buf.toString('utf8');
      let nl: number;
      while ((nl = recvBuffer.indexOf('\n')) !== -1) {
        const raw = recvBuffer.slice(0, nl).trim();
        recvBuffer = recvBuffer.slice(nl + 1);
        if (!raw) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
          logger.warn(
            `[Cyboflow Stop hook] failed to parse orchestrator response: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
        if (msg['requestId'] !== requestId) continue;
        settle();
        return;
      }
    });

    socket.on('error', (err: Error) => {
      logger.warn(`[Cyboflow Stop hook] socket error — proceeding: ${err.message}`);
      settle();
    });
    socket.on('close', () => {
      settle();
    });
  });
}

// ---------------------------------------------------------------------------
// stdin drain (testable) — the Stop payload's contents are never read
// ---------------------------------------------------------------------------

/** Drain stdin to completion. Never rejects — an error is treated as EOF. */
export function drainStdin(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise<void>((resolve) => {
    stream.on('data', () => {
      // discarded — we only need the Stop event to have fired, not its payload
    });
    stream.on('end', () => resolve());
    stream.on('error', () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Production entry point
// ---------------------------------------------------------------------------

/** stderr-backed logger — stdout is intentionally left empty (see the header). */
const stderrLogger: StopHookLogger = {
  debug: (m: string) => process.stderr.write(m + '\n'),
  warn: (m: string) => process.stderr.write(m + '\n'),
  error: (m: string) => process.stderr.write(m + '\n'),
};

/**
 * Drive the full stdin → socket flow for the real process and ALWAYS exit 0.
 * Wrapped in try/catch/finally so even an unexpected throw cannot escape as a
 * non-zero exit — see the header's CRITICAL SEMANTICS.
 */
export async function main(): Promise<void> {
  try {
    await drainStdin(process.stdin);
    const env = resolveStopHookEnv(process.env);
    if (!env) {
      stderrLogger.debug(
        `[Cyboflow Stop hook] missing env (CYBOFLOW_ORCH_SOCKET=${process.env.CYBOFLOW_ORCH_SOCKET ?? '(unset)'}, ` +
          `CYBOFLOW_RUN_ID=${process.env.CYBOFLOW_RUN_ID ?? '(unset)'}) — skipping notification`,
      );
      return;
    }
    await runStopHook({ socketPath: env.socketPath, runId: env.runId, logger: stderrLogger });
  } catch (err) {
    stderrLogger.error(
      `[Cyboflow Stop hook] unexpected error — proceeding: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    process.exit(0);
  }
}

// Run only when invoked directly (not when imported by a test).
if (require.main === module) {
  void main();
}
