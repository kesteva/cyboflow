/**
 * Unit tests for runAgentPreflight — the agent-path pre-deploy gate
 * (docs/proposals/verification-setup-flow.md §3.5). PURE module, no DB — every
 * probe is a hand-rolled fake implementing AgentPreflightDeps.
 *
 * Covers the applicability matrix (attach:'cdp' vs web serve vs the degenerate
 * target-only task), the fail-open rule (every probe except resolveNode
 * treats a throw as inconclusive → ok:true), the affirmative-failure cases
 * (chromium absent, driver CLI absent, a squatted port), and the aggregate
 * `ok` conjunction.
 */
import { describe, it, expect } from 'vitest';
import { runAgentPreflight } from '../preflight';
import type { AgentPreflightDeps, PreflightCheckResult } from '../preflight';
import type { VerificationTaskV1 } from '../../../../../shared/types/visualVerification';

/** A minimal valid VerificationTaskV1, overridable per test. */
function makeTask(overrides: Partial<VerificationTaskV1> = {}): VerificationTaskV1 {
  return {
    version: 1,
    summary: 'test task',
    behaviors: [],
    ...overrides,
  };
}

/** Happy-path deps: node/chromium/driver-cli all resolve, both ports free. */
function happyDeps(overrides: Partial<AgentPreflightDeps> = {}): AgentPreflightDeps {
  return {
    resolveNode: async () => '/usr/bin/node',
    resolveChromium: async () => '/opt/chromium/chrome',
    fileExists: async () => true,
    portFreeProbe: async () => true,
    ...overrides,
  };
}

function checkFor(result: { checks: PreflightCheckResult[] }, id: PreflightCheckResult['id']) {
  return result.checks.find((c) => c.id === id);
}

const ARGS = { driverCliPath: '/opt/cyboflow/driver-cli', leasedPort: 29260, driverPort: 29261 };

describe('runAgentPreflight — applicability matrix', () => {
  it('web serve (no attach): runs node, chromium, driver-cli, port-free, driver-port-free — all pass', async () => {
    const task = makeTask({ serve: { cmd: 'pnpm dev --port ${PORT}' } });
    const result = await runAgentPreflight(happyDeps(), { task, ...ARGS });
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.id).sort()).toEqual(
      ['chromium', 'driver-cli', 'driver-port-free', 'node', 'port-free'].sort(),
    );
  });

  it("attach:'cdp' serve: chromium and port-free are BOTH inapplicable — omitted, not failed", async () => {
    const task = makeTask({ serve: { cmd: 'electron . --remote-debugging-port="$VERIFY_DRIVER_PORT"', attach: 'cdp' } });
    const result = await runAgentPreflight(happyDeps(), { task, ...ARGS });
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.id).sort()).toEqual(['driver-cli', 'driver-port-free', 'node'].sort());
    expect(checkFor(result, 'chromium')).toBeUndefined();
    expect(checkFor(result, 'port-free')).toBeUndefined();
  });

  it('degenerate target-only task (no serve): chromium runs (driver still launches its own browser), port-free is inapplicable (nothing to bind)', async () => {
    const task = makeTask({ target: { url: 'https://example.com' } });
    const result = await runAgentPreflight(happyDeps(), { task, ...ARGS });
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.id).sort()).toEqual(['chromium', 'driver-cli', 'driver-port-free', 'node'].sort());
    expect(checkFor(result, 'port-free')).toBeUndefined();
  });

  it('driver-port-free and node ALWAYS run regardless of task shape', async () => {
    for (const task of [
      makeTask({ serve: { cmd: 'x' } }),
      makeTask({ serve: { cmd: 'x', attach: 'cdp' } }),
      makeTask({ target: { htmlPath: '/tmp/x.html' } }),
    ]) {
      const result = await runAgentPreflight(happyDeps(), { task, ...ARGS });
      expect(checkFor(result, 'node')).toBeDefined();
      expect(checkFor(result, 'driver-port-free')).toBeDefined();
      expect(checkFor(result, 'driver-cli')).toBeDefined();
    }
  });
});

