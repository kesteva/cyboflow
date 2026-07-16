#!/usr/bin/env node
/**
 * questionShellHook — the INTERACTIVE-substrate "parked on a question" signal.
 *
 * A quick PTY session that calls AskUserQuestion has no structured event the
 * main process can see (the SDK QuestionRouter/`can_use_tool` control channel
 * does not exist on the PTY transport — the question renders inline as terminal
 * text). Without a signal, a session blocked awaiting a human answer is
 * indistinguishable from one that is merely running, so it never surfaces as
 * "blocked" on the quick-session status board (quickSessionListing).
 *
 * This script closes that gap. interactiveSettingsWriter registers it as a
 * `PreToolUse` hook scoped to `matcher: 'AskUserQuestion'`, delivered inline via
 * the `--settings` flag ALONGSIDE the wildcard gate + Stop hook. `claude` runs
 * it immediately before an AskUserQuestion tool call and delivers the PreToolUse
 * payload on stdin:
 *
 *   1. Drain stdin (the PreToolUse payload; its contents are not needed — we
 *      only need the FACT that AskUserQuestion is about to run).
 *   2. Read CYBOFLOW_ORCH_SOCKET + CYBOFLOW_RUN_ID from process.env. Either
 *      missing → nothing to notify; done.
 *   3. net.createConnection(socketPath) and write a newline-delimited
 *      {type:'interactive-question-open',requestId,runId} — the same framing the
 *      Stop hook / preToolUseShellHook / cyboflowMcpServer use. mcpQueryHandler
 *      routes it to interactiveClaudeManager.notifyQuestionOpen(runId), flipping
 *      the run's board state to `blocked` until the turn ends.
 *   4. Wait for EITHER a correlated response line OR the socket closing, bounded
 *      by a hard ACK_TIMEOUT_MS.
 *
 * CRITICAL SEMANTICS — READ BEFORE TOUCHING THIS FILE: unlike the wildcard
 * PreToolUse gate (preToolUseShellHook), whose exit code is a permission verdict
 * that GATES the tool call, this hook is a pure fire-and-forget NOTIFICATION and
 * MUST NEVER gate or block AskUserQuestion. Every path (ack received, missing
 * env, connect error, timeout, malformed anything, an unexpected throw) MUST
 * exit 0 — a non-zero exit (especially 2) would deny/abort the question. Because
 * it always exits 0 with no decision output it is also safe to install in EVERY
 * permission mode (including `auto`): AskUserQuestion is never permission-gated
 * by the native classifier, so an observe-only allow cannot degrade auto-mode.
 * All diagnostics go to stderr only; stdout is left empty.
 *
 * Standalone-typecheck invariant (mirrors stopShellHook.ts): this file imports
 * only node built-ins (`net`). No 'electron', no 'better-sqlite3', no service
 * imports.
 */
import * as net from 'net';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal logger surface for connect/disconnect/timeout diagnostics (kept local; see stopShellHook.ts). */
export interface QuestionHookLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** The socket factory the hook uses to reach the orchestrator (injectable for tests). */
export type QuestionHookConnect = (socketPath: string) => net.Socket;

export interface QuestionHookOptions {
  /** Resolved CYBOFLOW_ORCH_SOCKET. */
  socketPath: string;
  /** Resolved CYBOFLOW_RUN_ID (workflow_runs.id). */
  runId: string;
  /** Logger for connect/disconnect/timeout diagnostics (stderr-backed in prod). */
  logger: QuestionHookLogger;
  /** Socket factory (defaults to net.createConnection). */
  connect?: QuestionHookConnect;
}

/**
 * Hard bound (ms) on waiting for an ack before proceeding. This notification
 * gates NOTHING — the bound exists purely so an unreachable/stalled orchestrator
 * cannot hang the CLI's PreToolUse hook. Mirrors stopShellHook.ts.
 */
const ACK_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Env resolution (testable in isolation, without touching the network)
// ---------------------------------------------------------------------------

/** The two env vars this hook needs, once both are confirmed present. */
export interface QuestionHookEnv {
  socketPath: string;
  runId: string;
}

/**
 * Resolve the socket path + runId out of a process.env-shaped object. Returns
 * null when either is missing — the caller's ONLY response to null is "skip the
 * notification," never an error or a non-zero exit.
 */
export function resolveQuestionHookEnv(env: Record<string, string | undefined>): QuestionHookEnv | null {
  const socketPath = env.CYBOFLOW_ORCH_SOCKET;
  const runId = env.CYBOFLOW_RUN_ID;
  if (!socketPath || !runId) return null;
  return { socketPath, runId };
}

// ---------------------------------------------------------------------------
// Core hook flow (testable in isolation)
// ---------------------------------------------------------------------------

/**
 * Notify the orchestrator that this run is about to park on an AskUserQuestion
 * gate, over the held-open socket. NEVER rejects and carries no meaningful
 * resolved value — every path (ack received, socket closed, socket error, or
 * the hard timeout) simply resolves once the attempt is over.
 */
export function runQuestionHook(opts: QuestionHookOptions): Promise<void> {
  const { socketPath, runId, logger } = opts;
  const connect = opts.connect ?? ((p: string) => net.createConnection(p));

  const requestId = `question-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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

    // Rolling receive buffer — mirrors stopShellHook.ts / cyboflowMcpServer.ts.
    let recvBuffer = '';

    const timer = setTimeout(() => {
      logger.warn(
        `[Cyboflow Question hook] no ack within ${ACK_TIMEOUT_MS}ms (run ${runId}) — proceeding (must never block)`,
      );
      settle();
    }, ACK_TIMEOUT_MS);

    socket.on('connect', () => {
      logger.debug(`[Cyboflow Question hook] connected to orchestrator (run ${runId})`);
      const line = JSON.stringify({ type: 'interactive-question-open', requestId, runId }) + '\n';
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
            `[Cyboflow Question hook] failed to parse orchestrator response: ${
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
      logger.warn(`[Cyboflow Question hook] socket error — proceeding: ${err.message}`);
      settle();
    });
    socket.on('close', () => {
      settle();
    });
  });
}

// ---------------------------------------------------------------------------
// stdin drain (testable) — the PreToolUse payload's contents are never read
// ---------------------------------------------------------------------------

/** Drain stdin to completion. Never rejects — an error is treated as EOF. */
export function drainStdin(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise<void>((resolve) => {
    stream.on('data', () => {
      // discarded — we only need the AskUserQuestion event to have fired
    });
    stream.on('end', () => resolve());
    stream.on('error', () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Production entry point
// ---------------------------------------------------------------------------

/** stderr-backed logger — stdout is intentionally left empty (see the header). */
const stderrLogger: QuestionHookLogger = {
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
    const env = resolveQuestionHookEnv(process.env);
    if (!env) {
      stderrLogger.debug(
        `[Cyboflow Question hook] missing env (CYBOFLOW_ORCH_SOCKET=${process.env.CYBOFLOW_ORCH_SOCKET ?? '(unset)'}, ` +
          `CYBOFLOW_RUN_ID=${process.env.CYBOFLOW_RUN_ID ?? '(unset)'}) — skipping notification`,
      );
      return;
    }
    await runQuestionHook({ socketPath: env.socketPath, runId: env.runId, logger: stderrLogger });
  } catch (err) {
    stderrLogger.error(
      `[Cyboflow Question hook] unexpected error — proceeding: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    process.exit(0);
  }
}

// Run only when invoked directly (not when imported by a test).
if (require.main === module) {
  void main();
}
