import { describe, it, expect, vi } from 'vitest';
import { PREFLIGHT_CHECK_IDS, type PreflightCheckResult } from '../../../../../shared/types/hosts';
import type { ExecResult } from '../../../orchestrator/trpc/contracts/executionHost';
import {
  CANCELLED_DETAIL,
  PREFLIGHT_ERROR_DETAIL,
  PROBE_INCOMPLETE_DETAIL,
  runSshPreflight,
  type SshPreflightContext,
} from '../preflight/preflightEngine';
import { NOT_REACHABLE_DETAIL } from '../preflight/checks';
import type { SshExecOptions, SshTransportLike } from '../sshTransport';

const HEALTHY = [
  'home=/Users/k', 'uname_s=Darwin', 'uname_m=arm64', 'os_version=15.1', 'xcode_clt=1',
  'git_version=git version 2.39.5', 'node_path=/opt/homebrew/bin/node', 'node_version=v22.11.0',
  'claude_path=/Users/k/.local/bin/claude', 'claude_version=2.1.290', 'codex_path=/opt/homebrew/bin/codex',
  'codex_version=codex-cli 0.159.2', 'codex_auth=1', 'env_exists=1', 'env_mode=600', 'env_wellformed=1',
  'env_lines=1', 'sleep_value=0', 'sleep_prevented=0', 'disk_free_kb=50000000', 'probe_done=1',
].join('\n');

const ok = (over: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...over });

type Transport = Pick<SshTransportLike, 'exec' | 'runScript'>;

function fakeTransport(over: Partial<{ exec: Transport['exec']; runScript: Transport['runScript'] }> = {}) {
  const exec = vi.fn(over.exec ?? (async () => ok()));
  const runScript = vi.fn(over.runScript ?? (async () => ok({ stdout: HEALTHY })));
  return { exec, runScript };
}

function ctx(transport: Transport, over: Partial<SshPreflightContext> = {}): SshPreflightContext {
  let t = 0;
  return {
    hostId: 'h1', sshTarget: 'box', remoteRoot: '~/cf-remote/h1', appVersion: '9.9.9', transport,
    now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0)), clock: () => (t += 5),
    ...over,
  };
}

