import { describe, it, expect } from 'vitest';
import { parseProbeOutput, type ProbeRecord } from '../remoteProbe';
import {
  ARRIVES_LATER_DETAIL,
  CHECK_TIER_IMPACT,
  DISK_FAIL_BELOW_KB,
  DISK_WARN_BELOW_KB,
  checkArch,
  checkClaudeAuth,
  checkCodexAuth,
  checkDiskFree,
  checkGit,
  checkMcpRoundtrip,
  checkNode22,
  checkOsVersion,
  checkRepoRootTcc,
  checkSdkBinaryHash,
  checkSleepSettings,
  checkSshReachable,
  majorVersion,
} from '../preflight/checks';
import { PREFLIGHT_CHECK_IDS } from '../../../../../shared/types/hosts';

function probe(over: Partial<ProbeRecord> = {}): ProbeRecord {
  return { ...parseProbeOutput('uname_s=Darwin\nhome=/Users/k\nprobe_done=1\n'), ...over };
}
const linux = (over: Partial<ProbeRecord> = {}): ProbeRecord => probe({ unameS: 'Linux', ...over });

describe('tier impact table', () => {
  it('covers every check id and matches the spec', () => {
    expect(Object.keys(CHECK_TIER_IMPACT).sort()).toEqual([...PREFLIGHT_CHECK_IDS].sort());
    expect(CHECK_TIER_IMPACT['ssh-reachable']).toBe('blocks-cli');
    for (const id of ['arch', 'git', 'node22', 'sdk-binary-hash', 'mcp-roundtrip', 'repo-root-tcc'] as const) {
      expect(CHECK_TIER_IMPACT[id]).toBe('blocks-full');
    }
    for (const id of ['os-version', 'claude-auth', 'codex-auth', 'sleep-settings', 'disk-free'] as const) {
      expect(CHECK_TIER_IMPACT[id]).toBe('none');
    }
  });
});

describe('checkSshReachable', () => {
  it('passes when connected and carries the classified detail/fix on failure', () => {
    expect(checkSshReachable(null)).toMatchObject({ status: 'pass', tierImpact: 'blocks-cli' });
    expect(checkSshReachable({ kind: 'auth', detail: 'Permission denied', fix: 'ssh-copy-id box' }))
      .toMatchObject({ status: 'fail', detail: 'Permission denied', fix: 'ssh-copy-id box', tierImpact: 'blocks-cli' });
  });
});

describe('checkArch', () => {
  it.each(['arm64', 'aarch64', 'x86_64'])('%s passes', (m) => {
    expect(checkArch(probe({ unameM: m })).status).toBe('pass');
  });
  it('fails on others and when unknown', () => {
    expect(checkArch(probe({ unameM: 'armv7l' }))).toMatchObject({ status: 'fail', tierImpact: 'blocks-full' });
    expect(checkArch(probe({ unameM: null })).status).toBe('fail');
  });
});

describe('checkOsVersion', () => {
  it('Darwin >= 13 passes, 12 warns (boundary), unreadable warns', () => {
    expect(checkOsVersion(probe({ osVersion: '13.0' })).status).toBe('pass');
    expect(checkOsVersion(probe({ osVersion: '26.6' })).status).toBe('pass');
    expect(checkOsVersion(probe({ osVersion: '12.7.6' })).status).toBe('warn');
    expect(checkOsVersion(probe({ osVersion: null })).status).toBe('warn');
  });
  it('Linux passes with its pretty name; unknown systems warn', () => {
    expect(checkOsVersion(linux({ osVersion: 'Ubuntu 24.04 LTS' }))).toMatchObject({ status: 'pass', detail: 'Ubuntu 24.04 LTS' });
    expect(checkOsVersion(probe({ unameS: 'FreeBSD' })).status).toBe('warn');
    expect(checkOsVersion(probe({ unameS: null })).status).toBe('warn');
  });
  it('is informational', () => {
    expect(checkOsVersion(probe({ osVersion: '11.0' })).tierImpact).toBe('none');
  });
});

describe('checkGit', () => {
  it('passes with a version', () => {
    expect(checkGit(probe({ gitVersion: 'git version 2.39.5' }))).toMatchObject({ status: 'pass', detail: 'git version 2.39.5' });
  });
  it('Darwin without Command Line Tools fails with xcode-select --install', () => {
    expect(checkGit(probe({ xcodeClt: false }))).toMatchObject({ status: 'fail', fix: 'xcode-select --install', tierImpact: 'blocks-full' });
  });
  it('Linux without git fails with a package-manager fix', () => {
    expect(checkGit(linux()).fix).toMatch(/package manager/);
  });
});

describe('checkNode22', () => {
  it('22 passes (boundary), 21 fails, missing fails, Darwin fix is brew', () => {
    expect(checkNode22(probe({ nodeVersion: 'v22.0.0', nodePath: '/n' })).status).toBe('pass');
    expect(checkNode22(probe({ nodeVersion: 'v24.12.0' })).status).toBe('pass');
    expect(checkNode22(probe({ nodeVersion: 'v21.7.3' }))).toMatchObject({ status: 'fail', fix: 'brew install node@22' });
    expect(checkNode22(probe())).toMatchObject({ status: 'fail', tierImpact: 'blocks-full' });
    expect(checkNode22(linux()).fix).toMatch(/nodejs\.org/);
  });
  it('majorVersion parses leading integers only', () => {
    expect(majorVersion('v22.3.1')).toBe(22);
    expect(majorVersion('15.1')).toBe(15);
    expect(majorVersion('garbage')).toBeNull();
    expect(majorVersion(null)).toBeNull();
  });
});

