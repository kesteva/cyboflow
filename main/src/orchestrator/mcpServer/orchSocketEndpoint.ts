/**
 * orchSocketEndpoint — the platform-aware address of the orch IPC endpoint.
 *
 * POSIX gets the Unix-domain socket path the caller computed. Windows cannot
 * bind AF_UNIX there without elevation (EACCES), so the endpoint becomes a
 * NAMED PIPE, which Node's `net` treats transparently — server and clients are
 * unchanged. The pipe namespace is machine-global, so the name carries two
 * discriminators: the username, or two accounts would collide on one pipe; and
 * a hash of the socket path, or the app's parallel per-kind instances would
 * share a pipe and the second kind's MCP subprocesses would write through the
 * first kind's database.
 *
 * Named pipes carry no 0700/0600 modes, so the per-user, per-data-dir name plus
 * the run-scoped bearer tokens (orchAuthToken.ts) are the Windows access
 * control, and tightenMode is a warn-only no-op there by design.
 *
 * Standalone-typecheck invariant (mirrors orchSocketServer.ts): no imports from
 * 'electron', 'better-sqlite3', or main/src/services/*.
 */
import { createHash } from 'node:crypto';
import * as os from 'os';

export function orchSocketEndpoint(
  posixPath: string,
  platform: NodeJS.Platform = process.platform,
  // Injected by tests: a real account name is usually already sanitary, so
  // reading the host's would leave the sanitize step below unexercised.
  username: string = os.userInfo().username
): string {
  if (platform !== 'win32') {
    return posixPath;
  }
  const user = (username || 'default').replace(/[^A-Za-z0-9_-]+/g, '-');
  // First 8 hex: enough to separate a handful of app kinds, and not a secret.
  const kind = createHash('sha256').update(posixPath).digest('hex').slice(0, 8);
  return `\\\\.\\pipe\\cyboflow-${user}-${kind}-orch`;
}
