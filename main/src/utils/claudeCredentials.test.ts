import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Mock the three IO surfaces the probe touches. Each test drives them to
// isolate a single signal in the priority chain.
vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('fs', () => ({ statSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock('os', () => ({ platform: vi.fn(), homedir: vi.fn() }));

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { detectClaudeCredentials } from './claudeCredentials';

const mockExecFile = execFile as unknown as Mock;
const mockStatSync = fs.statSync as unknown as Mock;
const mockReadFileSync = fs.readFileSync as unknown as Mock;
const mockPlatform = os.platform as unknown as Mock;
const mockHomedir = os.homedir as unknown as Mock;

const HOME = '/home/tester';

/** Drive the execFile callback: pass an Error to simulate a non-zero exit. */
function keychainReturns(error: Error | null): void {
  mockExecFile.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
      cb(error);
      return { on: vi.fn() };
    },
  );
}

/** No file exists / all fs reads throw ENOENT. */
function noFiles(): void {
  mockStatSync.mockImplementation(() => {
    throw new Error('ENOENT');
  });
  mockReadFileSync.mockImplementation(() => {
    throw new Error('ENOENT');
  });
}

describe('detectClaudeCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue(HOME);
    mockPlatform.mockReturnValue('darwin');
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  describe('priority order (first hit wins)', () => {
    it('keychain wins over every lower signal', async () => {
      keychainReturns(null); // exit 0 = present
      // Lower signals also present — must be ignored.
      mockStatSync.mockReturnValue({ isFile: () => true, size: 10 });
      mockReadFileSync.mockReturnValue(JSON.stringify({ userID: 'u' }));
      process.env.ANTHROPIC_API_KEY = 'sk-test';

      const result = await detectClaudeCredentials();
      expect(result).toEqual({ found: true, source: 'keychain', account: null });
    });

    it('keychain hit borrows the account label from ~/.claude.json when present', async () => {
      keychainReturns(null);
      mockReadFileSync.mockReturnValue(JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } }));

      const result = await detectClaudeCredentials();
      expect(result).toEqual({ found: true, source: 'keychain', account: 'dev@example.com' });
    });

    it('credentialsFile wins when keychain misses', async () => {
      keychainReturns(new Error('exit 44'));
      mockStatSync.mockImplementation((p: string) => {
        if (p.endsWith('.credentials.json')) return { isFile: () => true, size: 128 };
        throw new Error('ENOENT');
      });
      // No ~/.claude.json → no label to borrow (clearAllMocks does not reset
      // implementations, so pin this explicitly rather than relying on order).
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      process.env.ANTHROPIC_API_KEY = 'sk-test';

      const result = await detectClaudeCredentials();
      expect(result).toEqual({ found: true, source: 'credentialsFile', account: null });
    });

    it('claudeConfig with oauthAccount exposes the email label', async () => {
      keychainReturns(new Error('exit 44'));
      mockStatSync.mockImplementation(() => {
        throw new Error('ENOENT'); // no credentials file
      });
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ userID: 'u', oauthAccount: { emailAddress: 'dev@example.com', displayName: 'Dev' } }),
      );

      const result = await detectClaudeCredentials();
      expect(result).toEqual({ found: true, source: 'claudeConfig', account: 'dev@example.com' });
    });

    it('claudeConfig falls back to displayName, then null, when no email', async () => {
      keychainReturns(new Error('exit 44'));
      mockStatSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      mockReadFileSync.mockReturnValue(JSON.stringify({ oauthAccount: { displayName: 'Dev' } }));

      expect(await detectClaudeCredentials()).toEqual({ found: true, source: 'claudeConfig', account: 'Dev' });

      mockReadFileSync.mockReturnValue(JSON.stringify({ userID: 'u' }));
      expect(await detectClaudeCredentials()).toEqual({ found: true, source: 'claudeConfig', account: null });
    });

    it('env var is the lowest signal', async () => {
      keychainReturns(new Error('exit 44'));
      noFiles();
      process.env.ANTHROPIC_AUTH_TOKEN = 'token-xyz';

      const result = await detectClaudeCredentials();
      expect(result).toEqual({ found: true, source: 'env', account: null });
    });

    it('returns not-found when no signal matches', async () => {
      keychainReturns(new Error('exit 44'));
      noFiles();
      const result = await detectClaudeCredentials();
      expect(result).toEqual({ found: false, source: null, account: null });
    });
  });

  describe('platform + marker guards', () => {
    it('skips the keychain probe entirely on non-darwin', async () => {
      mockPlatform.mockReturnValue('linux');
      noFiles();
      await detectClaudeCredentials();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('ignores ~/.claude.json without a login marker', async () => {
      keychainReturns(new Error('exit 44'));
      mockStatSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      mockReadFileSync.mockReturnValue(JSON.stringify({ someOtherKey: true }));
      const result = await detectClaudeCredentials();
      expect(result.found).toBe(false);
    });

    it('rejects stale/partial markers with no concrete value', async () => {
      keychainReturns(new Error('exit 44'));
      mockStatSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const staleConfigs = [
        { oauthAccount: {} },
        { userID: null },
        { userID: '' },
        { userID: '   ' },
        { oauthAccount: { emailAddress: '', displayName: '' }, userID: '' },
      ];
      for (const config of staleConfigs) {
        mockReadFileSync.mockReturnValue(JSON.stringify(config));
        expect((await detectClaudeCredentials()).found).toBe(false);
      }
    });

    it('accepts an oauthAccount whose only concrete field is accountUuid (no label)', async () => {
      keychainReturns(new Error('exit 44'));
      mockStatSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      mockReadFileSync.mockReturnValue(JSON.stringify({ oauthAccount: { accountUuid: 'acc-uuid-1' } }));
      expect(await detectClaudeCredentials()).toEqual({ found: true, source: 'claudeConfig', account: null });
    });

    it('treats a zero-byte credentials file as absent', async () => {
      keychainReturns(new Error('exit 44'));
      mockStatSync.mockReturnValue({ isFile: () => true, size: 0 });
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const result = await detectClaudeCredentials();
      expect(result.found).toBe(false);
    });
  });

  describe('never throws — degrades to the next signal', () => {
    it('survives an execFile that throws synchronously', async () => {
      mockExecFile.mockImplementation(() => {
        throw new Error('spawn EACCES');
      });
      noFiles();
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      const result = await detectClaudeCredentials();
      expect(result).toEqual({ found: true, source: 'env', account: null });
    });

    it('survives malformed JSON in ~/.claude.json', async () => {
      keychainReturns(new Error('exit 44'));
      mockStatSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      mockReadFileSync.mockReturnValue('{ not valid json');
      const result = await detectClaudeCredentials();
      expect(result.found).toBe(false);
    });

    it('never rejects even if homedir throws', async () => {
      mockHomedir.mockImplementation(() => {
        throw new Error('no home');
      });
      keychainReturns(new Error('exit 44'));
      await expect(detectClaudeCredentials()).resolves.toEqual({ found: false, source: null, account: null });
    });
  });
});
