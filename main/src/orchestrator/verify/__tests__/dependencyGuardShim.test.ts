/**
 * dependencyGuardShim — the A1.4 "Codex live dependency guard (F8)" PATH shim
 * (docs/proposals/runbook-optional-verification.md "A1.4 Explore guardrails").
 *
 * Coverage:
 *  - the pure generators (`dependencyGuardScriptBody`, `dependencyGuardWrapperBody`)
 *    at the STRING level — including the load-bearing "serialized functions are
 *    the live ones" invariant the module doc calls out;
 *  - the argv matcher's parity with FORBIDDEN_DEP_COMMAND_PATTERN on every
 *    canonical forbidden form, and its exact-verb refusal of the pattern's
 *    `\b` false positives (`pnpm ci:prepare`, `bun up.ts`);
 *  - `materializeDependencyGuardShim` end-to-end on THIS macOS host, using the
 *    real vitest node's own `process.execPath` as `nodePath` (no fake SDK, no
 *    mock — this is a real fs + real shell + real node child process, which is
 *    the only way to prove the generated wrapper/guard actually round-trip
 *    through a POSIX shell);
 *  - win32 (no write) and fs-failure (log-free null) via platform/dir injection.
 */
import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FORBIDDEN_DEP_COMMAND_PATTERN, forbiddenDepCommandDenyMessage } from '../dependencyCommandGuard';
import { escapeShellArg } from '../../../utils/shellEscape';
import {
  DEPENDENCY_GUARD_SHIM_MARKER,
  DEPENDENCY_GUARD_SHIM_TOOLS,
  dependencyGuardScriptBody,
  dependencyGuardWrapperBody,
  hostLifecycleFromEnv,
  isForbiddenDependencyInvocation,
  isPackageScriptChild,
  materializeDependencyGuardShim,
} from '../dependencyGuardShim';

describe('DEPENDENCY_GUARD_SHIM_TOOLS', () => {
  it('is exactly the A1.4 spec list, in order', () => {
    expect([...DEPENDENCY_GUARD_SHIM_TOOLS]).toEqual(['pnpm', 'npm', 'yarn', 'bun', 'pod', 'swift', 'npx']);
  });
});

