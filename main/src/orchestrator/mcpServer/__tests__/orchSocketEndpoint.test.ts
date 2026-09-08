/**
 * orchSocketEndpoint unit tests — the pipe name is the whole Windows contract
 * of this module (see the module header for the two load-bearing properties:
 * per-kind separation and POSIX passthrough). `platform` and `username` are
 * injected seams, so the win32 branch runs from any host and the sanitize step
 * is actually reached: a real account name is usually already sanitary.
 *
 * Expected names are literals. Recomputing the hash here with the production
 * expression would make any change to it agree with itself. No electron /
 * better-sqlite3 imports — the standalone-typecheck invariant holds.
 *
 * os's own exports are non-configurable, so vi.spyOn can't redefine them
 * directly — wrap the real implementation in vi.fn() instead (the same
 * pattern nodeFinder.test.ts uses for fs).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, userInfo: vi.fn(actual.userInfo) };
});

import * as os from 'os';
import { orchSocketEndpoint } from '../orchSocketEndpoint';

const STABLE = 'C:/Users/dev/.cyboflow/sockets/orch.sock';
const DEV = 'C:/Users/dev/.cyboflow-dev/sockets/orch.sock';

describe('orchSocketEndpoint', () => {
  beforeEach(() => {
    vi.mocked(os.userInfo).mockClear();
  });

  describe('win32', () => {
    it('names a pipe from the user slug and an 8-hex hash of the socket path', () => {
      expect(orchSocketEndpoint(STABLE, 'win32', 'ada')).toBe(
        '\\\\.\\pipe\\cyboflow-ada-1276b450-orch',
      );
    });

    it('is stable for the same posixPath', () => {
      expect(orchSocketEndpoint(DEV, 'win32', 'ada')).toBe(
        orchSocketEndpoint(DEV, 'win32', 'ada'),
      );
    });

    it('differs per kind — parallel instances must not share a pipe', () => {
      // Same account, different data dir: the hash is the whole discriminator.
      expect(orchSocketEndpoint(STABLE, 'win32', 'ada')).toBe(
        '\\\\.\\pipe\\cyboflow-ada-1276b450-orch',
      );
      expect(orchSocketEndpoint(DEV, 'win32', 'ada')).toBe(
        '\\\\.\\pipe\\cyboflow-ada-51fc4029-orch',
      );
    });

    it('differs per user — two Windows accounts must not share a pipe', () => {
      expect(orchSocketEndpoint(STABLE, 'win32', 'ada')).not.toBe(
        orchSocketEndpoint(STABLE, 'win32', 'grace'),
      );
    });

    it('replaces every run of characters outside [A-Za-z0-9_-]', () => {
      // A domain account with a space and a non-ASCII letter — the shape the
      // sanitize step exists for, and one a host username rarely has.
      expect(orchSocketEndpoint('/sockets/orch.sock', 'win32', 'CORP\\Ada Löve')).toBe(
        '\\\\.\\pipe\\cyboflow-CORP-Ada-L-ve-f82a072c-orch',
      );
    });

    it('falls back to "default" for an empty username', () => {
      expect(orchSocketEndpoint('/sockets/orch.sock', 'win32', '')).toBe(
        '\\\\.\\pipe\\cyboflow-default-f82a072c-orch',
      );
    });

    it('falls back to "default" when os.userInfo() throws and no username was injected', () => {
      // The real-world trigger: a uid with no passwd entry (containers, some CI
      // images, managed accounts) makes os.userInfo() throw SystemError ENOENT.
      vi.mocked(os.userInfo).mockImplementation(() => {
        throw new Error('ENOENT: no such user');
      });
      expect(orchSocketEndpoint('/sockets/orch.sock', 'win32')).toBe(
        '\\\\.\\pipe\\cyboflow-default-f82a072c-orch',
      );
    });
  });

  describe('posix', () => {
    it.each(['linux', 'darwin'] as const)(
      'returns the injected path unchanged on %s without ever calling os.userInfo',
      (platform) => {
        const socketPath = '/Users/dev/.cyboflow/sockets/orch.sock';
        expect(orchSocketEndpoint(socketPath, platform)).toBe(socketPath);
        // os.userInfo() throws in some hosts (containers, managed accounts) —
        // a default-parameter initializer would run it on every call regardless
        // of platform; it must be evaluated only inside the win32 branch.
        expect(os.userInfo).not.toHaveBeenCalled();
      }
    );
  });
});
