/**
 * Project fingerprints (ruling D3): one canonical form per repo whatever the
 * transport, the subpath kept, long forms hashed, and — the invariant — no URL
 * credential ever survives into a fingerprint.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_FINGERPRINT_LENGTH,
  canonicalFingerprint,
  fingerprintProject,
  isLocalFingerprint,
  localFingerprint,
  normalizeRemoteUrl,
  wireFingerprint,
  type GitRunner,
} from '../fingerprint';

describe('normalizeRemoteUrl', () => {
  it.each([
    ['https://github.com/kesteva/cyboflow.git', 'github.com/kesteva/cyboflow'],
    ['https://github.com/kesteva/cyboflow', 'github.com/kesteva/cyboflow'],
    ['https://github.com/kesteva/cyboflow/', 'github.com/kesteva/cyboflow'],
    ['http://GitHub.COM/kesteva/cyboflow.git', 'github.com/kesteva/cyboflow'],
    ['git@github.com:kesteva/cyboflow.git', 'github.com/kesteva/cyboflow'],
    ['github.com:kesteva/cyboflow', 'github.com/kesteva/cyboflow'],
    ['ssh://git@github.com/kesteva/cyboflow.git', 'github.com/kesteva/cyboflow'],
    ['ssh://git@github.com:22/kesteva/cyboflow.git', 'github.com/kesteva/cyboflow'],
    ['git+ssh://git@github.com/kesteva/cyboflow', 'github.com/kesteva/cyboflow'],
    ['git://github.com/kesteva/cyboflow.git', 'github.com/kesteva/cyboflow'],
    ['https://gitlab.example.com:8443/group/sub/repo.git?ref=x#frag', 'gitlab.example.com/group/sub/repo'],
    ['  https://github.com/kesteva/cyboflow.git\n', 'github.com/kesteva/cyboflow'],
    ['git@ssh.dev.azure.com:v3/org/proj/repo', 'ssh.dev.azure.com/v3/org/proj/repo'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeRemoteUrl(raw)).toBe(expected);
  });

  it('keeps path case (only the host is case-insensitive)', () => {
    expect(normalizeRemoteUrl('https://github.com/Kesteva/Cyboflow')).toBe('github.com/Kesteva/Cyboflow');
  });

  it.each([
    '',
    '/Users/me/repos/cyboflow',
    '../cyboflow',
    './a:b',
    'C:\\repos\\cyboflow',
    'file:///Users/me/repos/cyboflow.git',
    'https://github.com',
    'https://github.com/',
    'not a url',
  ])('no fingerprint for a local or unparseable remote: %j', (raw) => {
    expect(normalizeRemoteUrl(raw)).toBeNull();
  });
});

describe('credential stripping (invariant)', () => {
  const SECRETS = ['hunter2', 'ghp_SECRETtoken123', 'oauth2', 'x-access-token', 'p@ss', 'me'];
  const urls = [
    'https://me:hunter2@github.com/o/r.git',
    'https://ghp_SECRETtoken123@github.com/o/r.git',
    'https://oauth2:ghp_SECRETtoken123@gitlab.com/o/r.git',
    'https://x-access-token:ghp_SECRETtoken123@github.com/o/r',
    'https://me:p@ss@github.com/o/r.git',
    'https://me:hunter2@github.com:443/o/r.git',
    'ssh://me:hunter2@github.com/o/r.git',
    'me@github.com:o/r.git',
    'https://me:hunter2@github.com/o/r.git?token=ghp_SECRETtoken123',
    'https://me:hun/ter2@github.com/o/r.git',
  ];

  it.each(urls)('%s carries no credential into the fingerprint', (url) => {
    const normalized = normalizeRemoteUrl(url);
    for (const fp of [normalized, normalized && canonicalFingerprint(normalized, 'sub/')]) {
      if (fp === null) continue;
      expect(fp).not.toContain('@');
      for (const secret of SECRETS) expect(fp).not.toContain(secret);
    }
  });

  it('an unencoded slash in a password yields no fingerprint at all', () => {
    expect(normalizeRemoteUrl('https://me:hun/ter2@github.com/o/r.git')).toBeNull();
  });

  it('fingerprintProject never sends the raw remote, whatever git returns', async () => {
    const git: GitRunner = async (_cwd, args) =>
      args[0] === 'remote' ? 'https://me:ghp_SECRETtoken123@github.com/o/r.git\n' : '\n';
    const fp = await fingerprintProject('/p', git);
    expect(fp).toEqual({ canonical: 'github.com/o/r', wire: 'github.com/o/r' });
    expect(JSON.stringify(fp)).not.toContain('SECRET');
  });
});

describe('canonical + wire forms', () => {
  it('adds the subpath without slashes; the repo root has none', () => {
    expect(canonicalFingerprint('github.com/o/r', '')).toBe('github.com/o/r');
    expect(canonicalFingerprint('github.com/o/r', '\n')).toBe('github.com/o/r');
    expect(canonicalFingerprint('github.com/o/r', 'packages/app/\n')).toBe('github.com/o/r#packages/app');
    expect(canonicalFingerprint('github.com/o/r', 'packages\\app\\')).toBe('github.com/o/r#packages/app');
  });

  it('sends a form up to 128 chars as is, and hashes a longer one', () => {
    const fits = `github.com/${'a'.repeat(MAX_FINGERPRINT_LENGTH - 'github.com/'.length)}`;
    expect(fits).toHaveLength(MAX_FINGERPRINT_LENGTH);
    expect(wireFingerprint(fits)).toBe(fits);
    const long = `${fits}b`;
    const wire = wireFingerprint(long);
    expect(wire).toBe(`sha256:${createHash('sha256').update(long).digest('hex')}`);
    expect(wire.length).toBeLessThanOrEqual(MAX_FINGERPRINT_LENGTH);
  });

  it('mints distinct local fingerprints', () => {
    const a = localFingerprint();
    expect(a).toMatch(/^local:[0-9a-f-]{36}$/);
    expect(localFingerprint()).not.toBe(a);
    expect(isLocalFingerprint(a)).toBe(true);
    expect(isLocalFingerprint('github.com/o/r')).toBe(false);
    expect(isLocalFingerprint(null)).toBe(false);
  });
});

describe('fingerprintProject', () => {
  const runner = (remote: string | Error, prefix = ''): { git: GitRunner; calls: string[][] } => {
    const calls: string[][] = [];
    const git: GitRunner = async (_cwd, args) => {
      calls.push(args);
      if (args[0] === 'remote') {
        if (remote instanceof Error) throw remote;
        return `${remote}\n`;
      }
      return `${prefix}\n`;
    };
    return { git, calls };
  };

  it('reads origin and the subpath', async () => {
    const { git, calls } = runner('git@github.com:o/r.git', 'apps/web/');
    expect(await fingerprintProject('/repo/apps/web', git)).toEqual({ canonical: 'github.com/o/r#apps/web', wire: 'github.com/o/r#apps/web' });
    expect(calls).toEqual([['remote', 'get-url', 'origin'], ['rev-parse', '--show-prefix']]);
  });

  it('is null with no origin, outside a repo, or with a local-path origin', async () => {
    expect(await fingerprintProject('/p', runner(new Error('No such remote')).git)).toBeNull();
    expect(await fingerprintProject('/p', runner('/srv/git/r.git').git)).toBeNull();
  });
});
