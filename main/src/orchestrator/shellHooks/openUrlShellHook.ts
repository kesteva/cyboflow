#!/usr/bin/env node
/**
 * openUrlShellHook — the `$BROWSER` of an INTERACTIVE `claude` session.
 *
 * The `claude` CLI opens URLs (an Artifact it just published, an OAuth page) by
 * spawning `$BROWSER <url>`, falling back to the OS `open`. interactiveClaudeManager
 * points `BROWSER` at this script, so the URL opens as a web-viewer tab in the
 * session instead of in the user's OS browser:
 *
 *   1. Read the URL from argv and CYBOFLOW_ORCH_SOCKET / CYBOFLOW_RUN_ID /
 *      CYBOFLOW_ORCH_TOKEN from the env the CLI passed down.
 *   2. Send one `{type:'web-open-url', requestId, runId, url, token}` line on the
 *      orchestrator socket and wait for the correlated reply.
 *   3. `ok` → exit 0. ANYTHING else — an error reply (viewer off, tab cap, a
 *      non-http URL), a missing env, a dead socket, no reply within
 *      REPLY_TIMEOUT_MS — hands the URL to the OS opener, so a link is never
 *      silently dropped. This is a convenience, not a gate: failing open to the
 *      OS browser is exactly the behaviour before the viewer existed.
 *
 * Standalone-typecheck invariant: node built-ins only (`net`, `child_process`).
 */
import * as net from 'net';
import { spawn } from 'child_process';

/** Past this the app is not answering; the OS browser is better than nothing. */
export const REPLY_TIMEOUT_MS = 5_000;

export interface OpenUrlOptions {
  socketPath: string;
  runId: string;
  token?: string;
  url: string;
  connect?: (socketPath: string) => net.Socket;
  timeoutMs?: number;
}

/**
 * Ask the app to open `url` in the viewer. Resolves true only on an `ok` reply;
 * never rejects.
 */
export function requestViewerOpen(opts: OpenUrlOptions): Promise<boolean> {
  const connect = opts.connect ?? ((p: string) => net.createConnection(p));
  const requestId = `open-url-${process.pid}-${Date.now()}`;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let socket: net.Socket | null = null;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), opts.timeoutMs ?? REPLY_TIMEOUT_MS);

    try {
      socket = connect(opts.socketPath);
    } catch {
      settle(false);
      return;
    }
    let buffer = '';
    socket.on('connect', () => {
      socket?.write(
        JSON.stringify({
          type: 'web-open-url',
          requestId,
          runId: opts.runId,
          url: opts.url,
          ...(opts.token !== undefined ? { token: opts.token } : {}),
        }) + '\n',
      );
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!raw) continue;
        try {
          const msg = JSON.parse(raw) as Record<string, unknown>;
          if (msg['requestId'] === requestId) settle(msg['ok'] === true);
        } catch {
          // Not ours / not JSON — keep reading until the timeout.
        }
      }
    });
    socket.on('error', () => settle(false));
    socket.on('close', () => settle(false));
  });
}

/** The OS opener this script stands in for. */
export function osOpenCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""'] };
  return { command: 'xdg-open', args: [] };
}

function openInOs(url: string): Promise<number> {
  const { command, args } = osOpenCommand(process.platform);
  return new Promise<number>((resolve) => {
    const child = spawn(command, [...args, url], { stdio: 'ignore', detached: true });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

export async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    process.stderr.write('[cyboflow open-url] no URL given\n');
    process.exit(1);
  }
  const socketPath = process.env.CYBOFLOW_ORCH_SOCKET;
  const runId = process.env.CYBOFLOW_RUN_ID;
  const opened =
    socketPath && runId
      ? await requestViewerOpen({ socketPath, runId, token: process.env.CYBOFLOW_ORCH_TOKEN, url })
      : false;
  process.exit(opened ? 0 : await openInOs(url));
}

// Run only when invoked directly (not when imported by a test).
if (require.main === module) {
  void main();
}
