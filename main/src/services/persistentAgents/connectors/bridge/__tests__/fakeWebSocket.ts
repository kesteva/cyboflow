/** Scriptable DoorbellSocket: the test plays the server side. */
import type { DoorbellSocket, DoorbellSocketFactory } from '../doorbellSocket';

export class FakeWebSocket implements DoorbellSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly headers: Record<string, string>;
  readyState = 0;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;

  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
    FakeWebSocket.instances.push(this);
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static last(): FakeWebSocket {
    const s = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!s) throw new Error('no FakeWebSocket instance');
    return s;
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      const e = new Error('InvalidAccessError');
      e.name = 'InvalidAccessError';
      throw e;
    }
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverMessage(text: string): void {
    this.onmessage?.({ data: text });
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }

  failUpgrade(): void {
    this.readyState = 3;
    this.onerror?.({});
    this.onclose?.({ code: 1006, reason: '', wasClean: false });
  }
}

export function fakeSocketFactory(): DoorbellSocketFactory {
  return (url, headers) => new FakeWebSocket(url, headers);
}