describe('dependencyGuardScriptBody — pure generator', () => {
  it('serializes the SAME live functions (matcher, script-child test, deny message), so they can never drift', () => {
    const body = dependencyGuardScriptBody();
    expect(body).toContain(isForbiddenDependencyInvocation.toString());
    expect(body).toContain(isPackageScriptChild.toString());
    expect(body).toContain(forbiddenDepCommandDenyMessage.toString());
  });

  it('embeds the execution mode and the host lifecycle pair as JSON constants (null when absent)', () => {
    expect(dependencyGuardScriptBody()).toContain('const EXECUTION_MODE = null;');
    expect(dependencyGuardScriptBody()).toContain('const HOST_LIFECYCLE = null;');
    const body = dependencyGuardScriptBody({
      executionMode: 'explore',
      hostLifecycle: { event: 'dev', packageJson: '/host/package.json' },
    });
    expect(body).toContain('const EXECUTION_MODE = "explore";');
    expect(body).toContain('const HOST_LIFECYCLE = {"event":"dev","packageJson":"/host/package.json"};');
  });

  it('embeds the wrapper marker it skips candidates by (the never-resolve-to-a-shim rule)', () => {
    expect(dependencyGuardScriptBody()).toContain(`const SHIM_MARKER = ${JSON.stringify(DEPENDENCY_GUARD_SHIM_MARKER)};`);
  });

  it('is valid, parseable JavaScript (a smoke check on the generated text itself)', () => {
    const body = dependencyGuardScriptBody();
    // Strip the shebang line — valid for a FILE node executes, but not inside a
    // `Function` body. `new Function` throws a SyntaxError on malformed source
    // without executing it (no process.argv/process.exit at parse time).
    const withoutShebang = body.replace(/^#!.*\n/, '');
    expect(() => new Function(withoutShebang)).not.toThrow();
  });
});

// The shim sees each package-manager call's ARGV, including calls NESTED in a
// project script that no enqueue check or canUseTool ever saw — so it must
// match exact verbs, not the shell-string pattern's `\b` (adversarial-review fix).
describe('isForbiddenDependencyInvocation — argv matcher', () => {
  const argv = (cmd: string): [string, string[]] => {
    const [tool, ...args] = cmd.split(' ');
    return [tool, args];
  };
  const denied = (cmd: string): boolean => isForbiddenDependencyInvocation(...argv(cmd));

  // Every one of these is ALSO a FORBIDDEN_DEP_COMMAND_PATTERN match: the two
  // seams must agree on the canonical forbidden forms.
  const forbidden = [
    ...['pnpm', 'npm', 'yarn', 'bun'].flatMap((m) =>
      ['install', 'i', 'ci', 'add', 'rebuild', 'up', 'update', 'upgrade'].map((v) => `${m} ${v}`),
    ),
    'pnpm install --frozen-lockfile',
    'pnpm -r install',
    'npm --prefix=x ci',
    'pnpm --filter=app add lodash',
    'npx playwright install',
    'npx playwright install --with-deps chromium',
    'pnpm exec playwright install',
    'npx electron-rebuild',
    'npx electron-builder install-app-deps',
    'pod install',
    'pod update',
    'pod repo update',
    'swift package resolve',
    'swift package update',
  ];
  it.each(forbidden)('denies %j, in agreement with FORBIDDEN_DEP_COMMAND_PATTERN', (cmd) => {
    expect(FORBIDDEN_DEP_COMMAND_PATTERN.test(cmd)).toBe(true);
    expect(denied(cmd)).toBe(true);
  });

  // Forms the argv matcher reaches that a flag operand or a launcher hides.
  const forbiddenArgvOnly = [
    'pnpm -C packages/app install',
    'pnpm --filter app add lodash',
    'npm --prefix x ci',
    'yarn --cwd x add lodash',
    'yarn workspace app add lodash',
    'pnpm dlx playwright install',
    'bun x playwright install',
    'npx playwright@1.44.0 install',
    'npx -y playwright install',
    'npx @electron/rebuild',
    'npx pnpm install',
    'npm exec -- playwright install',
    'swift package --package-path x resolve',
  ];
  it.each(forbiddenArgvOnly)('denies %j', (cmd) => {
    expect(denied(cmd)).toBe(true);
  });

  // The pattern's `\b` accepts `:`, `-` and `.` as boundaries, so it DOES match
  // these; each one is a project script / file, and denying it failed a build.
  const patternFalsePositives = [
    'pnpm ci:prepare',
    'pnpm ci:check',
    'pnpm update-snapshots',
    'yarn install:hooks',
    'bun up.ts',
    'pnpm add-license-headers',
  ];
  it.each(patternFalsePositives)('allows %j (not an exact dependency verb)', (cmd) => {
    expect(FORBIDDEN_DEP_COMMAND_PATTERN.test(cmd)).toBe(true);
    expect(denied(cmd)).toBe(false);
  });

  const allowed = [
    'pnpm run install', // a script NAMED install
    'pnpm build',
    'pnpm',
    'npm test',
    'npx playwright test',
    'pnpm exec vite build',
    'npx electron-builder --mac',
    'swift build',
    'pod --version',
    'yarn workspace app build',
  ];
  it.each(allowed)('allows %j', (cmd) => {
    expect(denied(cmd)).toBe(false);
  });
});

describe('isPackageScriptChild', () => {
  it('is false when no package script is running', () => {
    expect(isPackageScriptChild({}, null)).toBe(false);
  });

  it('is true inside a package script the host did not itself carry', () => {
    expect(isPackageScriptChild({ npm_lifecycle_event: 'build', npm_package_json: '/snap/package.json' }, null)).toBe(true);
    const host = { event: 'dev', packageJson: '/host/package.json' };
    expect(isPackageScriptChild({ npm_lifecycle_event: 'dev', npm_package_json: '/snap/package.json' }, host)).toBe(true);
  });

  // cyboflow under `pnpm dev` carries npm_lifecycle_event=dev itself, and the
  // agent inherits it — that must NOT switch the guard off.
  it('is false for exactly the pair the host inherited', () => {
    const host = hostLifecycleFromEnv({ npm_lifecycle_event: 'dev', npm_package_json: '/host/package.json' });
    expect(host).toEqual({ event: 'dev', packageJson: '/host/package.json' });
    expect(isPackageScriptChild({ npm_lifecycle_event: 'dev', npm_package_json: '/host/package.json' }, host)).toBe(false);
  });

  it('hostLifecycleFromEnv is null when the host was not started by a package script', () => {
    expect(hostLifecycleFromEnv({})).toBeNull();
  });
});

describe('dependencyGuardWrapperBody — pure generator', () => {
  it('quotes every embedded value with escapeShellArg, carries the marker, and execs what the guard printed', () => {
    const nodePath = "/tmp/my node's dir/node";
    const guardPath = "/tmp/shim bin/guard.js";
    const nodeEnv = { FOO: "bar baz's value" };
    const body = dependencyGuardWrapperBody('pnpm', nodePath, guardPath, nodeEnv);
    expect(body).toBe(
      [
        '#!/bin/sh',
        `# ${DEPENDENCY_GUARD_SHIM_MARKER} (generated by cyboflow dependencyGuardShim.ts; do not edit)`,
        `real=$(env ${escapeShellArg("FOO=bar baz's value")} ${escapeShellArg(nodePath)} ${escapeShellArg(guardPath)} ${escapeShellArg('pnpm')} "$@") || exit $?`,
        'exec "$real" "$@"',
        '',
      ].join('\n'),
    );
  });

  it('carries no env assignments when nodeEnv is empty', () => {
    const body = dependencyGuardWrapperBody('npm', '/usr/bin/node', '/shim/guard.js', {});
    expect(body).toContain(
      `real=$(env ${escapeShellArg('/usr/bin/node')} ${escapeShellArg('/shim/guard.js')} ${escapeShellArg('npm')} "$@") || exit $?`,
    );
  });
});

describe('materializeDependencyGuardShim — win32 / fs-failure', () => {
  it('returns { binDir: null } and writes nothing on win32', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-win32-'));
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const result = await materializeDependencyGuardShim({ dir, nodePath: '/usr/bin/node', nodeEnv: {} });
      expect(result).toEqual({ binDir: null });
      expect(existsSync(join(dir, 'bin'))).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', originalDescriptor);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns { binDir: null }, log-free, when the target cannot be created (fs failure)', async () => {
    // `dir` is a FILE, not a directory — mkdir(join(dir, 'bin')) fails ENOTDIR.
    const parent = mkdtempSync(join(tmpdir(), 'dep-guard-shim-fsfail-'));
    const fileAsDir = join(parent, 'not-a-directory');
    writeFileSync(fileAsDir, 'not a directory');
    try {
      const result = await materializeDependencyGuardShim({ dir: fileAsDir, nodePath: process.execPath, nodeEnv: {} });
      expect(result).toEqual({ binDir: null });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end on this macOS host: a real fs + real shell + a real node child
// process (the injected "fake tool" is a plain #!/bin/sh script; nodePath is
// process.execPath, the vitest worker's own real node).
// ---------------------------------------------------------------------------

/**
 * Real system dirs appended AFTER the test's own dirs in every PATH below: the
 * WRAPPER script itself execs the real `env` and runs under the real `/bin/sh`
 * shebang, so those two must be resolvable — `/usr/bin` and `/bin` hold them on
 * every macOS host. Confirmed empty of pnpm/npm/yarn/bun/pod on a stock macOS
 * install, so appending them never accidentally satisfies the "real tool"
 * lookup with a system binary instead of the test's fake one. `swift` is the
 * one exception (Xcode CLT ships `/usr/bin/swift`), so the "tool absent from
 * PATH" test below deliberately uses `pod` instead.
 */
const SYSTEM_PATH = '/usr/bin:/bin';

/** Build a fake `pnpm` that echoes its args + one probed env var, then exits with `exitCode`. */
function writeFakeTool(path: string, exitCode: number): void {
  writeFileSync(
    path,
    `#!/bin/sh\necho "ARGS:$@"\necho "PROBE:\${DEP_GUARD_SHIM_PROBE:-<unset>}"\nexit ${exitCode}\n`,
    'utf8',
  );
  chmodSync(path, 0o755);
}

/** `kill -0` liveness probe. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort SIGKILL of anything still running out of `roots` (every guard
 * and wrapper carries its root in its argv). The recursion tests below would,
 * on a regression, leave a self-perpetuating chain behind that the spawn
 * timeout alone does not stop — so they sweep until nothing is left.
 */
function reapStrays(...roots: string[]): void {
  for (let i = 0; i < 20; i++) {
    let found = false;
    for (const root of roots) {
      if (spawnSync('pgrep', ['-f', root]).status === 0) {
        found = true;
        spawnSync('pkill', ['-9', '-f', root]);
      }
    }
    if (!found) return;
    spawnSync('sleep', ['0.1']);
  }
}

describe('materializeDependencyGuardShim — end-to-end (real shell, real node)', () => {
  it('a benign command reaches the real tool and its exit code passes through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-'));
    const fakeDir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-fake-'));
    try {
      writeFakeTool(join(fakeDir, 'pnpm'), 3);
      const { binDir } = await materializeDependencyGuardShim({ dir, nodePath: process.execPath, nodeEnv: {} });
      expect(binDir).not.toBeNull();
      if (!binDir) throw new Error('expected a binDir');

      const result = spawnSync(join(binDir, 'pnpm'), ['run', 'build'], {
        env: { PATH: `${binDir}:${fakeDir}:${SYSTEM_PATH}` },
        encoding: 'utf8',
      });

      expect(result.status).toBe(3);
      expect(result.stdout).toContain('ARGS:run build');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('a dependency-mutating command is denied (126), stderr names it, and the real tool is never invoked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-'));
    const fakeDir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-fake-'));
    try {
      writeFakeTool(join(fakeDir, 'pnpm'), 3);
      const { binDir } = await materializeDependencyGuardShim({ dir, nodePath: process.execPath, nodeEnv: {} });
      if (!binDir) throw new Error('expected a binDir');

      const result = spawnSync(join(binDir, 'pnpm'), ['install'], {
        env: { PATH: `${binDir}:${fakeDir}:${SYSTEM_PATH}` },
        encoding: 'utf8',
      });

      expect(result.status).toBe(126);
      // Byte-for-byte the live TypeScript wording — the `.toString()` embedding
      // cannot drift from forbiddenDepCommandDenyMessage without this failing.
      expect(result.stderr).toBe(`${forbiddenDepCommandDenyMessage('pnpm install')}\n`);
      // The fake tool would have printed "ARGS:" — its absence proves it never ran.
      expect(result.stdout).not.toContain('ARGS:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('a package-script lookalike (`pnpm ci:prepare`) reaches the real tool (exact-verb match, not the pattern\'s \\b)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-'));
    const fakeDir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-fake-'));
    try {
      writeFakeTool(join(fakeDir, 'pnpm'), 3);
      const { binDir } = await materializeDependencyGuardShim({ dir, nodePath: process.execPath, nodeEnv: {} });
      if (!binDir) throw new Error('expected a binDir');

      for (const args of [['ci:prepare'], ['update-snapshots']]) {
        const result = spawnSync(join(binDir, 'pnpm'), args, {
          env: { PATH: `${binDir}:${fakeDir}:${SYSTEM_PATH}` },
          encoding: 'utf8',
        });
        expect(result.status).toBe(3);
        expect(result.stdout).toContain(`ARGS:${args[0]}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('an install made BY a package script (npm_lifecycle_event set) is not enforced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-'));
    const fakeDir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-fake-'));
    try {
      writeFakeTool(join(fakeDir, 'npm'), 3);
      const { binDir } = await materializeDependencyGuardShim({ dir, nodePath: process.execPath, nodeEnv: {}, hostEnv: {} });
      if (!binDir) throw new Error('expected a binDir');

      // A project `prebuild: npm ci`, run by `pnpm build` in the snapshot.
      const result = spawnSync(join(binDir, 'npm'), ['ci'], {
        env: {
          PATH: `${binDir}:${fakeDir}:${SYSTEM_PATH}`,
          npm_lifecycle_event: 'prebuild',
          npm_package_json: '/snap/package.json',
        },
        encoding: 'utf8',
      });
      expect(result.status).toBe(3);
      expect(result.stdout).toContain('ARGS:ci');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('the lifecycle pair the HOST inherited (cyboflow under `pnpm dev`) does not switch the guard off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-'));
    const fakeDir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-fake-'));
    const hostLifecycleEnv = { npm_lifecycle_event: 'dev', npm_package_json: '/host/cyboflow/package.json' };
    try {
      writeFakeTool(join(fakeDir, 'pnpm'), 3);
      const { binDir } = await materializeDependencyGuardShim({
        dir,
        nodePath: process.execPath,
        nodeEnv: {},
        hostEnv: hostLifecycleEnv,
      });
      if (!binDir) throw new Error('expected a binDir');

      const result = spawnSync(join(binDir, 'pnpm'), ['install'], {
        env: { PATH: `${binDir}:${fakeDir}:${SYSTEM_PATH}`, ...hostLifecycleEnv },
        encoding: 'utf8',
      });
      expect(result.status).toBe(126);
      expect(result.stdout).not.toContain('ARGS:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('an explore-mode shim words its deny for explore ("unverifiable"), byte for byte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-'));
    const fakeDir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-fake-'));
    try {
      writeFakeTool(join(fakeDir, 'pod'), 3);
      const { binDir } = await materializeDependencyGuardShim({
        dir,
        nodePath: process.execPath,
        nodeEnv: {},
        executionMode: 'explore',
      });
      if (!binDir) throw new Error('expected a binDir');

      const result = spawnSync(join(binDir, 'pod'), ['install'], {
        env: { PATH: `${binDir}:${fakeDir}:${SYSTEM_PATH}` },
        encoding: 'utf8',
      });
      expect(result.status).toBe(126);
      expect(result.stderr).toBe(`${forbiddenDepCommandDenyMessage('pod install', 'explore')}\n`);
      expect(result.stderr).toContain('"unverifiable"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('a tool absent from PATH (outside the shim dir) exits 127 with a stderr message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-'));
    try {
      const { binDir } = await materializeDependencyGuardShim({ dir, nodePath: process.execPath, nodeEnv: {} });
      if (!binDir) throw new Error('expected a binDir');

      // "pod" (unlike "swift") is confirmed absent from /usr/bin and /bin on a
      // stock macOS host — see SYSTEM_PATH's doc.
      const result = spawnSync(join(binDir, 'pod'), ['--version'], {
        env: { PATH: `${binDir}:${SYSTEM_PATH}` },
        encoding: 'utf8',
      });

      expect(result.status).toBe(127);
      expect(result.stderr).toContain('pod');
      expect(result.stderr).toContain('not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a nodeEnv key does not reach the real tool (it is set on the guard\'s own invocation only)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-'));
    const fakeDir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-fake-'));
    try {
      writeFakeTool(join(fakeDir, 'pnpm'), 0);
      const { binDir } = await materializeDependencyGuardShim({
        dir,
        nodePath: process.execPath,
        nodeEnv: { DEP_GUARD_SHIM_PROBE: 'leaked-value' },
      });
      if (!binDir) throw new Error('expected a binDir');

      const result = spawnSync(join(binDir, 'pnpm'), ['run', 'build'], {
        env: { PATH: `${binDir}:${fakeDir}:${SYSTEM_PATH}` },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('PROBE:<unset>');
      expect(result.stdout).not.toContain('leaked-value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('nodePath and the shim root both containing a space AND a single quote still work', async () => {
    const dir = mkdtempSync(join(tmpdir(), "dep guard's shim-"));
    const fakeDir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-fake-'));
    const oddNodeDir = mkdtempSync(join(tmpdir(), "dep guard's node-"));
    const oddNodePath = join(oddNodeDir, "node's own copy");
    try {
      symlinkSync(process.execPath, oddNodePath);
      writeFakeTool(join(fakeDir, 'pnpm'), 3);
      const { binDir } = await materializeDependencyGuardShim({ dir, nodePath: oddNodePath, nodeEnv: {} });
      if (!binDir) throw new Error('expected a binDir');

      const result = spawnSync(join(binDir, 'pnpm'), ['run', 'build'], {
        env: { PATH: `${binDir}:${fakeDir}:${SYSTEM_PATH}` },
        encoding: 'utf8',
      });

      expect(result.status).toBe(3);
      expect(result.stdout).toContain('ARGS:run build');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
      rmSync(oddNodeDir, { recursive: true, force: true });
    }
  });

  it("a value the CALLER already carries for a nodeEnv key reaches the real tool untouched (as without the shim)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-'));
    const fakeDir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-fake-'));
    try {
      writeFakeTool(join(fakeDir, 'pnpm'), 0);
      const { binDir } = await materializeDependencyGuardShim({
        dir,
        nodePath: process.execPath,
        nodeEnv: { DEP_GUARD_SHIM_PROBE: 'leaked-value' },
      });
      if (!binDir) throw new Error('expected a binDir');

      const result = spawnSync(join(binDir, 'pnpm'), ['run', 'build'], {
        env: { PATH: `${binDir}:${fakeDir}:${SYSTEM_PATH}`, DEP_GUARD_SHIM_PROBE: 'from-caller' },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('PROBE:from-caller');
      expect(result.stdout).not.toContain('leaked-value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('the real tool REPLACES the wrapper process: same pid, and a signal to it ends the real tool (nothing orphaned)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-'));
    const fakeDir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-fake-'));
    const pidFile = join(fakeDir, 'real.pid');
    let realPid: number | null = null;
    try {
      // A long-running "dev server" that records its own pid, then becomes `sleep`.
      writeFileSync(join(fakeDir, 'pnpm'), `#!/bin/sh
echo $$ > ${escapeShellArg(pidFile)}
exec sleep 30
`, 'utf8');
      chmodSync(join(fakeDir, 'pnpm'), 0o755);
      const { binDir } = await materializeDependencyGuardShim({ dir, nodePath: process.execPath, nodeEnv: {} });
      if (!binDir) throw new Error('expected a binDir');

      const child = spawn(join(binDir, 'pnpm'), ['dev'], {
        env: { PATH: `${binDir}:${fakeDir}:${SYSTEM_PATH}` },
        stdio: 'ignore',
      });
      const exited = new Promise<NodeJS.Signals | null>((resolveExit) => {
        child.on('exit', (_code, signal) => resolveExit(signal));
      });
      const deadline = Date.now() + 10_000;
      while (realPid === null && Date.now() < deadline) {
        const recorded = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : NaN;
        if (Number.isInteger(recorded) && recorded > 0) realPid = recorded;
        else await new Promise((r) => setTimeout(r, 25));
      }
      if (realPid === null) throw new Error('the real tool never started');

      // `pnpm dev & … kill $!` must stop the dev server, as it did pre-shim.
      expect(realPid).toBe(child.pid);
      child.kill('SIGTERM');
      expect(await exited).toBe('SIGTERM');
      expect(isAlive(realPid)).toBe(false);
    } finally {
      if (realPid !== null && isAlive(realPid)) process.kill(realPid, 'SIGKILL');
      reapStrays(dir, fakeDir);
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('never resolves to a shim: a second shim dir, a symlinked spelling of its own dir, or a relative PATH entry all reach the real tool', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'dep-guard-shim-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'dep-guard-shim-b-'));
    const fakeDir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-fake-'));
    try {
      writeFakeTool(join(fakeDir, 'pnpm'), 3);
      const a = await materializeDependencyGuardShim({ dir: dirA, nodePath: process.execPath, nodeEnv: {} });
      const b = await materializeDependencyGuardShim({ dir: dirB, nodePath: process.execPath, nodeEnv: {} });
      if (!a.binDir || !b.binDir) throw new Error('expected both binDirs');
      const aliasOfA = join(dirA, 'alias-of-bin');
      symlinkSync(a.binDir, aliasOfA);

      // Bounded, so a regression FAILS rather than hangs (see reapStrays).
      const run = (pathEnv: string, cwd?: string) =>
        spawnSync(join(a.binDir as string, 'pnpm'), ['run', 'build'], {
          env: { PATH: pathEnv },
          ...(cwd ? { cwd } : {}),
          encoding: 'utf8',
          timeout: 15_000,
          killSignal: 'SIGKILL',
        });

      for (const result of [
        run(`${a.binDir}:${b.binDir}:${fakeDir}:${SYSTEM_PATH}`),
        run(`${a.binDir}:${aliasOfA}:${fakeDir}:${SYSTEM_PATH}`),
        // `.` resolves against the caller's cwd — the printed path must be
        // absolute, or the wrapper's `exec` would search PATH (and hit A) again.
        run(`${a.binDir}:.:${SYSTEM_PATH}`, fakeDir),
      ]) {
        expect(result.status).toBe(3);
        expect(result.stdout).toContain('ARGS:run build');
      }
    } finally {
      reapStrays(dirA, dirB);
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second materialize on the same dir rewrites cleanly (no leftover junk)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-guard-shim-'));
    try {
      const first = await materializeDependencyGuardShim({ dir, nodePath: process.execPath, nodeEnv: {} });
      if (!first.binDir) throw new Error('expected a binDir');
      writeFileSync(join(first.binDir, 'leftover-junk'), 'x');

      const second = await materializeDependencyGuardShim({
        dir,
        nodePath: process.execPath,
        nodeEnv: { A_NEW_KEY: 'v' },
      });
      if (!second.binDir) throw new Error('expected a binDir');

      const entries = readdirSync(second.binDir).sort();
      expect(entries).toEqual([...DEPENDENCY_GUARD_SHIM_TOOLS, 'guard.js'].sort());
      expect(entries).not.toContain('leftover-junk');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