describe('arrive-later checks', () => {
  it('sdk-binary-hash and mcp-roundtrip are skipped and block full', () => {
    for (const c of [checkSdkBinaryHash(), checkMcpRoundtrip()]) {
      expect(c).toMatchObject({ status: 'skipped', detail: ARRIVES_LATER_DETAIL, tierImpact: 'blocks-full' });
    }
  });
});

describe('checkClaudeAuth', () => {
  const root = '~/cf-remote/abc';
  it('passes for an existing 600 file with exactly one well-formed line', () => {
    expect(checkClaudeAuth(probe({ envExists: true, envMode: '600', envLines: 1, envWellformed: 1 }), root))
      .toMatchObject({ status: 'pass', detail: 'Token present; validated when remote flows arrive', tierImpact: 'none' });
  });
  it('missing file warns with the setup-token fix naming the env path', () => {
    const c = checkClaudeAuth(probe({ envExists: false }), root);
    expect(c.status).toBe('warn');
    expect(c.fix).toMatch(/claude setup-token/);
    expect(c.fix).toMatch(/~\/cf-remote\/abc\/env/);
    expect(c.fix).toMatch(/chmod 600/);
  });
  it('bad mode warns with chmod 600', () => {
    expect(checkClaudeAuth(probe({ envExists: true, envMode: '644', envLines: 1, envWellformed: 1 }), root))
      .toMatchObject({ status: 'warn', fix: 'chmod 600 ~/cf-remote/abc/env' });
  });
  it('malformed (zero, two, or not sk-ant) warns', () => {
    for (const [lines, wf] of [[0, 0], [2, 2], [1, 0]] as const) {
      const c = checkClaudeAuth(probe({ envExists: true, envMode: '600', envLines: lines, envWellformed: wf }), root);
      expect(c.status).toBe('warn');
      expect(c.detail).toMatch(/exactly one CLAUDE_CODE_OAUTH_TOKEN=sk-ant-/);
    }
  });
});

describe('checkCodexAuth', () => {
  it('passes when signed in, else warns with codex login', () => {
    expect(checkCodexAuth(probe({ codexAuth: true })).status).toBe('pass');
    expect(checkCodexAuth(probe({ codexAuth: false }))).toMatchObject({ status: 'warn', fix: 'codex login', tierImpact: 'none' });
    expect(checkCodexAuth(probe({ codexAuth: null })).status).toBe('warn');
  });
});

describe('checkSleepSettings', () => {
  it('Darwin: sleep 0 or prevented passes; otherwise warns (never fails)', () => {
    expect(checkSleepSettings(probe({ sleepValue: '0' })).status).toBe('pass');
    expect(checkSleepSettings(probe({ sleepValue: '1', sleepPrevented: true })).status).toBe('pass');
    expect(checkSleepSettings(probe({ sleepValue: '10', sleepPrevented: false })))
      .toMatchObject({ status: 'warn', fix: 'sudo pmset -a sleep 0', tierImpact: 'none' });
    expect(checkSleepSettings(probe()).status).toBe('warn');
  });
  it('Linux is not applicable', () => {
    expect(checkSleepSettings(linux()).status).toBe('na');
  });
});

describe('checkRepoRootTcc', () => {
  it.each([
    ['~/Desktop/cf', '/Users/k'],
    ['~/Documents', '/Users/k'],
    ['/Users/k/Downloads/x', '/Users/k'],
    ['/Users/k/Library/Mobile Documents/com~apple~CloudDocs/cf', '/Users/k/'],
  ])('%s fails', (root, home) => {
    expect(checkRepoRootTcc(root, home)).toMatchObject({ status: 'fail', tierImpact: 'blocks-full' });
  });
  it.each([
    ['~/cf-remote/abc', '/Users/k'],
    ['/Users/k/cf-remote/abc', '/Users/k'],
    ['/Users/k/DesktopStuff/cf', '/Users/k'],
    ['/srv/Desktop/cf', '/Users/k'],
    ['/Users/k/Documents', null],
  ])('%s passes', (root, home) => {
    expect(checkRepoRootTcc(root, home).status).toBe('pass');
  });
});

describe('checkDiskFree', () => {
  it('boundaries: < 2 GiB fail (blocks full), < 10 GiB warn, else pass', () => {
    expect(checkDiskFree(probe({ diskFreeKb: DISK_FAIL_BELOW_KB - 1 }))).toMatchObject({ status: 'fail', tierImpact: 'blocks-full' });
    expect(checkDiskFree(probe({ diskFreeKb: DISK_FAIL_BELOW_KB }))).toMatchObject({ status: 'warn', tierImpact: 'none' });
    expect(checkDiskFree(probe({ diskFreeKb: DISK_WARN_BELOW_KB - 1 })).status).toBe('warn');
    expect(checkDiskFree(probe({ diskFreeKb: DISK_WARN_BELOW_KB }))).toMatchObject({ status: 'pass', tierImpact: 'none' });
    expect(checkDiskFree(probe({ diskFreeKb: 0 })).status).toBe('fail');
    expect(checkDiskFree(probe({ diskFreeKb: null })).status).toBe('warn');
  });
  it('reports GiB', () => {
    expect(checkDiskFree(probe({ diskFreeKb: 20 * 1024 * 1024 })).detail).toBe('20.0 GiB free');
  });
});
