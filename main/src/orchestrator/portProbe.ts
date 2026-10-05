/**
 * Standalone TCP connect-probe for the watched ports the System view's
 * "Ports & sockets" section reports on (AppConfig.systemWatchedPorts).
 *
 * Imports only Node's `net` — no `electron`, `better-sqlite3`, or
 * `main/src/services/*` — so the system router can import it under the
 * standalone-typecheck invariant. The `connect` seam lets tests run without
 * binding or dialing a real socket.
 */
import * as net from 'net';

export interface PortProbeResult {
  port: number;
  label: string;
  inUse: boolean;
}

export interface ProbePortOptions {
  /** Give up (and report `inUse: false`) after this many ms. Default 500. */
  timeoutMs?: number;
  /** Socket factory; defaults to dialing `127.0.0.1:<port>`. */
  connect?: (port: number) => net.Socket;
}

const DEFAULT_PROBE_TIMEOUT_MS = 500;

function defaultConnect(port: number): net.Socket {
  return net.connect({ host: '127.0.0.1', port });
}

/**
 * Resolves `inUse: true` when something accepts a TCP connection on the port,
 * `inUse: false` on a connect error or timeout. Never rejects.
 */
export function probePort(
  port: number,
  label: string,
  opts: ProbePortOptions = {},
): Promise<PortProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const connect = opts.connect ?? defaultConnect;

  return new Promise<PortProbeResult>((resolve) => {
    let settled = false;
    let socket: net.Socket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (inUse: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // best-effort teardown of a probe socket
      }
      resolve({ port, label, inUse });
    };

    try {
      socket = connect(port);
    } catch {
      finish(false);
      return;
    }

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}