describe('runAgentPreflight — fail-open rule (throwing probes ⇒ ok:true, inconclusive)', () => {
  it('resolveChromium throwing is INCONCLUSIVE (ok:true), not a failure', async () => {
    const task = makeTask({ serve: { cmd: 'x' } });
    const deps = happyDeps({
      resolveChromium: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    const result = await runAgentPreflight(deps, { task, ...ARGS });
    const chromium = checkFor(result, 'chromium');
    expect(chromium?.ok).toBe(true);
    expect(chromium?.detail).toMatch(/inconclusive/i);
    expect(result.ok).toBe(true);
  });

  it('fileExists throwing is INCONCLUSIVE (ok:true) for driver-cli', async () => {
    const task = makeTask();
    const deps = happyDeps({
      fileExists: async () => {
        throw new Error('EACCES');
      },
    });
    const result = await runAgentPreflight(deps, { task, ...ARGS });
    const driverCli = checkFor(result, 'driver-cli');
    expect(driverCli?.ok).toBe(true);
    expect(driverCli?.detail).toMatch(/inconclusive/i);
    expect(result.ok).toBe(true);
  });

  it('portFreeProbe throwing is INCONCLUSIVE (ok:true) for both port-free and driver-port-free', async () => {
    const task = makeTask({ serve: { cmd: 'x' } });
    const deps = happyDeps({
      portFreeProbe: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const result = await runAgentPreflight(deps, { task, ...ARGS });
    expect(checkFor(result, 'port-free')?.ok).toBe(true);
    expect(checkFor(result, 'driver-port-free')?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('resolveNode throwing is the ONE exception — it is affirmative and FAILS the check', async () => {
    const task = makeTask();
    const deps = happyDeps({
      resolveNode: async () => {
        throw new Error('no node binary found');
      },
    });
    const result = await runAgentPreflight(deps, { task, ...ARGS });
    const node = checkFor(result, 'node');
    expect(node?.ok).toBe(false);
    expect(node?.detail).toMatch(/unresolvable/i);
    expect(result.ok).toBe(false);
  });
});

describe('runAgentPreflight — affirmative failures', () => {
  it('resolveChromium resolving null is affirmative (absent) — fails the check', async () => {
    const task = makeTask({ serve: { cmd: 'x' } });
    const deps = happyDeps({ resolveChromium: async () => null });
    const result = await runAgentPreflight(deps, { task, ...ARGS });
    const chromium = checkFor(result, 'chromium');
    expect(chromium?.ok).toBe(false);
    expect(chromium?.detail).toMatch(/absent/i);
    expect(result.ok).toBe(false);
  });

  it('fileExists resolving false fails driver-cli', async () => {
    const task = makeTask();
    const deps = happyDeps({ fileExists: async () => false });
    const result = await runAgentPreflight(deps, { task, ...ARGS });
    expect(checkFor(result, 'driver-cli')?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('a squatted leased port (connect succeeds, portFreeProbe resolves false) fails port-free with squatter detail', async () => {
    const task = makeTask({ serve: { cmd: 'pnpm dev --port ${PORT}' } });
    const deps = happyDeps({
      portFreeProbe: async (port) => port !== ARGS.leasedPort, // leasedPort is occupied; driverPort is free
    });
    const result = await runAgentPreflight(deps, { task, ...ARGS });
    const portFree = checkFor(result, 'port-free');
    expect(portFree?.ok).toBe(false);
    expect(portFree?.detail).toMatch(/squatter/i);
    expect(checkFor(result, 'driver-port-free')?.ok).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('a squatted driver port fails driver-port-free even when everything else is healthy', async () => {
    const task = makeTask({ target: { url: 'https://example.com' } });
    const deps = happyDeps({
      portFreeProbe: async (port) => port !== ARGS.driverPort,
    });
    const result = await runAgentPreflight(deps, { task, ...ARGS });
    expect(checkFor(result, 'driver-port-free')?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('multiple failing checks are all recorded (not short-circuited)', async () => {
    const task = makeTask({ serve: { cmd: 'x' } });
    const deps: AgentPreflightDeps = {
      resolveNode: async () => {
        throw new Error('no node');
      },
      resolveChromium: async () => null,
      fileExists: async () => false,
      portFreeProbe: async () => false,
    };
    const result = await runAgentPreflight(deps, { task, ...ARGS });
    expect(result.ok).toBe(false);
    expect(result.checks.every((c) => !c.ok)).toBe(true);
    expect(result.checks).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// 'native-capture' — the §4 roster's modality-gated check
// ---------------------------------------------------------------------------

describe("runAgentPreflight — 'native-capture' applicability", () => {
  const task = makeTask({ target: { url: 'https://example.com' } });

  it('runs ONLY for modality native-screen, and only when a probe is wired', async () => {
    const probe = async (): Promise<boolean> => true;
    const wired = await runAgentPreflight(happyDeps({ nativeCaptureProbe: probe }), {
      task,
      ...ARGS,
      modality: 'native-screen',
    });
    expect(checkFor(wired, 'native-capture')?.ok).toBe(true);
    expect(wired.ok).toBe(true);

    for (const modality of ['web', 'cdp-app', 'mobile'] as const) {
      const other = await runAgentPreflight(happyDeps({ nativeCaptureProbe: probe }), {
        task,
        ...ARGS,
        modality,
      });
      expect(checkFor(other, 'native-capture')).toBeUndefined();
    }
  });

  it('is omitted entirely when no modality is supplied (the pre-roster check set)', async () => {
    const result = await runAgentPreflight(happyDeps({ nativeCaptureProbe: async () => false }), {
      task,
      ...ARGS,
    });
    expect(checkFor(result, 'native-capture')).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('an ABSENT probe means the check does not run — never a failure (the scheduler gate already blocked it)', async () => {
    const result = await runAgentPreflight(happyDeps(), { task, ...ARGS, modality: 'native-screen' });
    expect(checkFor(result, 'native-capture')).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('an affirmative false FAILS the check (the harness-derived env evidence)', async () => {
    const result = await runAgentPreflight(happyDeps({ nativeCaptureProbe: async () => false }), {
      task,
      ...ARGS,
      modality: 'native-screen',
    });
    const check = checkFor(result, 'native-capture');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/probe returned false/);
    expect(result.ok).toBe(false);
  });

  it('a THROWING probe is INCONCLUSIVE (ok:true) — the same fail-open rule as every other probe', async () => {
    const result = await runAgentPreflight(
      happyDeps({
        nativeCaptureProbe: async () => {
          throw new Error('peekaboo wedged');
        },
      }),
      { task, ...ARGS, modality: 'native-screen' },
    );
    const check = checkFor(result, 'native-capture');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/inconclusive/i);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 'mobile-toolchain' — the mobile modality's toolchain-gated check
// ---------------------------------------------------------------------------

describe("runAgentPreflight — 'mobile-toolchain' applicability", () => {
  const mobileArgs = { driverCliPath: '/opt/cyboflow/driver-cli', leasedPort: 29260, driverPort: null };

  it('runs ONLY for modality mobile, and only when a probe is wired', async () => {
    const probe = async (): Promise<boolean> => true;
    const task = makeTask({ target: { url: 'https://example.com' } });

    const wired = await runAgentPreflight(happyDeps({ mobileToolchainProbe: probe }), {
      task,
      ...mobileArgs,
      modality: 'mobile',
    });
    expect(checkFor(wired, 'mobile-toolchain')?.ok).toBe(true);
    expect(wired.ok).toBe(true);

    for (const modality of ['web', 'cdp-app', 'native-screen'] as const) {
      const other = await runAgentPreflight(happyDeps({ mobileToolchainProbe: probe }), {
        task,
        ...ARGS,
        modality,
      });
      expect(checkFor(other, 'mobile-toolchain')).toBeUndefined();
    }
  });

  it('is omitted entirely when no modality is supplied', async () => {
    const task = makeTask({ target: { url: 'https://example.com' } });
    const result = await runAgentPreflight(happyDeps({ mobileToolchainProbe: async () => false }), {
      task,
      ...ARGS,
    });
    expect(checkFor(result, 'mobile-toolchain')).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('an ABSENT probe means the check does not run — never a failure', async () => {
    const task = makeTask({ target: { url: 'https://example.com' } });
    const result = await runAgentPreflight(happyDeps(), { task, ...mobileArgs, modality: 'mobile' });
    expect(checkFor(result, 'mobile-toolchain')).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('an affirmative false FAILS the check, naming Xcode CLT / iOS runtime / device type', async () => {
    const task = makeTask({ target: { url: 'https://example.com' } });
    const result = await runAgentPreflight(happyDeps({ mobileToolchainProbe: async () => false }), {
      task,
      ...mobileArgs,
      modality: 'mobile',
    });
    const check = checkFor(result, 'mobile-toolchain');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/Xcode Command Line Tools/);
    expect(check?.detail).toMatch(/iOS Simulator runtime/);
    expect(check?.detail).toMatch(/iPhone device type/);
    expect(result.ok).toBe(false);
  });

  it('a THROWING probe is INCONCLUSIVE (ok:true) — the same fail-open rule as every other probe', async () => {
    const task = makeTask({ target: { url: 'https://example.com' } });
    const result = await runAgentPreflight(
      happyDeps({
        mobileToolchainProbe: async () => {
          throw new Error('xcrun simctl wedged');
        },
      }),
      { task, ...mobileArgs, modality: 'mobile' },
    );
    const check = checkFor(result, 'mobile-toolchain');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/inconclusive/i);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mobile task shape: no serve, driverPort: null — chromium/port checks skip
// ---------------------------------------------------------------------------

describe('runAgentPreflight — mobile task shape (no serve, driverPort: null)', () => {
  it('a mobile task has no chromium, no port-free, no driver-port-free rows', async () => {
    const task = makeTask({ target: { url: 'https://example.com' } });
    const result = await runAgentPreflight(happyDeps(), {
      task,
      driverCliPath: '/opt/cyboflow/driver-cli',
      leasedPort: 29260,
      driverPort: null,
      modality: 'mobile',
    });
    expect(checkFor(result, 'chromium')).toBeUndefined();
    expect(checkFor(result, 'port-free')).toBeUndefined();
    expect(checkFor(result, 'driver-port-free')).toBeUndefined();
    expect(result.checks.map((c) => c.id).sort()).toEqual(['driver-cli', 'node'].sort());
    expect(result.ok).toBe(true);
  });

  it('a web task with a numeric driverPort still has driver-port-free', async () => {
    const task = makeTask({ serve: { cmd: 'pnpm dev --port ${PORT}' } });
    const result = await runAgentPreflight(happyDeps(), { task, ...ARGS });
    expect(checkFor(result, 'driver-port-free')).toBeDefined();
  });
});

describe("runAgentPreflight — 'data-dir' (conditional, affirmative on throw)", () => {
  const task = makeTask({ serve: { cmd: 'pnpm dev --port ${PORT}', attach: 'cdp' } });

  it('does not run without a prepareDataDir probe, nor without a dataDir', async () => {
    const noProbe = await runAgentPreflight(happyDeps(), { task, ...ARGS, dataDir: '/artifacts/data/abcd1234' });
    expect(checkFor(noProbe, 'data-dir')).toBeUndefined();

    const noPath = await runAgentPreflight(happyDeps({ prepareDataDir: async () => {} }), { task, ...ARGS });
    expect(checkFor(noPath, 'data-dir')).toBeUndefined();
  });

  it('provisions the given path and records it', async () => {
    const seen: string[] = [];
    const deps = happyDeps({
      prepareDataDir: async (dir) => {
        seen.push(dir);
      },
    });
    const result = await runAgentPreflight(deps, { task, ...ARGS, dataDir: '/artifacts/data/abcd1234' });
    expect(seen).toEqual(['/artifacts/data/abcd1234']);
    expect(checkFor(result, 'data-dir')).toEqual({ id: 'data-dir', ok: true, detail: 'provisioned /artifacts/data/abcd1234' });
    expect(result.ok).toBe(true);
  });

  it('a throw is affirmative failure (like node, unlike every other probe)', async () => {
    const deps = happyDeps({
      prepareDataDir: async () => {
        throw new Error('EROFS: read-only file system');
      },
    });
    const result = await runAgentPreflight(deps, { task, ...ARGS, dataDir: '/artifacts/data/abcd1234' });
    expect(result.ok).toBe(false);
    expect(checkFor(result, 'data-dir')).toEqual({
      id: 'data-dir',
      ok: false,
      detail: 'could not provision VERIFY_DATA_DIR at /artifacts/data/abcd1234: EROFS: read-only file system',
    });
  });
});
