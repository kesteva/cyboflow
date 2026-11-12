/**
 * runSshPreflight's M2 paths (spec A6): the real sdk-binary-hash (expected toolchain + probe section), the
 * mcp-roundtrip ping through the host link, the live claude-auth check, and mode 'prelaunch' (trimmed probe,
 * link acquirable, 2 s budget). Fake transport + fake link; the ping program itself runs against a real local
 * unix socket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREFLIGHT_CHECK_IDS, type PreflightCheckId, type PreflightResult } from '../../../../../shared/types/hosts';
import type { ExecResult } from '../../../orchestrator/trpc/contracts/executionHost';
import {
  CANCELLED_DETAIL,
  CLAUDE_AUTH_PRELUDE,
  CLAUDE_AUTH_TIMEOUT_MS,
  MCP_PING_PROGRAM,
  NOT_CHECKED_BEFORE_LAUNCH_DETAIL,
  PREFLIGHT_PING_TYPE,
  PRELAUNCH_BUDGET_MS,
  PRELAUNCH_TIMEOUT_DETAIL,
  runSshPreflight,
  type PreflightOrchLink,
  type SshPreflightContext,
} from '../preflight/preflightEngine';
import {
  CLAUDE_AUTH_LIVE_PASS_DETAIL,
  LINK_UP_DETAIL,
  NEEDS_NODE_DETAIL,
  NO_ORCH_LINK_DETAIL,
  TOOLCHAIN_NOT_INSTALLED_DETAIL,
  type ExpectedToolchain,
} from '../preflight/checks';
import { SPAWN_WRAPPER } from '../remoteLaunch';
import type { SshExecOptions, SshTransportLike } from '../sshTransport';

const HASH = 'e'.repeat(64);
const ROOT = '/Users/k/cf-remote/h1';
const SOCK = `${ROOT}/s/o.sock`;
const CODEX_REL = 'codex/aarch64-apple-darwin/bin/codex';
const NODE = '/opt/homebrew/bin/node';

const BASE = [
  'home=/Users/k', 'uname_s=Darwin', 'uname_m=arm64', 'os_version=15.1', 'xcode_clt=1',
  'git_version=git version 2.39.5', `node_path=${NODE}`, 'node_version=v22.11.0',
  'claude_path=/Users/k/.local/bin/claude', 'claude_version=2.1.290', 'codex_auth=1', 'env_exists=1', 'env_mode=600',
  'env_wellformed=1', 'env_lines=1', 'sleep_value=0', 'sleep_prevented=0', 'disk_free_kb=50000000', 'user=k', 'logname=k',
  'shell=/bin/zsh', 'lang=en_US.UTF-8', 'tmpdir=/var/folders/xy/T/', 'git_path=/usr/bin/git', `remote_root=${ROOT}`,
  'sock_path_bytes=32',
];
const TC_OK = [`tc_hash=${HASH}`, 'tc_manifest=1', 'tc_manifest_hash=1', 'tc_claude_size=1000', 'tc_mcp_size=200', 'tc_codex_size=300'];
const TC_ABSENT = [`tc_hash=${HASH}`, 'tc_manifest=0'];
const out = (lines: string[]): string => [...lines, 'probe_done=1'].join('\n');

const EXPECTED: ExpectedToolchain = {
  expectedHash: HASH,
  files: [{ rel: 'claude', size: 1000 }, { rel: 'cyboflowMcpServer.js', size: 200 }, { rel: CODEX_REL, size: 300 }],
  codexIncluded: true,
  unavailableReason: null,
};

const ok = (over: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...over });

interface Routes {
  reach?: () => Promise<ExecResult>;
  ping?: (argv: readonly string[]) => Promise<ExecResult>;
  claude?: (argv: readonly string[], opts?: SshExecOptions) => Promise<ExecResult>;
  probe?: (script: string) => Promise<ExecResult>;
  tcProbe?: (script: string) => Promise<ExecResult>;
}

/** Routes exec by argv shape and runScript by script kind. */
function transport(r: Routes = {}) {
  const exec = vi.fn(async (_t: string, argv: readonly string[], opts?: SshExecOptions): Promise<ExecResult> => {
    if (argv.length === 1 && argv[0] === 'true') return r.reach ? r.reach() : ok();
    if (argv[1] === '-e') return r.ping ? r.ping(argv) : ok({ stdout: `${JSON.stringify({ requestId: argv[4], ok: true })}\n` });
    if (argv[0] === '/usr/bin/env') return r.claude ? r.claude(argv, opts) : ok({ stdout: '{"is_error":false}' });
    throw new Error(`unexpected exec ${argv.join(' ')}`);
  });
  const runScript = vi.fn(async (_t: string, script: string): Promise<ExecResult> => {
    const toolchainOnly = !script.includes('disk_free_kb') && !script.includes('node_version');
    if (toolchainOnly) return r.tcProbe ? r.tcProbe(script) : ok({ stdout: out(TC_OK) });
    return r.probe ? r.probe(script) : ok({ stdout: out([...BASE, ...(script.includes('tc_h=') ? TC_OK : [])]) });
  });
  return { exec, runScript } satisfies Pick<SshTransportLike, 'exec' | 'runScript'>;
}

