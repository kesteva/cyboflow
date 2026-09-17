import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import {
  ClaudeAuthLoginService,
  parseAuthStatus,
  resolveClaudeAuthBinary,
  resolveDevBundledClaudePath,
  type ClaudeAuthLoginDependencies,
} from '../claudeAuthLogin';

/** Verbatim stdout of `claude auth login` 2.1.257 on a non-TTY (URL abbreviated). */
const AUTH_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile&code_challenge=XYZ&code_challenge_method=S256&state=STATE';
const OPENING = 'Opening browser to sign in…\n';
const VISIT = `If the browser didn't open, visit: ${AUTH_URL}\n`;
const PROMPT = 'Paste code here if prompted > ';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  written = '';
  killed: NodeJS.Signals | null = null;
  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.written += String(chunk);
    });
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? 'SIGTERM';
    return true;
  }
}

function harness(overrides: Partial<ClaudeAuthLoginDependencies> = {}) {
  const children: FakeChild[] = [];
  const spawnCalls: Array<{ bin: string; args: string[] }> = [];
  const probeStatus = vi.fn(async () => ({ loggedIn: true, email: 'me@example.com', subscriptionType: 'max' }));
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const service = new ClaudeAuthLoginService({
    resolveBinary: () => '/fake/claude',
    spawn: ((bin: string, args: string[]) => {
      spawnCalls.push({ bin, args });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    }) as unknown as ClaudeAuthLoginDependencies['spawn'],
    probeStatus,
    env: () => ({ PATH: '/usr/bin' }),
    setTimeout: ((fn: () => void, ms: number) => {
      const entry = { fn, ms, cleared: false };
      timers.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((handle: unknown) => {
      const entry = handle as { cleared: boolean } | null;
      if (entry) entry.cleared = true;
    }) as unknown as typeof clearTimeout,
    ...overrides,
  });
  return { service, children, spawnCalls, probeStatus, timers, child: () => children[children.length - 1] };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('ClaudeAuthLoginService', () => {
  it('starts idle', () => {
    const { service } = harness();
    expect(service.getState()).toEqual({ phase: 'idle', authUrl: null, error: null, account: null });
  });

  it('spawns `auth login` on the resolved binary and reports starting', () => {
    const { service, spawnCalls } = harness();
    expect(service.start().phase).toBe('starting');
    expect(spawnCalls).toEqual([{ bin: '/fake/claude', args: ['auth', 'login'] }]);
  });

  it('fails closed when no binary is available', () => {
    const { service, spawnCalls } = harness({ resolveBinary: () => null });
    const state = service.start();
    expect(state.phase).toBe('failed');
    expect(state.error).toMatch(/No Claude Code binary/);
    expect(spawnCalls).toHaveLength(0);
  });

  it('is idempotent while an attempt is live', () => {
    const { service, spawnCalls } = harness();
    service.start();
    service.start();
    expect(spawnCalls).toHaveLength(1);
  });

  it('captures the authorize URL and moves to awaiting-code, even across chunk boundaries', async () => {
    const { service, child } = harness();
    service.start();
    const [head, tail] = [VISIT.slice(0, 60), VISIT.slice(60)];
    child().stdout.write(OPENING + head);
    await flush();
    expect(service.getState().phase).toBe('starting');
    child().stdout.write(tail + PROMPT);
    await flush();
    const state = service.getState();
    expect(state.phase).toBe('awaiting-code');
    expect(state.authUrl).toBe(AUTH_URL);
  });

  it('strips the OSC 8 hyperlink wrapper and colour codes around the URL', async () => {
    const { service, child } = harness();
    service.start();
    child().stdout.write(
      `${OPENING}If the browser didn't open, visit: \x1b]8;;${AUTH_URL}\x1b\\\x1b[36m${AUTH_URL}\x1b[0m\x1b]8;;\x1b\\\n${PROMPT}\x1b[?25h`,
    );
    await flush();
    expect(service.getState().authUrl).toBe(AUTH_URL);
  });

  it('writes the submitted code to stdin once, newline-terminated, and reports verifying', async () => {
    const { service, child } = harness();
    service.start();
    child().stdout.write(OPENING + VISIT + PROMPT);
    await flush();
    const state = service.submitCode('  abc123#state  ');
    expect(state.phase).toBe('verifying');
    await flush();
    expect(child().written).toBe('abc123#state\n');
  });

  it('ignores an empty code and a code submitted before any attempt', () => {
    const { service, children } = harness();
    expect(service.submitCode('abc').phase).toBe('idle');
    service.start();
    expect(service.submitCode('   ').phase).toBe('starting');
    expect(children[0].written).toBe('');
  });

  it('succeeds on the success marker, closes stdin, and attaches the account probe', async () => {
    const { service, child, probeStatus } = harness();
    service.start();
    child().stdout.write(OPENING + VISIT + PROMPT);
    await flush();
    service.submitCode('code');
    child().stdout.write('\nLogin successful. Logged in as me@example.com\n');
    await flush();
    child().emit('exit', 0, null);
    await flush();
    await flush();
    const state = service.getState();
    expect(state.phase).toBe('succeeded');
    expect(state.account).toEqual({ loggedIn: true, email: 'me@example.com', subscriptionType: 'max' });
    expect(probeStatus).toHaveBeenCalledTimes(1);
    expect(child().stdin.writableEnded).toBe(true);
  });

  it('treats a clean exit without the marker as success too', async () => {
    const { service, child } = harness();
    service.start();
    child().emit('exit', 0, null);
    await flush();
    await flush();
    expect(service.getState().phase).toBe('succeeded');
  });

  it('fails with the stderr tail on a non-zero exit', async () => {
    const { service, child } = harness();
    service.start();
    child().stderr.write('\x1b[31mError: invalid authorization code\x1b[0m\n');
    await flush();
    child().emit('exit', 1, null);
    await flush();
    const state = service.getState();
    expect(state.phase).toBe('failed');
    expect(state.error).toBe('The sign-in did not complete (exit 1). Error: invalid authorization code');
    expect(state.account).toBeNull();
  });

  it('never surfaces the submitted code in state or errors', async () => {
    const { service, child } = harness();
    service.start();
    child().stdout.write(OPENING + VISIT + PROMPT);
    await flush();
    service.submitCode('SECRET-CODE');
    child().emit('exit', 1, null);
    await flush();
    expect(JSON.stringify(service.getState())).not.toContain('SECRET-CODE');
  });

  it('cancel kills the child, returns to idle, and orphans the child\'s late exit', async () => {
    const { service, child } = harness();
    service.start();
    const first = child();
    expect(service.cancel().phase).toBe('idle');
    expect(first.killed).toBe('SIGTERM');
    first.emit('exit', null, 'SIGTERM');
    await flush();
    expect(service.getState().phase).toBe('idle');
    // A new attempt is unaffected by the old child's stream.
    service.start();
    first.stdout.write(OPENING + VISIT + PROMPT);
    await flush();
    expect(service.getState().phase).toBe('starting');
  });

  it('times out a stalled attempt', () => {
    const { service, child, timers } = harness();
    service.start();
    expect(timers[0].ms).toBe(10 * 60_000);
    timers[0].fn();
    expect(child().killed).toBe('SIGTERM');
    const state = service.getState();
    expect(state.phase).toBe('failed');
    expect(state.error).toMatch(/timed out/);
  });

  it('a new start after a terminal state replaces it', async () => {
    const { service, child, spawnCalls } = harness();
    service.start();
    child().emit('exit', 1, null);
    await flush();
    expect(service.getState().phase).toBe('failed');
    expect(service.start().phase).toBe('starting');
    expect(spawnCalls).toHaveLength(2);
    expect(service.getState().error).toBeNull();
  });

  it('probeAccount swallows a probe failure as null', async () => {
    const { service } = harness({ probeStatus: async () => { throw new Error('no auth subcommand'); } });
    expect(await service.probeAccount()).toBeNull();
  });
});

describe('parseAuthStatus', () => {
  it('reads only the display fields', () => {
    const out = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'me@example.com',
      orgId: 'org-secret',
      subscriptionType: 'max',
    });
    expect(parseAuthStatus(out)).toEqual({ loggedIn: true, email: 'me@example.com', subscriptionType: 'max' });
  });

  it('nulls missing/empty fields and rejects non-objects', () => {
    expect(parseAuthStatus('{"loggedIn":false,"email":""}')).toEqual({ loggedIn: false, email: null, subscriptionType: null });
    expect(() => parseAuthStatus('"nope"')).toThrow();
    expect(() => parseAuthStatus('not json')).toThrow();
  });
});

describe('binary resolution', () => {
  it('prefers the bundled CLI, falls back to the configured/PATH one, else null', () => {
    const exists = (p: string) => p === '/bundled/claude' || p === '/usr/local/bin/claude';
    expect(resolveClaudeAuthBinary({ bundled: () => '/bundled/claude', fallback: () => '/usr/local/bin/claude', existsSync: exists })).toBe('/bundled/claude');
    expect(resolveClaudeAuthBinary({ bundled: () => '/missing/claude', fallback: () => '/usr/local/bin/claude', existsSync: exists })).toBe('/usr/local/bin/claude');
    expect(resolveClaudeAuthBinary({ bundled: () => undefined, fallback: () => undefined, existsSync: exists })).toBeNull();
  });

  it('resolves the dev platform package next to its package.json', () => {
    const resolver = (spec: string) => {
      expect(spec).toBe('@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json');
      return '/repo/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json';
    };
    expect(resolveDevBundledClaudePath(resolver, 'darwin', 'arm64')).toBe(
      '/repo/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    );
    expect(resolveDevBundledClaudePath(() => { throw new Error('MODULE_NOT_FOUND'); }, 'win32', 'x64')).toBeUndefined();
  });

  it('names claude.exe on Windows', () => {
    expect(resolveDevBundledClaudePath(() => 'C:\\repo\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\package.json', 'win32', 'x64'))
      .toMatch(/claude\.exe$/);
  });
});
