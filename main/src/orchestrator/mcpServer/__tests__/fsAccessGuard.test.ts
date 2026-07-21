/**
 * Pure-helper unit tests for fsAccessGuard — the side-effect-free enforcement
 * primitives behind the global-agent filesystem tools. These assert the two
 * security-critical guarantees in isolation (separator-boundary containment,
 * secret deny-list) plus the glob/binary helpers. The handler-level integration
 * (scope resolution, symlink-escape, caps) lives in mcpFsTools.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  isPathWithinRoots,
  isSecretPath,
  bufferLooksBinary,
  compileBasenameGlob,
  matchesBasenameGlob,
} from '../fsAccessGuard';

describe('isPathWithinRoots — separator-boundary containment', () => {
  it('accepts the root itself and any descendant', () => {
    expect(isPathWithinRoots('/a/b', ['/a/b'])).toBe(true);
    expect(isPathWithinRoots('/a/b/c/d.ts', ['/a/b'])).toBe(true);
  });

  it('rejects a sibling that merely shares a name prefix (/a/bc is NOT inside /a/b)', () => {
    expect(isPathWithinRoots('/a/bc', ['/a/b'])).toBe(false);
    expect(isPathWithinRoots('/a/bcd/file', ['/a/b'])).toBe(false);
  });

  it('rejects a path above the root and an empty root set', () => {
    expect(isPathWithinRoots('/a', ['/a/b'])).toBe(false);
    expect(isPathWithinRoots('/a/b', [])).toBe(false);
  });

  it('accepts when inside any one of several roots', () => {
    expect(isPathWithinRoots('/y/z/f', ['/a/b', '/y/z'])).toBe(true);
  });
});

describe('isSecretPath — deny-list', () => {
  it('denies a secret directory component anywhere in the chain', () => {
    for (const p of [
      '/home/u/.ssh/id_rsa',
      '/home/u/.aws/config',
      '/proj/.gnupg/pubring.kbx',
      '/proj/.kube/config',
      '/proj/.docker/config.json',
    ]) {
      expect(isSecretPath(p)).toBe(true);
    }
  });

  it('denies dotenv, key, and credential basenames (case-insensitive)', () => {
    for (const p of [
      '/proj/.env',
      '/proj/.env.local',
      '/proj/.env.production',
      '/proj/server.pem',
      '/proj/private.KEY',
      '/proj/cert.p12',
      '/proj/cert.pfx',
      '/proj/id_rsa',
      '/proj/id_ed25519.pub',
      '/proj/id_ecdsa',
      '/proj/id_dsa',
      '/proj/.netrc',
      '/proj/.npmrc',
      '/proj/.pgpass',
      '/proj/.htpasswd',
      '/proj/credentials',
      '/proj/CREDENTIALS',
    ]) {
      expect(isSecretPath(p)).toBe(true);
    }
  });

  it('allows ordinary source/config files', () => {
    for (const p of [
      '/proj/src/index.ts',
      '/proj/README.md',
      '/proj/package.json',
      '/proj/env.ts', // not `.env`
      '/proj/keyboard.ts', // not `*.key`
    ]) {
      expect(isSecretPath(p)).toBe(false);
    }
  });
});

describe('bufferLooksBinary', () => {
  it('is true when a NUL byte is present, false otherwise', () => {
    expect(bufferLooksBinary(Buffer.from('hello world'))).toBe(false);
    expect(bufferLooksBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
  });
});

describe('compileBasenameGlob / matchesBasenameGlob', () => {
  it('null glob (empty) matches everything', () => {
    const re = compileBasenameGlob('');
    expect(re).toBeNull();
    expect(matchesBasenameGlob('anything.xyz', re)).toBe(true);
  });

  it('*.ts matches .ts basenames only', () => {
    const re = compileBasenameGlob('*.ts');
    expect(matchesBasenameGlob('index.ts', re)).toBe(true);
    expect(matchesBasenameGlob('index.tsx', re)).toBe(false);
    expect(matchesBasenameGlob('index.js', re)).toBe(false);
  });

  it('a literal dot is not treated as a regex wildcard', () => {
    const re = compileBasenameGlob('a.b');
    expect(matchesBasenameGlob('a.b', re)).toBe(true);
    expect(matchesBasenameGlob('axb', re)).toBe(false);
  });

  it('? matches a single char', () => {
    const re = compileBasenameGlob('f?o.ts');
    expect(matchesBasenameGlob('foo.ts', re)).toBe(true);
    expect(matchesBasenameGlob('fo.ts', re)).toBe(false);
  });
});