function fakeLink(over: Partial<PreflightOrchLink> = {}) {
  return {
    available: vi.fn(over.available ?? (() => true)),
    acquire: vi.fn(over.acquire ?? (async () => ({ remoteSock: SOCK }))),
    release: vi.fn(over.release ?? (() => undefined)),
  };
}

function ctx(tr: ReturnType<typeof transport>, over: Partial<SshPreflightContext> = {}): SshPreflightContext {
  let t = 0;
  return {
    hostId: 'h1', sshTarget: 'box', remoteRoot: '~/cf-remote/h1', appVersion: '9.9.9', transport: tr,
    now: () => new Date(Date.UTC(2026, 9, 22, 12, 0, 0)), clock: () => (t += 5),
    toolchain: { archHint: 'arm64', expectedFor: vi.fn(async () => EXPECTED) },
    orchLink: fakeLink(),
    newRequestId: () => 'req-1',
    ...over,
  };
}

const row = (r: PreflightResult, id: PreflightCheckId) => r.results.find((c) => c.id === id);
const status = (r: PreflightResult, id: PreflightCheckId) => row(r, id)?.status;

afterEach(() => {
  vi.useRealTimers();
});

describe('full mode with the toolchain and the link', () => {
  it('a healthy installed machine detects as full with both runtimes and the toolchain hash', async () => {
    const tr = transport();
    const link = fakeLink();
    const r = await runSshPreflight(ctx(tr, { orchLink: link }), 'full');
    expect(r.results.map((c) => c.id)).toEqual([...PREFLIGHT_CHECK_IDS]);
    expect(status(r, 'sdk-binary-hash')).toBe('pass');
    expect(status(r, 'mcp-roundtrip')).toBe('pass');
    expect(row(r, 'claude-auth')).toMatchObject({ status: 'pass', detail: CLAUDE_AUTH_LIVE_PASS_DETAIL });
    expect(r).toMatchObject({
      detectedTier: 'full', toolchainHash: HASH, probeComplete: true,
      runtimes: { claudeSdk: true, codexSdk: true, claudeCli: true, codexCli: false },
    });
    // One probe (the expected hash was known from the arch hint).
    expect(tr.runScript).toHaveBeenCalledTimes(1);
    expect(tr.runScript.mock.calls[0][1]).toContain(`tc_h='${HASH}'`);
    expect(link.acquire).toHaveBeenCalledWith(ROOT);
    expect(link.release).toHaveBeenCalledTimes(1);
  });

  it('pings with the absolute probed node, the fixed program and the lease socket (data as argv only)', async () => {
    const tr = transport();
    await runSshPreflight(ctx(tr), 'full');
    const ping = tr.exec.mock.calls.find((c) => c[1][1] === '-e');
    expect(ping?.[1]).toEqual([NODE, '-e', MCP_PING_PROGRAM, SOCK, 'req-1']);
    expect(MCP_PING_PROGRAM).not.toContain(SOCK);
  });

  it('checks the sign-in by running the INSTALLED claude once under env -i + the wrapper with the env file', async () => {
    const tr = transport();
    await runSshPreflight(ctx(tr), 'full');
    const call = tr.exec.mock.calls.find((c) => c[1][0] === '/usr/bin/env');
    const argv = call?.[1] ?? [];
    expect(argv.slice(0, 3)).toEqual(['/usr/bin/env', '-i', 'HOME=/Users/k']);
    const sh = argv.indexOf('/bin/sh');
    expect(argv.slice(sh)).toEqual([
      '/bin/sh', '-c', SPAWN_WRAPPER, 'sh', ROOT, `${ROOT}/env`, '',
      `${ROOT}/toolchain/${HASH}/claude`, '-p', 'ok', '--max-turns', '1', '--output-format', 'json',
    ]);
    expect(call?.[2]).toMatchObject({ stdin: CLAUDE_AUTH_PRELUDE, timeoutMs: CLAUDE_AUTH_TIMEOUT_MS });
    expect(CLAUDE_AUTH_PRELUDE).not.toMatch(/TOKEN/);
    expect(argv).toContain('PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    // Only the wrapper's fixed line PATTERN mentions the prefix; no token value is ever on the argv.
    expect(argv.join(' ')).not.toMatch(/sk-ant-[A-Za-z0-9_-]{8}/);
  });

  it('a rejected token fails claude-auth (with the re-issue fix) without changing the tier', async () => {
    const tr = transport({ claude: async () => ok({ code: 1, stdout: '{"is_error":true,"result":"API Error: 401 authentication_error"}' }) });
    const r = await runSshPreflight(ctx(tr), 'full');
    expect(row(r, 'claude-auth')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/claude setup-token/) });
    expect(r.detectedTier).toBe('full');
  });

  it('first check (no arch hint): the expected toolchain follows the probed arch and a toolchain-only probe runs', async () => {
    const expectedFor = vi.fn(async () => EXPECTED);
    const tr = transport();
    const r = await runSshPreflight(ctx(tr, { toolchain: { archHint: null, expectedFor } }), 'full');
    expect(expectedFor).toHaveBeenCalledWith('arm64');
    expect(tr.runScript).toHaveBeenCalledTimes(2);
    expect(tr.runScript.mock.calls[0][1]).not.toContain('tc_h=');
    expect(tr.runScript.mock.calls[1][1]).toContain(`tc_h='${HASH}'`);
    expect(status(r, 'sdk-binary-hash')).toBe('pass');
  });

  it('an arch hint that no longer matches re-resolves for the probed arch', async () => {
    const expectedFor = vi.fn(async (_unameM: string) => EXPECTED);
    const tr = transport();
    await runSshPreflight(ctx(tr, { toolchain: { archHint: 'x86_64', expectedFor } }), 'full');
    expect(expectedFor.mock.calls.map((c) => c[0])).toEqual(['x86_64', 'arm64']);
    expect(tr.runScript).toHaveBeenCalledTimes(2);
  });

  it('not installed: warn with the install fix, cli tier, no live sign-in request, no toolchain hash', async () => {
    const tr = transport({ probe: async () => ok({ stdout: out([...BASE, ...TC_ABSENT]) }) });
    const r = await runSshPreflight(ctx(tr), 'full');
    expect(row(r, 'sdk-binary-hash')).toMatchObject({ status: 'warn', detail: TOOLCHAIN_NOT_INSTALLED_DETAIL });
    expect(r).toMatchObject({ detectedTier: 'cli', toolchainHash: null, runtimes: { claudeSdk: false, codexSdk: false } });
    expect(row(r, 'claude-auth')).toMatchObject({ status: 'pass', detail: 'Token present' });
    expect(tr.exec.mock.calls.some((c) => c[1][0] === '/usr/bin/env')).toBe(false);
  });

  it('a build without tools for the arch fails sdk-binary-hash with the reason', async () => {
    const none: ExpectedToolchain = { expectedHash: null, files: [], codexIncluded: false, unavailableReason: 'This build of cyboflow has no x64 tools' };
    const r = await runSshPreflight(ctx(transport(), { toolchain: { archHint: 'arm64', expectedFor: async () => none } }), 'full');
    expect(row(r, 'sdk-binary-hash')).toMatchObject({ status: 'fail', detail: 'This build of cyboflow has no x64 tools' });
    expect(r.detectedTier).toBe('cli');
  });

  it('codexSdk needs the codex tree in the toolchain AND codex signed in', async () => {
    const claudeOnly: ExpectedToolchain = { ...EXPECTED, files: EXPECTED.files.slice(0, 2), codexIncluded: false };
    const a = await runSshPreflight(ctx(transport(), { toolchain: { archHint: 'arm64', expectedFor: async () => claudeOnly } }), 'full');
    expect(a.runtimes).toMatchObject({ claudeSdk: true, codexSdk: false });
    const noAuth = transport({ probe: async () => ok({ stdout: out([...BASE.map((l) => (l === 'codex_auth=1' ? 'codex_auth=0' : l)), ...TC_OK]) }) });
    const b = await runSshPreflight(ctx(noAuth), 'full');
    expect(b.runtimes).toMatchObject({ claudeSdk: true, codexSdk: false });
  });

  it('mcp-roundtrip: skipped without node 22 or a local orch socket; fails on a link error or a wrong reply', async () => {
    const oldNode = transport({ probe: async () => ok({ stdout: out([...BASE.map((l) => (l.startsWith('node_version') ? 'node_version=v18.0.0' : l)), ...TC_OK]) }) });
    expect(row(await runSshPreflight(ctx(oldNode), 'full'), 'mcp-roundtrip')).toMatchObject({ status: 'skipped', detail: NEEDS_NODE_DETAIL });

    const noSock = fakeLink({ available: () => false });
    const r2 = await runSshPreflight(ctx(transport(), { orchLink: noSock }), 'full');
    expect(row(r2, 'mcp-roundtrip')).toMatchObject({ status: 'skipped', detail: NO_ORCH_LINK_DETAIL });
    expect(noSock.acquire).not.toHaveBeenCalled();
    expect(r2.detectedTier).toBe('cli');

    const broken = fakeLink({ acquire: async () => { throw new Error('remote port forwarding failed'); } });
    const r3 = await runSshPreflight(ctx(transport(), { orchLink: broken }), 'full');
    expect(row(r3, 'mcp-roundtrip')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/forwarding failed/) });
    expect(broken.release).not.toHaveBeenCalled();

    const link = fakeLink();
    const wrong = transport({ ping: async () => ok({ stdout: '{"requestId":"other","ok":true}\n' }) });
    const r4 = await runSshPreflight(ctx(wrong, { orchLink: link }), 'full');
    expect(status(r4, 'mcp-roundtrip')).toBe('fail');
    expect(link.release).toHaveBeenCalledTimes(1);
    expect(r4.detectedTier).toBe('cli');
  });

  it('a link-less, toolchain-less context keeps the M1 result shape', async () => {
    const r = await runSshPreflight(ctx(transport(), { toolchain: undefined, orchLink: undefined }), 'full');
    expect(status(r, 'sdk-binary-hash')).toBe('skipped');
    expect(r).toMatchObject({ detectedTier: 'cli', toolchainHash: null, runtimes: { claudeSdk: false, codexSdk: false } });
  });

  it('PREFLIGHT_PING_TYPE mirrors the socket handler constant', async () => {
    const { PREFLIGHT_PING_MESSAGE_TYPE } = await import('../../../orchestrator/mcpServer/preflightPing');
    expect(PREFLIGHT_PING_TYPE).toBe(PREFLIGHT_PING_MESSAGE_TYPE);
  }, 30_000);
});

