import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidToolchainProbeSpecError,
  NVM_NODE_PICK_LINES,
  buildPrelaunchProbeScript,
  buildProbeScript,
  buildToolchainProbeFragment,
  buildToolchainProbeScript,
  expandRemoteRoot,
  parseProbeOutput,
  remoteRootShellExpr,
} from '../remoteProbe';
import { serializeToolchainManifest } from '../toolchain/toolchainHash';
import type { ToolchainManifest } from '../toolchain/types';

const TC_HASH = 'c'.repeat(64);
const TC_CODEX_REL = 'codex/aarch64-apple-darwin/bin/codex';

const posix = process.platform !== 'win32';

const FULL = [
  'home=/Users/k',
  'user=k',
  'logname=k',
  'shell=/bin/zsh',
  'lang=en_US.UTF-8',
  'tmpdir=/var/folders/xy/T/',
  'uname_s=Darwin',
  'uname_m=arm64',
  'os_version=15.1',
  'xcode_clt=1',
  'git_version=git version 2.39.5 (Apple Git-154)',
  'git_path=/usr/bin/git',
  'node_path=/opt/homebrew/bin/node',
  'node_version=v22.11.0',
  'claude_path=/Users/k/.local/bin/claude',
  'claude_version=2.1.290 (Claude Code)',
  'codex_auth=0',
  'remote_root=/Users/k/cf-remote/abc',
  'sock_path_bytes=33',
  'env_exists=1',
  'env_mode=600',
  'env_wellformed=1',
  'env_lines=1',
  'sleep_value=0',
  'sleep_prevented=0',
  'disk_free_kb=123456789',
  'probe_done=1',
].join('\n');

describe('parseProbeOutput', () => {
  it('parses a complete probe into a typed record', () => {
    const p = parseProbeOutput(`${FULL}\n`);
    expect(p).toMatchObject({
      home: '/Users/k', unameS: 'Darwin', unameM: 'arm64', osVersion: '15.1', xcodeClt: true,
      gitVersion: 'git version 2.39.5 (Apple Git-154)', nodePath: '/opt/homebrew/bin/node', nodeVersion: 'v22.11.0',
      claudePath: '/Users/k/.local/bin/claude', codexPath: null, codexVersion: null, codexAuth: false,
      envExists: true, envMode: '600', envWellformed: 1, envLines: 1, sleepValue: '0', sleepPrevented: false,
      diskFreeKb: 123456789, complete: true,
      user: 'k', logname: 'k', shell: '/bin/zsh', lang: 'en_US.UTF-8', tmpdir: '/var/folders/xy/T/',
      gitPath: '/usr/bin/git', remoteRoot: '/Users/k/cf-remote/abc', sockPathBytes: 33,
    });
  });

  it('leaves the remote facts null when the probe did not report them', () => {
    const p = parseProbeOutput('home=/Users/k\nsock_path_bytes=x\nprobe_done=1\n');
    expect(p).toMatchObject({
      user: null, logname: null, shell: null, lang: null, tmpdir: null, gitPath: null, remoteRoot: null,
      sockPathBytes: null, complete: true,
    });
  });

  it('tolerates garbage, banners, CRLF and unknown keys', () => {
    const p = parseProbeOutput(`Welcome to box!\r\n\u001b[31mnoise\r\nuname_m=x86_64\r\nUNKNOWN=1\r\nweird line = x\r\nfoo_bar=baz\r\n`);
    expect(p.unameM).toBe('x86_64');
    expect(p.complete).toBe(false);
    expect(p.home).toBeNull();
  });

  it('maps missing / empty / malformed values to null and keeps the first duplicate', () => {
    const p = parseProbeOutput('home=\ndisk_free_kb=12abc\nenv_lines=-1\ncodex_auth=yes\nuname_m=arm64\nuname_m=evil\n');
    expect(p.home).toBeNull();
    expect(p.diskFreeKb).toBeNull();
    expect(p.envLines).toBeNull();
    expect(p.codexAuth).toBeNull();
    expect(p.unameM).toBe('arm64');
    expect(parseProbeOutput('')).toMatchObject({ complete: false, unameS: null, diskFreeKb: null });
  });

  it('redacts secret-shaped values', () => {
    expect(parseProbeOutput('claude_version=sk-ant-oops\n').claudeVersion).toBe('sk-ant-[REDACTED]');
  });
});

