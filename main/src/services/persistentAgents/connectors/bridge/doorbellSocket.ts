/**
 * The doorbell's socket seam. This is the ONLY file in the Bridge that touches the global WebSocket;
 * everything else takes a DoorbellSocketFactory so tests inject a scripted socket.
 */
export interface DoorbellSocket {
  /** 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. */
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null;
}

export type DoorbellSocketFactory = (url: string, headers: Record<string, string>) => DoorbellSocket;

/** Main-process global WebSocket with the non-standard `{ headers }` init. Null when absent. */
export function createNodeWebSocketFactory(): DoorbellSocketFactory | null {
  const Ctor: unknown = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof Ctor !== 'function') return null;
  type NodeWebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => DoorbellSocket;
  return (url, headers) => new (Ctor as NodeWebSocketCtor)(url, { headers });
}
