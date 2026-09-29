/**
 * XcodeDeviceInteractionProbe unit tests — the §B2 matrix.
 *
 * NO real toolchain runs: a FAKE {@link AppleCliExec} answers the four
 * read-only commands, and the hasher / realpath are injected. The baseline
 * answers are REAL captures from the B0 host (2026-09-24): `mcp-server status
 * --format json` (`fixtures/mcp-server-status.json`, folder path sanitised) and
 * `simctl list runtimes -j` (`fixtures/simctl-runtimes.json`, device lists
 * trimmed) — so the parser is held to the shapes Xcode 27 actually prints.
 *
 * The invariant every test also pins: the probe NEVER spawns `mcpbridge` and
 * never calls `XcodeListWorkspaces`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPROVE_XCODE_ACCESS_REMEDY,
  cfAbsoluteTimeToUnixMs,
  degradeReasonForProbe,
  parseXcodeMajor,
  XCODE_MCP_PROBE_ID,
  XcodeDeviceInteractionProbe,
  type XcodeDeviceInteractionProbeDeps,
  type XcodeMcpCheckId,
} from '../xcodeDeviceInteractionProbe';
import type { AppleCliExecResult } from '../../../orchestrator/verify/mobileSimulatorSession';

const FIXTURES = join(__dirname, 'fixtures');
const STATUS_TEXT = readFileSync(join(FIXTURES, 'mcp-server-status.json'), 'utf8');
const RUNTIMES_TEXT = readFileSync(join(FIXTURES, 'simctl-runtimes.json'), 'utf8');

const EXEC_PATH = '/Users/dev/cyboflow/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
const REAL_EXEC_PATH =
  '/Users/dev/cyboflow/node_modules/.pnpm/electron@44.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
const OUR_SHA = 'ab'.repeat(32);

/** 2026-09-24T21:00:00Z. */
const NOW = Date.UTC(2026, 8, 24, 21, 0, 0);
const MINUTE = 60_000;

/** Unix ms → the CFAbsoluteTime seconds Xcode writes into `expiration`. */
const toCf = (unixMs: number): number => unixMs / 1000 - 978_307_200;

const ok = (stdout: string): AppleCliExecResult => ({ stdout, stderr: '', code: 0 });
const fail = (code: number, stderr: string): AppleCliExecResult => ({ stdout: '', stderr, code });

type Answer = AppleCliExecResult | Error;

interface Answers {
  find?: Answer;
  xcodebuild?: Answer;
  runtimes?: Answer;
  status?: Answer;
}

function statusWith(permission: Record<string, unknown>): string {
  return JSON.stringify({ openWorkspaces: [], permission, running: false });
}

/** A grant for OUR binary, expiring at `expiresAtMs` (or durable when null). */
function ourGrant(expiresAtMs: number | null, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'AAAA-OURS',
    trust: {
      unsigned: {
        path: EXEC_PATH,
        sha256: OUR_SHA,
        ...(expiresAtMs === null ? {} : { expiration: toCf(expiresAtMs) }),
        ...overrides,
      },
    },
  };
}

function enabledWith(agents: unknown[], extra: Record<string, unknown> = {}): Answer {
  return ok(
    statusWith({ enabled: true, permittedAgents: agents, permittedFolders: [], unsafeAlwaysAllowAllAgents: false, ...extra }),
  );
}

interface Harness {
  probe: XcodeDeviceInteractionProbe;
  calls: Array<{ command: string; args: readonly string[]; timeoutMs: number | undefined }>;
  hashCalls: string[];
  clock: { now: number };
}

