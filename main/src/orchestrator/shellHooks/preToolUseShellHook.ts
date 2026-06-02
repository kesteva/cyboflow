#!/usr/bin/env node
/**
 * preToolUseShellHook — the INTERACTIVE-substrate PreToolUse gate (IDEA-013 S5 /
 * TASK-810, PRIMARY body; Probe A = PASS).
 *
 * A standalone node script registered as the `.claude/settings.json`
 * `hooks.PreToolUse` `'*'` entry by interactiveSettingsWriter.ts. `claude`
 * spawns it per tool call, delivers the PreToolUse JSON on stdin, and blocks
 * the tool call on this subprocess until it exits:
 *
 *   1. Read the PreToolUse payload ({ tool_name, tool_input, ... }) from stdin.
 *   2. Read CYBOFLOW_ORCH_SOCKET + CYBOFLOW_RUN_ID from process.env. Either
 *      missing → fail closed (deny) and exit 2 (no socket to ask on).
 *   3. net.createConnection(socketPath) and write a newline-delimited
 *      {type:'shell-approval-request',requestId,runId,toolName,toolInput} — the
 *      SAME framing cyboflowMcpServer.ts uses (JSON + '\n', rolling recv buffer).
 *   4. BLOCK for the FULL human-decision window. There is NO 30s timer (the one
 *      in cyboflowMcpServer.ts:113 lives in a DIFFERENT subprocess and is not
 *      inherited). "Human is slow" (keep waiting) vs "orchestrator down" (fail
 *      closed) is distinguished by SOCKET LIVENESS ('close'/'error'), never a
 *      timer — so a multi-minute idle still yields the real verdict.
 *   5. On {permissionDecision:'allow'} → emit
 *      {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}
 *      on stdout and exit 0.
 *      On {permissionDecision:'deny'} (or any fail-closed path) → emit the deny
 *      hookSpecificOutput (with permissionDecisionReason when present) on stdout
 *      AND exit 2 to BLOCK the tool call. Probe A(e): exit 2 wins over JSON, and
 *      stderr is fed back to the model — we emit on stdout and signal via exit 2.
 *
 * AskUserQuestion is intentionally NOT special-cased: a shell PreToolUse hook
 * has no `updatedInput` channel, so QuestionRouter is never wired on this
 * substrate (native-TUI-only, Probe A2). The orchestrator handler treats an
 * AskUserQuestion shell-approval-request as a normal gate.
 *
 * Standalone-typecheck invariant: this file imports only node built-ins
 * (`net`). No 'electron', no 'better-sqlite3', no service imports.
 */
import * as net from 'net';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The PreToolUse JSON payload `claude` delivers on stdin (subset we read). */
export interface PreToolUsePayload {
  tool_name?: unknown;
  tool_input?: unknown;
}

/** The verdict written to stdout, matching the SDK hook's hookSpecificOutput. */
export interface ShellHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

/** The terminal result of one hook invocation: what to print + which code to exit. */
export interface ShellHookResult {
  output: ShellHookOutput;
  /** 0 = allow (tool proceeds); 2 = deny/fail-closed (tool blocked). */
  exitCode: 0 | 2;
}

/**
 * Minimal logger surface for connect/disconnect/skip diagnostics. Mirrors
 * orchestrator LoggerLike but is injectable so the production entry point can
 * pass a stderr-backed logger (stdout is reserved for the verdict JSON) and
 * tests can pass a spy. CLAUDE.md optional-logger rule: it is PASSED, not
 * omitted, on the production path.
 */
export interface ShellHookLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * The socket factory the hook uses to reach the orchestrator. Injectable so
 * tests can supply a stubbed `net.Socket` without a real Unix socket; the
 * production entry point defaults to `net.createConnection`.
 */
export type ShellHookConnect = (socketPath: string) => net.Socket;

export interface ShellHookOptions {
  /** Resolved CYBOFLOW_ORCH_SOCKET. */
  socketPath: string;
  /** Resolved CYBOFLOW_RUN_ID (workflow_runs.id; TASK-800). */
  runId: string;
  /** The parsed PreToolUse payload from stdin. */
  payload: PreToolUsePayload;
  /** Logger for connect/disconnect/skip diagnostics (stderr-backed in prod). */
  logger: ShellHookLogger;
  /** Socket factory (defaults to net.createConnection). */
  connect?: ShellHookConnect;
}

// ---------------------------------------------------------------------------
// Verdict shaping
// ---------------------------------------------------------------------------

/** Build the allow output (exit 0 — tool proceeds). */
function allowResult(): ShellHookResult {
  return {
    output: {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    },
    exitCode: 0,
  };
}

/** Build a deny output (exit 2 — tool blocked), with an optional reason. */
function denyResult(reason?: string): ShellHookResult {
  return {
    output: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        ...(reason ? { permissionDecisionReason: reason } : {}),
      },
    },
    exitCode: 2,
  };
}

// ---------------------------------------------------------------------------
// Core hook flow (testable in isolation)
// ---------------------------------------------------------------------------

/**
 * Run the gate against the held-open orchestrator socket and resolve with the
 * terminal verdict. NEVER rejects — every failure path resolves to a
 * fail-closed deny so the caller can deterministically print + exit.
 *
 * The promise settles on exactly one of:
 *  - an 'allow'/'deny' verdict parsed off the socket (correlated by requestId);
 *  - socket 'close'/'error' BEFORE a verdict (orchestrator-down) → fail closed.
 *
 * There is deliberately no timeout: human slowness must never deny. The fake-
 * timer test advances minutes of idle and still gets the real verdict.
 */