describe('prelaunch mode', () => {
  it('trimmed probe + link acquirable; everything else skipped; no tier, no remote facts, no live sign-in', async () => {
    const tr = transport({ probe: async () => ok({ stdout: out([...BASE, ...TC_OK]) }) });
    const link = fakeLink();
    const r = await runSshPreflight(ctx(tr, { orchLink: link, prelaunchNodePath: NODE }), 'prelaunch');
    expect(r.mode).toBe('prelaunch');
    const decided = r.results.filter((c) => c.detail !== NOT_CHECKED_BEFORE_LAUNCH_DETAIL).map((c) => c.id);
    expect(decided.sort()).toEqual(['claude-auth', 'mcp-roundtrip', 'node22', 'sdk-binary-hash', 'ssh-reachable']);
    expect(row(r, 'mcp-roundtrip')).toMatchObject({ status: 'pass', detail: LINK_UP_DETAIL });
    expect(link.acquire).toHaveBeenCalledWith(ROOT);
    expect(link.release).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ detectedTier: null, probeComplete: true, toolchainHash: HASH });
    expect(r.remote).toBeUndefined();
    const script = tr.runScript.mock.calls[0][1];
    expect(script).not.toContain('disk_free_kb');
    expect(script).toContain(`'${NODE}'`);
    expect(script).toContain(`tc_h='${HASH}'`);
    expect(tr.exec.mock.calls.some((c) => c[1][0] === '/usr/bin/env' || c[1][1] === '-e')).toBe(false);
  });

  it('respects the 2 s budget: a hung connection ends as "did not answer in time" (fake timers)', async () => {
    vi.useFakeTimers();
    const tr = transport({
      reach: () => new Promise<ExecResult>(() => undefined), // never answers on its own
    });
    tr.exec.mockImplementation(async (_t: string, _argv: readonly string[], opts?: SshExecOptions) =>
      new Promise<ExecResult>((resolve) => {
        opts?.signal?.addEventListener('abort', () => resolve(ok({ code: null })), { once: true });
      }));
    const pending = runSshPreflight(ctx(tr), 'prelaunch');
    await vi.advanceTimersByTimeAsync(PRELAUNCH_BUDGET_MS - 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await pending;
    expect(r.reachable).toBe(false);
    expect(r.results.every((c) => c.status === 'skipped' && c.detail === PRELAUNCH_TIMEOUT_DETAIL)).toBe(true);
    expect(tr.exec.mock.calls[0][2]).toMatchObject({ timeoutMs: PRELAUNCH_BUDGET_MS });
  });

  it('a link that cannot come up within the budget is abandoned, and its late lease released', async () => {
    vi.useFakeTimers();
    const late: { resolve: ((v: { remoteSock: string }) => void) | null } = { resolve: null };
    const link = fakeLink({ acquire: () => new Promise((resolve) => { late.resolve = resolve; }) });
    const r = runSshPreflight(ctx(transport(), { orchLink: link }), 'prelaunch');
    await vi.advanceTimersByTimeAsync(PRELAUNCH_BUDGET_MS);
    const result = await r;
    expect(row(result, 'ssh-reachable')?.status).toBe('pass');
    expect(row(result, 'mcp-roundtrip')).toMatchObject({ status: 'skipped', detail: PRELAUNCH_TIMEOUT_DETAIL });
    expect(result.probeComplete).toBe(false);
    expect(link.release).not.toHaveBeenCalled();
    late.resolve?.({ remoteSock: SOCK });
    await vi.advanceTimersByTimeAsync(0);
    expect(link.release).toHaveBeenCalledTimes(1);
  });

  it('the caller aborting reads as Cancelled, not as a budget timeout', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runSshPreflight(ctx(transport()), 'prelaunch', undefined, ac.signal);
    expect(r.results.every((c) => c.detail === CANCELLED_DETAIL)).toBe(true);
  });

  it('the expected toolchain is resolved before the budget starts', async () => {
    vi.useFakeTimers();
    const slow: { resolve: ((e: ExpectedToolchain) => void) | null } = { resolve: null };
    const expectedFor = vi.fn(() => new Promise<ExpectedToolchain>((resolve) => { slow.resolve = resolve; }));
    const pending = runSshPreflight(ctx(transport(), { toolchain: { archHint: 'arm64', expectedFor } }), 'prelaunch');
    await vi.advanceTimersByTimeAsync(PRELAUNCH_BUDGET_MS * 3); // slow local hashing
    slow.resolve?.(EXPECTED);
    await vi.advanceTimersByTimeAsync(0);
    const r = await pending;
    expect(status(r, 'ssh-reachable')).toBe('pass');
    expect(status(r, 'sdk-binary-hash')).toBe('pass');
  });
});