describe('runSshPreflight', () => {
  it('healthy machine: ssh-reachable first, every check emitted in order, detects cli in M1', async () => {
    const tr = fakeTransport();
    const seen: PreflightCheckResult[] = [];
    const r = await runSshPreflight(ctx(tr), 'full', (c) => seen.push(c));
    expect(seen.map((c) => c.id)).toEqual([...PREFLIGHT_CHECK_IDS]);
    expect(r.results.map((c) => c.id)).toEqual([...PREFLIGHT_CHECK_IDS]);
    expect(r).toMatchObject({
      hostId: 'h1', mode: 'full', reachable: true, probeComplete: true, detectedTier: 'cli', arch: 'arm64', osVersion: 'macOS 15.1',
      toolchainHash: null, appVersion: '9.9.9', startedAt: '2026-10-09T12:00:00.000Z',
      runtimes: { claudeSdk: false, codexSdk: false, claudeCli: true, codexCli: true },
    });
    const byId = new Map(r.results.map((c) => [c.id, c]));
    expect(byId.get('sdk-binary-hash')?.status).toBe('skipped');
    expect(byId.get('claude-auth')?.status).toBe('pass');
    expect(r.results.every((c) => c.durationMs >= 0)).toBe(true);
    expect(tr.exec).toHaveBeenCalledWith('box', ['true'], expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(tr.runScript.mock.calls[0][1]).toContain('probe_done');
  });

  it('unreachable: classified fail, all other checks skipped, null tier, probe never runs', async () => {
    const tr = fakeTransport({ exec: async () => ok({ code: 255, stderr: 'me@box: Permission denied (publickey).' }) });
    const seen: string[] = [];
    const r = await runSshPreflight(ctx(tr), 'full', (c) => seen.push(`${c.id}:${c.status}`));
    expect(seen[0]).toBe('ssh-reachable:fail');
    expect(seen).toHaveLength(PREFLIGHT_CHECK_IDS.length);
    expect(r.reachable).toBe(false);
    expect(r.detectedTier).toBeNull();
    expect(r.results[0]).toMatchObject({ status: 'fail', fix: expect.stringMatching(/ssh-copy-id box/) });
    for (const c of r.results.slice(1)) expect(c).toMatchObject({ status: 'skipped', detail: NOT_REACHABLE_DETAIL });
    expect(tr.runScript).not.toHaveBeenCalled();
    expect(r.arch).toBeNull();
  });

  it('a timeout is classified as asleep/offline', async () => {
    const tr = fakeTransport({ exec: async () => ok({ code: null, timedOut: true }) });
    const r = await runSshPreflight(ctx(tr), 'full');
    expect(r.results[0].fix).toMatch(/asleep or offline/);
  });

  it('an already-aborted signal skips everything without touching the transport', async () => {
    const tr = fakeTransport();
    const ac = new AbortController();
    ac.abort();
    const r = await runSshPreflight(ctx(tr), 'full', undefined, ac.signal);
    expect(r.results.every((c) => c.status === 'skipped' && c.detail === CANCELLED_DETAIL)).toBe(true);
    expect(tr.exec).not.toHaveBeenCalled();
    expect(r.reachable).toBe(false);
  });

  it('aborting during the probe cancels the undecided checks', async () => {
    const ac = new AbortController();
    const tr = fakeTransport({
      runScript: async (_t: string, _s: string, opts?: SshExecOptions) => {
        expect(opts?.signal).toBe(ac.signal);
        ac.abort();
        return ok({ code: null });
      },
    });
    const r = await runSshPreflight(ctx(tr), 'full', undefined, ac.signal);
    expect(r.results[0].status).toBe('pass');
    expect(r.results.slice(1).every((c) => c.detail === CANCELLED_DETAIL)).toBe(true);
  });

  it('never throws: a transport exception becomes a fail row + a redacted seam report tagged {hostKind}', async () => {
    const captureError = vi.fn();
    const tr = fakeTransport({ exec: async () => { throw new Error('boom sk-ant-SECRET'); } });
    const r = await runSshPreflight(ctx(tr, { captureError }), 'full');
    expect(r.results[0]).toMatchObject({ id: 'ssh-reachable', status: 'fail' });
    expect(r.results[0].detail).not.toContain('SECRET');
    for (const c of r.results.slice(1)) expect(c).toMatchObject({ status: 'skipped', detail: PREFLIGHT_ERROR_DETAIL });
    expect(captureError).toHaveBeenCalledTimes(1);
    const [seam, err, tags] = captureError.mock.calls[0] as [string, Error, Record<string, string>];
    expect(seam).toBe('host-preflight');
    expect(err.message).not.toContain('SECRET');
    expect(tags).toEqual({ hostKind: 'ssh' });
    expect(r.reachable).toBe(false);
  });

  it('a probe exception fails the first probe check and keeps ssh-reachable', async () => {
    const tr = fakeTransport({ runScript: async () => { throw new Error('nope'); } });
    const r = await runSshPreflight(ctx(tr), 'full');
    expect(r.results.map((c) => c.status).slice(0, 3)).toEqual(['pass', 'fail', 'skipped']);
    expect(r.results[1].id).toBe('arch');
    expect(r.reachable).toBe(true);
    // The probe never finished: nothing about the machine was learned.
    expect(r.probeComplete).toBe(false);
    expect(r.detectedTier).toBeNull();
  });

  it('a throwing onCheck listener does not break the run', async () => {
    const r = await runSshPreflight(ctx(fakeTransport()), 'full', () => { throw new Error('listener'); });
    expect(r.results).toHaveLength(PREFLIGHT_CHECK_IDS.length);
    expect(r.reachable).toBe(true);
  });

  it('a truncated probe (no probe_done) skips every post-reach check instead of failing them', async () => {
    const tr = fakeTransport({ runScript: async () => ok({ code: null, timedOut: true, stdout: 'uname_s=Linux\n\u0000junk' }) });
    const seen: PreflightCheckResult[] = [];
    const r = await runSshPreflight(ctx(tr), 'full', (c) => seen.push(c));
    expect(r.results[0]).toMatchObject({ id: 'ssh-reachable', status: 'pass' });
    for (const c of r.results.slice(1)) expect(c).toMatchObject({ status: 'skipped', detail: PROBE_INCOMPLETE_DETAIL });
    expect(seen).toHaveLength(PREFLIGHT_CHECK_IDS.length);
    expect(r).toMatchObject({ reachable: true, probeComplete: false, detectedTier: null, arch: null, osVersion: null });
    expect(r.results.some((c) => c.status === 'fail')).toBe(false);
  });

  it('a dropped connection mid-probe (partial output, exit 255) is incomplete, not a column of fails', async () => {
    const partial = HEALTHY.split('\n').slice(0, 6).join('\n');
    const tr = fakeTransport({ runScript: async () => ok({ code: 255, stdout: partial, stderr: 'Connection reset' }) });
    const r = await runSshPreflight(ctx(tr), 'full');
    expect(r.probeComplete).toBe(false);
    expect(r.results.filter((c) => c.status === 'fail')).toEqual([]);
  });

  it('runs the probe against the configured remote root', async () => {
    const tr = fakeTransport();
    await runSshPreflight(ctx(tr, { remoteRoot: '~/cf-remote/zz' }), 'prelaunch');
    expect(tr.runScript.mock.calls[0][1]).toContain(`root="$HOME"/'cf-remote/zz'`);
  });
});