export function runShellHook(opts: ShellHookOptions): Promise<ShellHookResult> {
  const { socketPath, runId, payload, logger } = opts;
  const connect = opts.connect ?? ((p: string) => net.createConnection(p));

  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const toolInput =
    typeof payload.tool_input === 'object' && payload.tool_input !== null
      ? (payload.tool_input as Record<string, unknown>)
      : {};

  // A unique id so the response can be correlated on the shared socket — mirrors
  // cyboflowMcpServer.ts:110.
  const requestId = `shell-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  return new Promise<ShellHookResult>((resolve) => {
    let settled = false;
    const settle = (result: ShellHookResult): void => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        // best-effort close
      }
      resolve(result);
    };

    const socket = connect(socketPath);

    // Rolling receive buffer — a stream socket can split a JSON message across
    // 'data' events or batch them. Mirrors cyboflowMcpServer.ts:69-90.
    let recvBuffer = '';

    socket.on('connect', () => {
      logger.debug(`[Cyboflow PreToolUse hook] connected to orchestrator (run ${runId})`);
      const line =
        JSON.stringify({ type: 'shell-approval-request', requestId, runId, toolName, toolInput }) + '\n';
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
            `[Cyboflow PreToolUse hook] failed to parse orchestrator response: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
        if (msg['requestId'] !== requestId) continue;
        const data =
          typeof msg['data'] === 'object' && msg['data'] !== null
            ? (msg['data'] as Record<string, unknown>)
            : {};
        const decision = data['permissionDecision'];
        const reason =
          typeof data['permissionDecisionReason'] === 'string'
            ? (data['permissionDecisionReason'] as string)
            : undefined;
        if (decision === 'allow') {
          settle(allowResult());
        } else {
          // Anything that is not an explicit allow blocks the tool call.
          settle(denyResult(reason));
        }
        return;
      }
    });

    // Fail-closed ONLY on socket liveness — NOT a timer. The orchestrator died
    // or the connection dropped before a verdict arrived.
    socket.on('error', (err: Error) => {
      logger.error(`[Cyboflow PreToolUse hook] socket error before verdict — failing closed: ${err.message}`);
      settle(denyResult('cyboflow orchestrator unreachable'));
    });
    socket.on('close', () => {
      logger.warn('[Cyboflow PreToolUse hook] socket closed before verdict — failing closed (deny)');
      settle(denyResult('cyboflow orchestrator connection closed before a decision'));
    });
  });
}

// ---------------------------------------------------------------------------
// stdin reader (testable)
// ---------------------------------------------------------------------------

/** Collect all of stdin and parse it as the PreToolUse JSON payload. */
export function readStdinPayload(stream: NodeJS.ReadableStream): Promise<PreToolUsePayload> {
  return new Promise<PreToolUsePayload>((resolve) => {
    let raw = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      raw += chunk;
    });
    stream.on('end', () => {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(trimmed) as PreToolUsePayload);
      } catch {
        // Malformed stdin → empty payload (the gate treats it as a normal,
        // non-allow-listed tool and routes to the human, never auto-allows).
        resolve({});
      }
    });
    stream.on('error', () => resolve({}));
  });
}

// ---------------------------------------------------------------------------
// Production entry point
// ---------------------------------------------------------------------------

/** stderr-backed logger — stdout is reserved for the verdict JSON. */
const stderrLogger: ShellHookLogger = {
  debug: (m: string) => process.stderr.write(m + '\n'),
  warn: (m: string) => process.stderr.write(m + '\n'),
  error: (m: string) => process.stderr.write(m + '\n'),
};

/**
 * Emit the verdict JSON on stdout, then exit. An allow verdict exits 0 (the tool
 * proceeds); a deny / fail-closed verdict exits 2 to BLOCK the tool call (Probe
 * A(e): exit 2 wins over the JSON, and stderr is fed back to the model).
 */
function emitAndExit(result: ShellHookResult): never {
  process.stdout.write(JSON.stringify(result.output));
  if (result.exitCode === 0) {
    process.exit(0);
  }
  process.exit(2);
}

/**
 * Drive the full stdin → socket → stdout flow for the real process. Emits the
 * verdict JSON on stdout and exits with the verdict's exit code.
 */
export async function main(): Promise<void> {
  const socketPath = process.env.CYBOFLOW_ORCH_SOCKET;
  const runId = process.env.CYBOFLOW_RUN_ID;

  if (!socketPath || !runId) {
    // No socket / no run binding → cannot ask the human. Fail closed.
    stderrLogger.error(
      `[Cyboflow PreToolUse hook] missing env (CYBOFLOW_ORCH_SOCKET=${socketPath ?? '(unset)'}, ` +
        `CYBOFLOW_RUN_ID=${runId ?? '(unset)'}) — failing closed (deny)`,
    );
    emitAndExit(denyResult('cyboflow gating not configured'));
  }

  const payload = await readStdinPayload(process.stdin);
  const result = await runShellHook({ socketPath, runId, payload, logger: stderrLogger });
  emitAndExit(result);
}

// Run only when invoked directly (not when imported by a test).
if (require.main === module) {
  void main();
}
