/**
 * Test helper: symlink creation that works unprivileged on Windows.
 *
 * POSIX lets any user create file and directory symlinks. On Windows, creating a
 * symlink requires elevation or Developer Mode, but a DIRECTORY junction
 * (`fs.symlinkSync(..., 'junction')`) is creatable by an unprivileged user and
 * behaves like a directory symlink for the properties tests care about:
 * `fs.realpathSync` resolves through it, `lstat` reports `isSymbolicLink()`,
 * and a readdir entry surfaces as a link.
 *
 *  - `createDirSymlink`  — directory links: junction on win32, symlink elsewhere.
 *  - `fileSymlinksNeedPrivilege` — true where a FILE symlink cannot be created
 *    unprivileged (win32). Tests whose subject is specifically a symlinked FILE
 *    gate with `it.skipIf(fileSymlinksNeedPrivilege)(...)` — there is no
 *    unprivileged portable stand-in for a file symlink.
 */
import { symlinkSync } from 'node:fs';

export const fileSymlinksNeedPrivilege = process.platform === 'win32';

export function createDirSymlink(target: string, linkPath: string): void {
  if (process.platform === 'win32') {
    symlinkSync(target, linkPath, 'junction');
  } else {
    symlinkSync(target, linkPath, 'dir');
  }
}