describe.skipIf(process.platform === 'win32')('MCP_PING_PROGRAM against a real unix socket', () => {
  let dir: string | null = null;
  let server: net.Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const runPing = (sock: string, id: string): Promise<{ code: number | null; stdout: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, ['-e', MCP_PING_PROGRAM, sock, id], { timeout: 10_000, env: {} }, (err, stdout) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve({ code, stdout });
      });
    });

  it('sends one preflight-ping line and prints the first reply line', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cfp-'));
    const sock = join(dir, 'o.sock');
    const received: string[] = [];
    server = net.createServer((c) => {
      c.setEncoding('utf8');
      c.on('data', (d: string) => {
        received.push(d);
        const msg = JSON.parse(d.split('\n')[0]) as { type: string; requestId: string };
        c.write(`${JSON.stringify({ type: 'mcp-query-response', requestId: msg.requestId, ok: true, data: { pong: true } })}\nextra\n`);
      });
    });
    await new Promise<void>((resolve) => server?.listen(sock, () => resolve()));
    const r = await runPing(sock, 'nonce-1');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ requestId: 'nonce-1', ok: true });
    expect(received.join('')).toBe(`${JSON.stringify({ type: PREFLIGHT_PING_TYPE, requestId: 'nonce-1' })}\n`);
  }, 15_000);

  it('a missing socket exits non-zero with a short error', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cfp-'));
    const r = await runPing(join(dir, 'nope.sock'), 'n');
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/^error ENOENT/);
  }, 15_000);
});
