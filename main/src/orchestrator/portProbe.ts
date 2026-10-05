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
  /** Socket factory; defaults to dialing `<host>:<port>`. */
  connect?: (port: number, host: string) => net.Socket;
}

const DEFAULT_PROBE_TIMEOUT_MS = 500;

/**
 * Both loopbacks: a server bound to only one family is common (Vite binds
 * `localhost`, which resolves to `::1` alone on recent macOS/Node), and a probe of
 * just 127.0.0.1 would report it free.
 */
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;

function defaultConnect(port: number, host: string): net.Socket {
  return net.connect({ host, port });
}

function probeHost(
  port: number,
  host: string,
  timeoutMs: number,
  connect: (port: number, host: string) => net.Socket,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
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
      resolve(inUse);
    };

    try {
      socket = connect(port, host);
    } catch {
      finish(false);
      return;
    }

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Resolves `inUse: true` when something accepts a TCP connection on the port on
 * either loopback address, `inUse: false` when both refuse or time out. Never rejects.
 */
export async function probePort(
  port: number,
  label: string,
  opts: ProbePortOptions = {},
): Promise<PortProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const connect = opts.connect ?? defaultConnect;
  const results = await Promise.all(LOOPBACK_HOSTS.map((host) => probeHost(port, host, timeoutMs, connect)));
  return { port, label, inUse: results.some(Boolean) };
}
