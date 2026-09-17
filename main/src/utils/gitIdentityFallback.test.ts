import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGitCapture } from './runGit';
import { FALLBACK_GIT_IDENTITY, gitIdentityFallbackArgs } from './gitIdentityFallback';

/**
 * Real git, hermetic config: GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM point at
 * empty files so the host's own identity never leaks in, and the repo-local
 * config is the only place a name/email can come from.
 */
let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-git-identity-'));
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const empty = path.join(dir, 'empty-gitconfig');
  fs.writeFileSync(empty, '');
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_SYSTEM = empty;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function initRepo(): Promise<string> {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  await runGitCapture(repo, ['init', '-q']);
  return repo;
}

describe('gitIdentityFallbackArgs', () => {
  it('fills in both halves when git has no identity, and the initial commit then succeeds', async () => {
    const repo = await initRepo();
    // (Whether a bare `git commit` fails here is host-dependent: git guesses an
    // identity from username@hostname when the hostname is qualified, which is
    // why this passed on the Mac and died on the Windows VM — so only the
    // helper's contract is asserted, not git's guess.)
    const args = await gitIdentityFallbackArgs(repo);
    expect(args).toEqual([
      '-c', `user.name=${FALLBACK_GIT_IDENTITY.name}`,
      '-c', `user.email=${FALLBACK_GIT_IDENTITY.email}`,
    ]);
    await runGitCapture(repo, [...args, 'commit', '-m', 'Initial commit', '--allow-empty']);
    const { stdout } = await runGitCapture(repo, ['log', '-1', '--format=%an <%ae>']);
    expect(stdout.trim()).toBe(`${FALLBACK_GIT_IDENTITY.name} <${FALLBACK_GIT_IDENTITY.email}>`);
  }, 60_000);

  it('fills in only the missing half and never overrides a configured one', async () => {
    const repo = await initRepo();
    await runGitCapture(repo, ['config', 'user.name', 'Ada Lovelace']);
    const args = await gitIdentityFallbackArgs(repo);
    expect(args).toEqual(['-c', `user.email=${FALLBACK_GIT_IDENTITY.email}`]);
    await runGitCapture(repo, [...args, 'commit', '-m', 'Initial commit', '--allow-empty']);
    const { stdout } = await runGitCapture(repo, ['log', '-1', '--format=%an <%ae>']);
    expect(stdout.trim()).toBe(`Ada Lovelace <${FALLBACK_GIT_IDENTITY.email}>`);
  }, 60_000);

  it('returns no args when both halves are configured', async () => {
    const repo = await initRepo();
    await runGitCapture(repo, ['config', 'user.name', 'Ada']);
    await runGitCapture(repo, ['config', 'user.email', 'ada@example.com']);
    expect(await gitIdentityFallbackArgs(repo)).toEqual([]);
  }, 60_000);
});