describe('buildProbeScript secrets rules', () => {
  const script = buildProbeScript('~/cf-remote/abc');

  it('never sources anything and never cats a file', () => {
    expect(script).not.toMatch(/\bsource\b/);
    // the POSIX `.` builtin: a dot followed by whitespace at a command position
    expect(script).not.toMatch(/(^|[\s;&|(`])\.\s+\S/m);
    expect(script).not.toMatch(/\bcat\b/);
    expect(script).not.toMatch(/\beval\b/);
  });

  it('only counts token lines in the env file (grep -c), never prints them', () => {
    const envLines = script.split('\n').filter((l) => l.includes('$envf'));
    expect(envLines.length).toBeGreaterThan(0);
    for (const line of envLines) {
      const ok = /envf="\$root\/env"/.test(line) || /\[ -f "\$envf" \]/.test(line) || /stat -[fc] %(Lp|a) "\$envf"/.test(line)
        || /grep -c '\^CLAUDE_CODE_OAUTH_TOKEN=/.test(line);
      expect(ok, line).toBe(true);
    }
    expect(script).not.toMatch(/grep (?!-c)[^|]*CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it('never runs the Darwin /usr/bin/git shim without the Command Line Tools', () => {
    const lines = script.split('\n');
    const shimLine = lines.find((l) => l.includes('set -- /usr/bin/git'));
    expect(shimLine).toMatch(/if \[ -n "\$clt" \]; then set -- \/usr\/bin\/git/);
    expect(shimLine).toMatch(/else set -- \/opt\/homebrew\/bin\/git \/usr\/local\/bin\/git; fi/);
    expect(script).toContain('[ -d /Library/Developer/CommandLineTools ] && clt=1');
    expect(script).toContain('kv git_path "$git_p"');
  });

  it('reports the expanded remote root and the byte length of its orch socket path', () => {
    expect(script).toContain('kv remote_root "$root"');
    expect(script).toMatch(/kv sock_path_bytes "\$\(printf '%s' "\$root\/s\/o\.sock" \| wc -c/);
  });

  it('reads /etc/os-release with sed -n for PRETTY_NAME only', () => {
    const lines = script.split('\n').filter((l) => l.includes('/etc/os-release'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/sed -n 's\/\^PRETTY_NAME=\/\/p' \/etc\/os-release/);
  });

  it('quotes a hostile remote root instead of splicing it', () => {
    expect(remoteRootShellExpr("~/x'; rm -rf ~; '")).toBe(`"$HOME"/'x'\\''; rm -rf ~; '\\'''`);
    expect(remoteRootShellExpr('/abs/$(boom)')).toBe(`'/abs/$(boom)'`);
    expect(remoteRootShellExpr('~')).toBe('"$HOME"');
  });

  it('expands ~ against the probed home', () => {
    expect(expandRemoteRoot('~/cf-remote/a', '/Users/k/')).toBe('/Users/k/cf-remote/a');
    expect(expandRemoteRoot('~/cf-remote/a', null)).toBeNull();
    expect(expandRemoteRoot('/srv/cf', null)).toBe('/srv/cf');
  });
});

describe.skipIf(!posix)('buildProbeScript run by a local /bin/sh (no ssh)', () => {
  let home: string | null = null;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  it('prints only key=value lines, reports token COUNTS and mode, never the token', () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-probe-')));
    const root = join(home, 'cf-remote', 'abc');
    mkdirSync(root, { recursive: true });
    const token = `sk-ant-oat01-${'Q'.repeat(40)}`;
    writeFileSync(join(root, 'env'), `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`);
    chmodSync(join(root, 'env'), 0o600);
    const out = execFileSync('/bin/sh', ['-s'], {
      input: buildProbeScript('~/cf-remote/abc'),
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      timeout: 60_000,
    });
    expect(out).not.toContain('QQQQ');
    for (const line of out.split('\n').filter((l) => l.length > 0)) expect(line).toMatch(/^[a-z_]+=/);
    const p = parseProbeOutput(out);
    expect(p.complete).toBe(true);
    expect(p.home).toBe(home);
    expect(p.envExists).toBe(true);
    expect(p.envMode).toBe('600');
    expect(p.envLines).toBe(1);
    expect(p.envWellformed).toBe(1);
    expect(p.codexAuth).toBe(false);
    expect(p.diskFreeKb).toBeGreaterThan(0);
    expect(p.user).toBe(execFileSync('id', ['-un'], { encoding: 'utf8' }).trim());
    expect(p.remoteRoot).toBe(`${home}/cf-remote/abc`);
    expect(p.sockPathBytes).toBe(Buffer.byteLength(`${home}/cf-remote/abc/s/o.sock`));
    if (p.gitPath !== null) expect(p.gitPath.startsWith('/')).toBe(true);
  }, 60_000);

  it('falls back to $LOGNAME / $TMPDIR / $LANG / $SHELL from the environment', () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-probe-')));
    const out = execFileSync('/bin/sh', ['-s'], {
      input: buildProbeScript('~/cf-remote/abc'),
      encoding: 'utf8',
      env: {
        HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LOGNAME: 'probe-logname', SHELL: '/bin/probe-sh',
        LANG: 'C.UTF-8', TMPDIR: '/probe/tmp/',
      },
      timeout: 60_000,
    });
    const p = parseProbeOutput(out);
    expect(p.complete).toBe(true);
    expect(p.shell).toBe('/bin/probe-sh');
    expect(p.lang).toBe('C.UTF-8');
    // $LOGNAME wins over logname(1), whose getlogin() can name another account.
    expect(p.logname).toBe('probe-logname');
    // Darwin answers DARWIN_USER_TEMP_DIR first; elsewhere $TMPDIR.
    if (process.platform !== 'darwin') expect(p.tmpdir).toBe('/probe/tmp/');
    else expect(p.tmpdir).toMatch(/^\//);
  }, 60_000);
});

describe.skipIf(!posix)('nvm node fallback run by a local /bin/sh', () => {
  let home: string | null = null;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  const pick = (h: string): string => execFileSync('/bin/sh', ['-s'], {
    input: `${NVM_NODE_PICK_LINES.join('\n')}\nprintf '%s' "$nvm_node"\n`,
    encoding: 'utf8',
    env: { HOME: h, PATH: '/usr/bin:/bin' },
  });

  function nvmDir(h: string, version: string, executable = true): void {
    const bin = join(h, '.nvm', 'versions', 'node', version, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), '#!/bin/sh\necho x\n');
    chmodSync(join(bin, 'node'), executable ? 0o755 : 0o644);
  }

  it('picks the numerically highest major, then minor, then patch (never the lexically last)', () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-nvm-')));
    for (const v of ['v9.11.2', 'v22.3.0', 'v22.12.1', 'v22.12.0', 'v18.20.4', 'vfoo', 'v23.1']) nvmDir(home, v);
    nvmDir(home, 'v99.0.0', false); // not executable: ignored
    expect(pick(home)).toBe(join(home, '.nvm/versions/node/v22.12.1/bin/node'));
    nvmDir(home, 'v22.12.10-nightly');
    expect(pick(home)).toBe(join(home, '.nvm/versions/node/v22.12.10-nightly/bin/node'));
  });

  it('is empty without an nvm install', () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-nvm-')));
    expect(pick(home)).toBe('');
  });
});

describe('toolchain probe section', () => {
  it('parses the toolchain keys', () => {
    const p = parseProbeOutput(`tc_hash=${TC_HASH}\ntc_manifest=1\ntc_manifest_hash=1\ntc_claude_size=10\ntc_mcp_size=20\ntc_codex_size=30\nprobe_done=1\n`);
    expect(p).toMatchObject({ tcHash: TC_HASH, tcManifest: true, tcManifestHash: true, tcClaudeSize: 10, tcMcpSize: 20, tcCodexSize: 30 });
    expect(parseProbeOutput('probe_done=1\n')).toMatchObject({ tcHash: null, tcManifest: null, tcClaudeSize: null });
  });

  it('is absent without a spec, present (hash single-quoted) with one; never checksums', () => {
    expect(buildProbeScript('~/cf-remote/abc')).not.toContain('tc_hash');
    const script = buildProbeScript('~/cf-remote/abc', { toolchain: { hash: TC_HASH, codexBinRel: TC_CODEX_REL } });
    expect(script).toContain(`tc_h='${TC_HASH}'`);
    expect(script).toContain(`'${TC_CODEX_REL}'`);
    expect(script).not.toMatch(/shasum|sha256sum/);
    expect(script.indexOf('tc_hash')).toBeLessThan(script.indexOf('probe_done'));
  });

  it('refuses a hash or codex path that is not of the expected shape (nothing reaches the script)', () => {
    for (const spec of [
      { hash: `${TC_HASH.slice(1)}'`, codexBinRel: null },
      { hash: TC_HASH.toUpperCase(), codexBinRel: null },
      { hash: TC_HASH, codexBinRel: "codex/x'; rm -rf ~; '/bin/codex" },
      { hash: TC_HASH, codexBinRel: 'codex/../bin/codex' },
      { hash: TC_HASH, codexBinRel: '/etc/passwd' },
    ]) {
      expect(() => buildToolchainProbeFragment(spec)).toThrow(InvalidToolchainProbeSpecError);
    }
  });
});

describe.skipIf(!posix)('toolchain + prelaunch probes run by a local /bin/sh (no ssh)', () => {
  let home: string | null = null;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  function install(root: string, opts: { hash?: string; claude?: string } = {}): void {
    const dir = join(root, 'toolchain', TC_HASH);
    mkdirSync(join(dir, 'codex', 'aarch64-apple-darwin', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'claude'), opts.claude ?? 'x'.repeat(1234));
    writeFileSync(join(dir, 'cyboflowMcpServer.js'), 'y'.repeat(56));
    writeFileSync(join(dir, 'codex', 'aarch64-apple-darwin', 'bin', 'codex'), 'z'.repeat(7));
    const manifest: ToolchainManifest = {
      layout: 1, hash: opts.hash ?? TC_HASH, arch: 'arm64', claudeVersion: null, codexVersion: null, codexTarget: null, files: [],
    };
    writeFileSync(join(dir, 'manifest.json'), serializeToolchainManifest(manifest));
  }

  const run = (script: string): string => execFileSync('/bin/sh', ['-s'], {
    input: script, encoding: 'utf8', env: { HOME: home ?? '', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 60_000,
  });

  it('reports manifest presence, the hash match and the three sizes', () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-probe-')));
    install(join(home, 'cf-remote', 'abc'));
    const p = parseProbeOutput(run(buildToolchainProbeScript('~/cf-remote/abc', { hash: TC_HASH, codexBinRel: TC_CODEX_REL })));
    expect(p).toMatchObject({
      complete: true, tcHash: TC_HASH, tcManifest: true, tcManifestHash: true, tcClaudeSize: 1234, tcMcpSize: 56, tcCodexSize: 7,
    });
  });

  it('a manifest naming another hash reads as not matching; no install reads as absent', () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-probe-')));
    install(join(home, 'cf-remote', 'abc'), { hash: 'd'.repeat(64) });
    const spec = { hash: TC_HASH, codexBinRel: null };
    expect(parseProbeOutput(run(buildToolchainProbeScript('~/cf-remote/abc', spec)))).toMatchObject({ tcManifest: true, tcManifestHash: false });
    expect(parseProbeOutput(run(buildToolchainProbeScript('~/cf-remote/other', spec))))
      .toMatchObject({ complete: true, tcManifest: false, tcManifestHash: null, tcClaudeSize: null });
  });

  it('the full probe carries the same section', () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-probe-')));
    install(join(home, 'cf-remote', 'abc'));
    const p = parseProbeOutput(run(buildProbeScript('~/cf-remote/abc', { toolchain: { hash: TC_HASH, codexBinRel: null } })));
    expect(p).toMatchObject({ complete: true, tcManifest: true, tcManifestHash: true, tcClaudeSize: 1234, tcCodexSize: null });
  }, 60_000);

  it('prelaunch probe: home, env shape, node and toolchain only — never the token', () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-probe-')));
    const root = join(home, 'cf-remote', 'abc');
    install(root);
    const token = `sk-ant-oat01-${'Q'.repeat(40)}`;
    writeFileSync(join(root, 'env'), `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`);
    chmodSync(join(root, 'env'), 0o600);
    const out = run(buildPrelaunchProbeScript('~/cf-remote/abc', {
      toolchain: { hash: TC_HASH, codexBinRel: TC_CODEX_REL }, nodePath: process.execPath,
    }));
    expect(out).not.toContain('QQQQ');
    const p = parseProbeOutput(out);
    expect(p).toMatchObject({
      complete: true, home, envExists: true, envMode: '600', envLines: 1, envWellformed: 1,
      nodePath: process.execPath, tcManifest: true, tcManifestHash: true, tcClaudeSize: 1234,
    });
    expect(p.nodeVersion).toMatch(/^v\d+/);
    expect(p.gitVersion).toBeNull(); // not part of the trimmed probe
  });
});