function harness(answers: Answers = {}, deps: Partial<XcodeDeviceInteractionProbeDeps> = {}): Harness {
  const calls: Harness['calls'] = [];
  const hashCalls: string[] = [];
  const clock = { now: NOW };
  const table: Record<string, Answer> = {
    'xcrun --find mcpbridge': answers.find ?? ok('/Applications/Xcode.app/Contents/Developer/usr/bin/mcpbridge\n'),
    'xcodebuild -version': answers.xcodebuild ?? ok('Xcode 27.0\nBuild version 27A266a\n'),
    'xcrun simctl list runtimes -j': answers.runtimes ?? ok(RUNTIMES_TEXT),
    'xcrun mcp-server status --format json':
      answers.status ?? enabledWith([ourGrant(NOW + 24 * 60 * MINUTE)]),
  };
  const probe = new XcodeDeviceInteractionProbe({
    exec: async (command, args, opts) => {
      calls.push({ command, args, timeoutMs: opts?.timeoutMs });
      const answer = table[`${command} ${args.join(' ')}`];
      if (answer === undefined) throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    execPath: EXEC_PATH,
    hashFile: async (absPath) => {
      hashCalls.push(absPath);
      return OUR_SHA.toUpperCase();
    },
    realpath: async () => REAL_EXEC_PATH,
    platform: 'darwin',
    now: () => clock.now,
    ...deps,
  });
  return { probe, calls, hashCalls, clock };
}

function check(result: Awaited<ReturnType<XcodeDeviceInteractionProbe['probe']>>, id: XcodeMcpCheckId) {
  const found = result.checks.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no ${id} check`);
  return found;
}

function assertSpawnFree(calls: Harness['calls']): void {
  for (const call of calls) {
    // `--find mcpbridge` LOCATES the binary; running it would be `xcrun mcpbridge`.
    expect(call.args[0]).not.toBe('mcpbridge');
    expect(call.command).not.toMatch(/mcpbridge$/);
    expect(call.args.join(' ')).not.toMatch(/XcodeListWorkspaces/);
  }
}

describe('the baseline: every check passes', () => {
  it('reports available with five ok checks, the grant, the runtime and the bridge path', async () => {
    const h = harness();
    const result = await h.probe.probe();
    expect(result.outcome).toBe('available');
    expect(result.checks.map((entry) => [entry.id, entry.status])).toEqual([
      ['mcpbridge', 'ok'],
      ['xcode-version', 'ok'],
      ['ios-runtime', 'ok'],
      ['headless-enabled', 'ok'],
      ['approval', 'ok'],
    ]);
    expect(result.checks.every((entry) => entry.ok && entry.remedy === null)).toBe(true);
    expect(result.approval).toBe('approved');
    expect(result.grant).toEqual({ source: 'unsigned', agentId: 'AAAA-OURS', expiresAt: NOW + 24 * 60 * MINUTE });
    expect(result.xcodeVersion).toBe('27.0');
    expect(result.iosRuntime).toBe('iOS 27.0');
    expect(check(result, 'ios-runtime').detail).toBe('iOS 27.0 (24A434)');
    expect(result.mcpbridgePath).toBe('/Applications/Xcode.app/Contents/Developer/usr/bin/mcpbridge');
    expect(result.detail).toMatch(/^Xcode 27\.0 with iOS 27\.0, headless mode on; approved for .* until 2026-09-25T21:00:00\.000Z$/);
    expect(result.checkedAt).toBe(NOW);
    expect(XCODE_MCP_PROBE_ID).toBe('xcode-mcp');
  });

  it('runs exactly the four read-only commands, each bounded, and never spawns the bridge', async () => {
    const h = harness();
    await h.probe.probe();
    expect(h.calls.map((call) => `${call.command} ${call.args.join(' ')}`).sort()).toEqual([
      'xcodebuild -version',
      'xcrun --find mcpbridge',
      'xcrun mcp-server status --format json',
      'xcrun simctl list runtimes -j',
    ]);
    expect(h.calls.every((call) => call.timeoutMs === 15_000)).toBe(true);
    assertSpawnFree(h.calls);
    expect(h.hashCalls).toEqual([EXEC_PATH]);
  });

  it('matches a grant recorded against the REAL path of a symlinked execPath', async () => {
    const h = harness({ status: enabledWith([ourGrant(null, { path: REAL_EXEC_PATH })]) });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('available');
    expect(result.grant?.expiresAt).toBeNull();
    expect(check(result, 'approval').detail).toMatch(/no expiry/);
  });
});

describe('each prerequisite failing', () => {
  it('mcpbridge missing ⇒ unavailable with the Xcode remedy', async () => {
    const h = harness({ find: fail(72, 'xcrun: error: unable to find utility "mcpbridge", not a developer tool or in PATH') });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('unavailable');
    expect(check(result, 'mcpbridge')).toMatchObject({ ok: false, status: 'failed', remedy: expect.stringMatching(/Xcode 27/) });
    expect(result.detail).toMatch(/cannot find mcpbridge/);
    expect(degradeReasonForProbe(result)).toBe('xcode-unavailable');
  });

  it('Xcode 26 ⇒ unavailable', async () => {
    const h = harness({ xcodebuild: ok('Xcode 26.2\nBuild version 17C52\n') });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('unavailable');
    expect(check(result, 'xcode-version')).toMatchObject({ status: 'failed', remedy: 'Install Xcode 27 or later' });
    expect(result.detail).toMatch(/Xcode 26\.2 is older than 27/);
  });

  it('xcodebuild exiting non-zero ⇒ unavailable', async () => {
    const h = harness({ xcodebuild: fail(1, 'xcode-select: error: tool requires Xcode') });
    expect((await h.probe.probe()).outcome).toBe('unavailable');
  });

  it('only an iOS 26 runtime (or an unavailable 27) ⇒ unavailable with the download remedy', async () => {
    const runtimes = JSON.parse(RUNTIMES_TEXT) as { runtimes: Array<Record<string, unknown>> };
    const withoutAvailable27 = {
      runtimes: runtimes.runtimes.map((entry) => (entry.version === '27.0' ? { ...entry, isAvailable: false } : entry)),
    };
    const h = harness({ runtimes: ok(JSON.stringify(withoutAvailable27)) });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('unavailable');
    expect(check(result, 'ios-runtime')).toMatchObject({
      status: 'failed',
      detail: 'no available iOS 27.0+ simulator runtime (installed: iOS 26.2)',
      remedy: '`xcodebuild -downloadPlatform iOS`',
    });
  });

  it('picks the NEWEST eligible runtime numerically', async () => {
    const h = harness({
      runtimes: ok(
        JSON.stringify({
          runtimes: [
            { platform: 'iOS', name: 'iOS 27.10', version: '27.10', isAvailable: true },
            { platform: 'iOS', name: 'iOS 27.2', version: '27.2', isAvailable: true },
            { platform: 'watchOS', name: 'watchOS 28.0', version: '28.0', isAvailable: true },
          ],
        }),
      ),
    });
    expect((await h.probe.probe()).iosRuntime).toBe('iOS 27.10');
  });

  it('headless mode off ⇒ unavailable with the enable remedy', async () => {
    const h = harness({
      status: ok(statusWith({ enabled: false, permittedAgents: [ourGrant(null)], unsafeAlwaysAllowAllAgents: false })),
    });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('unavailable');
    expect(check(result, 'headless-enabled')).toMatchObject({
      status: 'failed',
      remedy: '`sudo xcrun mcp-server enable`',
    });
    // The grant is still read and reported.
    expect(result.approval).toBe('approved');
  });

  it('an Xcode with no mcp-server tool ⇒ unavailable', async () => {
    const h = harness({ status: fail(72, 'xcrun: error: unable to find utility "mcp-server"') });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('unavailable');
    expect(check(result, 'headless-enabled').status).toBe('failed');
  });
});

describe('could-not-ask is inconclusive, never a confident no', () => {
  it('a command that rejects (timeout) ⇒ inconclusive, with the simctl first-launch hint', async () => {
    const h = harness({ runtimes: new Error('Command timed out after 15000ms') });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('inconclusive');
    expect(check(result, 'ios-runtime').status).toBe('inconclusive');
    expect(result.detail).toMatch(/runFirstLaunch/);
    expect(degradeReasonForProbe(result)).toBeNull();
  });

  it('unreadable status JSON ⇒ inconclusive for both headless and approval', async () => {
    const h = harness({ status: ok('{not json') });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('inconclusive');
    expect(check(result, 'headless-enabled').status).toBe('inconclusive');
    expect(check(result, 'approval').status).toBe('inconclusive');
    expect(result.approval).toBe('unknown');
  });

  it('a status JSON without permission.enabled ⇒ inconclusive', async () => {
    const h = harness({ status: ok(JSON.stringify({ running: false })) });
    expect((await h.probe.probe()).outcome).toBe('inconclusive');
  });

  it('a status command that exits non-zero for another reason ⇒ inconclusive', async () => {
    const h = harness({ status: fail(1, 'Xcode is busy') });
    expect((await h.probe.probe()).outcome).toBe('inconclusive');
  });

  it('an unreadable version string ⇒ inconclusive', async () => {
    const h = harness({ xcodebuild: ok('something else\n') });
    expect((await h.probe.probe()).outcome).toBe('inconclusive');
  });

  it('an affirmative approval answer still outranks an unknown prerequisite', async () => {
    const h = harness({ runtimes: new Error('timed out'), status: enabledWith([]) });
    expect((await h.probe.probe()).outcome).toBe('approval-required');
  });

  it('an affirmative prerequisite failure outranks everything', async () => {
    const h = harness({ find: fail(72, 'unable to find utility'), status: ok('{not json') });
    expect((await h.probe.probe()).outcome).toBe('unavailable');
  });
});

describe('approval', () => {
  it('the real B0 status (only a Python agent approved) ⇒ approval-required for cyboflow', async () => {
    const h = harness({ status: ok(STATUS_TEXT) });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('approval-required');
    expect(result.approval).toBe('missing');
    expect(check(result, 'approval')).toMatchObject({ status: 'failed', remedy: APPROVE_XCODE_ACCESS_REMEDY });
    // Another client's grant is never hashed against ours.
    expect(h.hashCalls).toEqual([]);
    expect(degradeReasonForProbe(result)).toBe('xcode-approval-missing');
  });

  it('the real B0 status, evaluated as the Python client it approved, is available until its expiry', async () => {
    const python =
      '/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python';
    const expiresAt = cfAbsoluteTimeToUnixMs(812061289.087738);
    const h = harness(
      { status: ok(STATUS_TEXT) },
      {
        execPath: python,
        realpath: async (target) => target,
        hashFile: async () => 'e89d60f8ccee9db684801330198797723db2ac378cd53e5cfe523128feb76599',
        now: () => expiresAt - 6 * 60 * MINUTE,
      },
    );
    const result = await h.probe.probe();
    expect(result.outcome).toBe('available');
    expect(result.grant).toEqual({ source: 'unsigned', agentId: 'FCC0C7CB-C446-46B8-93A3-D9CB349F4416', expiresAt });
  });

  it('unsafeAlwaysAllowAllAgents ⇒ available without hashing anything', async () => {
    const h = harness({ status: enabledWith([], { unsafeAlwaysAllowAllAgents: true }) });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('available');
    expect(result.grant).toEqual({ source: 'always-allow-all-agents', agentId: null, expiresAt: null });
    expect(h.hashCalls).toEqual([]);
  });

  it('a path match with a DIFFERENT sha256 ⇒ approval-required (binary changed)', async () => {
    const h = harness({ status: enabledWith([ourGrant(null, { sha256: 'cd'.repeat(32) })]) });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('approval-required');
    expect(result.approval).toBe('binary-changed');
    expect(result.detail).toMatch(/sha256 mismatch/);
  });

  it('a binary that cannot be hashed ⇒ inconclusive, not missing', async () => {
    const h = harness({}, { hashFile: async () => Promise.reject(new Error('EACCES')) });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('inconclusive');
    expect(result.approval).toBe('unknown');
  });

  describe('expiry math (CFAbsoluteTime + 978307200 = unix seconds; valid past now + 20 min + margin)', () => {
    it('converts CFAbsoluteTime exactly', () => {
      expect(cfAbsoluteTimeToUnixMs(0)).toBe(Date.UTC(2001, 0, 1));
      expect(cfAbsoluteTimeToUnixMs(812061289.087738)).toBe(1790368489088);
    });

    it('a grant ending past now + 25 min ⇒ available', async () => {
      const h = harness({ status: enabledWith([ourGrant(NOW + 25 * MINUTE + 1_000)]) });
      expect((await h.probe.probe()).outcome).toBe('available');
    });

    it('a grant ending inside now + 25 min ⇒ expiring, with the expiry in the remedy', async () => {
      const h = harness({ status: enabledWith([ourGrant(NOW + 24 * MINUTE)]) });
      const result = await h.probe.probe();
      expect(result.outcome).toBe('expiring');
      expect(result.approval).toBe('expiring');
      expect(check(result, 'approval').remedy).toContain('2026-09-24T21:24:00.000Z');
      expect(degradeReasonForProbe(result)).toBe('xcode-approval-expired');
    });

    it('the margin is configurable', async () => {
      const h = harness({ status: enabledWith([ourGrant(NOW + 24 * MINUTE)]) }, { expiryMarginMs: 0 });
      expect((await h.probe.probe()).outcome).toBe('available');
    });

    it('a grant already past ⇒ approval-required (expired)', async () => {
      const h = harness({ status: enabledWith([ourGrant(NOW - MINUTE)]) });
      const result = await h.probe.probe();
      expect(result.outcome).toBe('approval-required');
      expect(result.approval).toBe('expired');
      expect(degradeReasonForProbe(result)).toBe('xcode-approval-expired');
    });

    it('prefers a durable grant, then the latest-expiring one, among several matches', async () => {
      const h = harness({
        status: enabledWith([ourGrant(NOW - MINUTE), { ...ourGrant(NOW + 48 * 60 * MINUTE), id: 'LATER' }]),
      });
      const result = await h.probe.probe();
      expect(result.outcome).toBe('available');
      expect(result.grant?.agentId).toBe('LATER');
    });

    it('an expiration in an unreadable form ⇒ inconclusive', async () => {
      const h = harness({ status: enabledWith([ourGrant(null, { expiration: 'tomorrow' })]) });
      expect((await h.probe.probe()).outcome).toBe('inconclusive');
    });
  });

  describe('unrecognised trust shapes (signed clients are unmeasured)', () => {
    it('a non-unsigned trust with no path ⇒ inconclusive (StartSession will decide)', async () => {
      const h = harness({
        status: enabledWith([{ id: 'SIGNED', trust: { signed: { teamIdentifier: 'ABCDE12345', identifier: 'com.cyboflow.app' } } }]),
      });
      const result = await h.probe.probe();
      expect(result.outcome).toBe('inconclusive');
      expect(result.approval).toBe('unknown');
      expect(result.detail).toMatch(/does not recognise/);
      expect(degradeReasonForProbe(result)).toBeNull();
    });

    it('a non-unsigned trust naming OUR path counts', async () => {
      const h = harness({ status: enabledWith([{ id: 'SIGNED', trust: { signed: { path: EXEC_PATH } } }]) });
      const result = await h.probe.probe();
      expect(result.outcome).toBe('available');
      expect(result.grant).toEqual({ source: 'unrecognised-trust', agentId: 'SIGNED', expiresAt: null });
    });

    it('a non-unsigned trust naming ANOTHER path is still inconclusive, never a confident "not ours"', async () => {
      // A signature-keyed grant may record the bundle path or a stale install
      // path rather than our executable's. Calling it "not ours" would degrade a
      // packaged build that holds durable trust on every request (B-3).
      for (const foreign of ['/Applications/Other.app/Contents/MacOS/Other', '/Applications/Cyboflow.app']) {
        const h = harness({ status: enabledWith([{ id: 'OTHER', trust: { signed: { path: foreign } } }]) });
        const result = await h.probe.probe();
        expect(result.outcome).toBe('inconclusive');
        expect(result.approval).toBe('unknown');
        expect(degradeReasonForProbe(result)).toBeNull();
      }
    });

    it('an unsigned entry naming OUR path proves we are unsigned: signed-shape neighbours no longer blur its verdict', async () => {
      const signedNeighbours = [
        { id: 'OTHER', trust: { signed: { path: '/Applications/Other.app/Contents/MacOS/Other' } } },
        { id: 'NOPATH', trust: { signed: { teamIdentifier: 'ABCDE12345' } } },
      ];
      const expired = await harness({ status: enabledWith([...signedNeighbours, ourGrant(NOW - MINUTE)]) }).probe.probe();
      expect(expired.outcome).toBe('approval-required');
      expect(expired.approval).toBe('expired');
      const changed = await harness({
        status: enabledWith([...signedNeighbours, ourGrant(null, { sha256: 'cd'.repeat(32) })]),
      }).probe.probe();
      expect(changed.outcome).toBe('approval-required');
      expect(changed.approval).toBe('binary-changed');
      // Another client's unsigned grant proves nothing about us: still inconclusive.
      const python = JSON.parse(STATUS_TEXT) as { permission: { permittedAgents: unknown[] } };
      const theirs = await harness({
        status: enabledWith([...signedNeighbours, ...python.permission.permittedAgents]),
      }).probe.probe();
      expect(theirs.outcome).toBe('inconclusive');
    });

    it('a valid grant of ours wins over an unrecognised neighbour', async () => {
      const h = harness({
        status: enabledWith([{ id: 'SIGNED', trust: { signed: {} } }, ourGrant(null)]),
      });
      expect((await h.probe.probe()).outcome).toBe('available');
    });

    it('a malformed entry or a non-list permittedAgents ⇒ inconclusive', async () => {
      expect((await harness({ status: enabledWith(['junk']) }).probe.probe()).outcome).toBe('inconclusive');
      const notList = ok(statusWith({ enabled: true, permittedAgents: { a: 1 } }));
      expect((await harness({ status: notList }).probe.probe()).outcome).toBe('inconclusive');
    });

    it('an absent permittedAgents key means no grants', async () => {
      const h = harness({ status: ok(statusWith({ enabled: true })) });
      expect((await h.probe.probe()).approval).toBe('missing');
    });
  });

  it('surfaces pending-request ids only when a pending* key actually exists', async () => {
    const withPending = harness({
      status: enabledWith([], { pendingAgentRequests: [{ id: 'REQ-1' }, { id: 'REQ-1' }, { nope: true }] }),
    });
    expect((await withPending.probe.probe()).pendingRequestIds).toEqual(['REQ-1']);
    expect((await harness({ status: ok(STATUS_TEXT) }).probe.probe()).pendingRequestIds).toEqual([]);
  });
});

describe('caching and platform', () => {
  it('memoizes for 60 s against the injected clock, then asks again', async () => {
    const h = harness();
    await h.probe.probe();
    h.clock.now += 59_000;
    await h.probe.probe();
    expect(h.calls).toHaveLength(4);
    h.clock.now += 2_000;
    await h.probe.probe();
    expect(h.calls).toHaveLength(8);
  });

  it('shares one probe between concurrent callers', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.probe.probe(), h.probe.probe()]);
    expect(a).toBe(b);
    expect(h.calls).toHaveLength(4);
  });

  it('invalidate() drops the memo', async () => {
    const h = harness();
    await h.probe.probe();
    h.probe.invalidate();
    await h.probe.probe();
    expect(h.calls).toHaveLength(8);
  });

  it('off darwin: unavailable, and zero commands run', async () => {
    const h = harness({}, { platform: 'linux' });
    const result = await h.probe.probe();
    expect(result.outcome).toBe('unavailable');
    expect(result.detail).toMatch(/requires macOS/);
    expect(h.calls).toEqual([]);
  });

  it('never throws, even when a dependency throws synchronously', async () => {
    const h = harness(
      {},
      {
        realpath: () => {
          throw new Error('boom');
        },
      },
    );
    await expect(h.probe.probe()).resolves.toMatchObject({ outcome: expect.any(String) });
  });
});

describe('helpers', () => {
  it('parseXcodeMajor', () => {
    expect(parseXcodeMajor('Xcode 27.0\nBuild version 27A266a')).toBe(27);
    expect(parseXcodeMajor('Xcode 26.2')).toBe(26);
    expect(parseXcodeMajor('nope')).toBeNull();
  });

  it('degradeReasonForProbe maps binary-changed to approval-missing', () => {
    expect(degradeReasonForProbe({ outcome: 'approval-required', approval: 'binary-changed' })).toBe(
      'xcode-approval-missing',
    );
    expect(degradeReasonForProbe({ outcome: 'available', approval: 'approved' })).toBeNull();
  });
});
