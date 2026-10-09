import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildProbeScript,
  expandRemoteRoot,
  parseProbeOutput,
  remoteRootShellExpr,
} from '../remoteProbe';

const posix = process.platform !== 'win32';

const FULL = [
  'home=/Users/k',
  'uname_s=Darwin',
  'uname_m=arm64',
  'os_version=15.1',
  'xcode_clt=1',
  'git_version=git version 2.39.5 (Apple Git-154)',
  'node_path=/opt/homebrew/bin/node',
  'node_version=v22.11.0',
  'claude_path=/Users/k/.local/bin/claude',
  'claude_version=2.1.290 (Claude Code)',
  'codex_auth=0',
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
  }, 60_000);
});
