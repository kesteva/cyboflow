import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FORWARD_PREP_PROGRAM } from '../sshTransport';

// Runs the REAL remote program under the local /bin/sh: on macOS that is the same BSD userland as a remote Mac,
// which is what caught `chmod --` (BSD chmod has no end-of-options marker).
describe('FORWARD_PREP_PROGRAM under the local /bin/sh', () => {
  it('creates the socket dir 0700 and removes a stale socket file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cf-fwd-'));
    const dir = path.join(root, 's');
    const sock = path.join(dir, 'o.sock');
    execFileSync('/bin/sh', ['-c', FORWARD_PREP_PROGRAM, 'sh', dir, sock]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    writeFileSync(sock, 'stale');
    execFileSync('/bin/sh', ['-c', FORWARD_PREP_PROGRAM, 'sh', dir, sock]);
    expect(existsSync(sock)).toBe(false);
  });
});
