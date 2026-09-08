/**
 * findExecutableInPath: which candidate wins in a directory holding several
 * spellings of the same tool.
 *
 * These run against a real temp directory, not a mocked fs. The bug they pin
 * is invisible to a mock: npm's cmd-shim writes an extensionless `#!/bin/sh`
 * script beside `<name>.cmd`, and on Windows fs.accessSync(X_OK) succeeds for
 * any file that exists, so the bare name used to win and the caller got a
 * script Windows cannot run.
 *
 * The platform is injected, so the win32 order is checked on any host.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findExecutableInPath } from './shellPath';

let dir: string;

/** Write one PATH entry. Mode 0o755 matters on POSIX; Windows ignores it. */
function place(name: string, body: string): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, body, { mode: 0o755 });
  fs.chmodSync(full, 0o755);
  return full;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpath-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('findExecutableInPath — candidate order', () => {
  it('win32: prefers the .cmd shim over the extensionless sh script npm writes beside it', () => {
    place('mytool', '#!/bin/sh\nexec node "$0.js"\n');
    const cmd = place('mytool.cmd', '@echo off\r\n');

    expect(findExecutableInPath('mytool', 'win32', dir)).toBe(cmd);
  });

  it('win32: prefers the native .exe over both the .cmd shim and the bare name', () => {
    place('mytool', '#!/bin/sh\n');
    place('mytool.cmd', '@echo off\r\n');
    const exe = place('mytool.exe', 'MZ');

    expect(findExecutableInPath('mytool', 'win32', dir)).toBe(exe);
  });

  it('win32: finds a .bat shim when there is no .exe or .cmd', () => {
    const bat = place('mytool.bat', '@echo off\r\n');

    expect(findExecutableInPath('mytool', 'win32', dir)).toBe(bat);
  });

  it('win32: still falls back to the bare name when nothing carries a suffix', () => {
    const bare = place('mytool', 'MZ');

    expect(findExecutableInPath('mytool', 'win32', dir)).toBe(bare);
  });

  it('posix: takes the bare name and never looks at a .cmd sibling', () => {
    const bare = place('mytool', '#!/bin/sh\n');
    place('mytool.cmd', '@echo off\r\n');

    expect(findExecutableInPath('mytool', 'darwin', dir)).toBe(bare);
  });

  it('returns null when the directory holds nothing by that name', () => {
    expect(findExecutableInPath('missingtool', 'win32', dir)).toBeNull();
    expect(findExecutableInPath('missingtool', 'darwin', dir)).toBeNull();
  });
});
