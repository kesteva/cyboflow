import { runGitCapture } from './runGit';

/**
 * Placeholder identity for commits Cyboflow makes on the user's behalf when git
 * has none configured — a clean machine has no `user.name` / `user.email`, and
 * `git commit` then dies with "Author identity unknown" (the first session on
 * a fresh Windows install failed exactly there, 30s into a silent timeout).
 * Only the HALVES git cannot resolve are filled in, and only for the one
 * command, via `-c`: a configured identity is never overridden, and nothing is
 * written to the user's config (onboarding's git prerequisite card does that,
 * with their real name).
 */
export const FALLBACK_GIT_IDENTITY = { name: 'Cyboflow', email: 'cyboflow@localhost' } as const;

/** Reads the effective config value in `cwd`; null when unset (git exits 1). */
async function readIdentityHalf(cwd: string, key: 'user.name' | 'user.email'): Promise<string | null> {
  try {
    const { stdout } = await runGitCapture(cwd, ['config', '--get', key]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * `-c user.name=… -c user.email=…` for whichever identity halves are NOT
 * configured in `cwd` (global, system, or repo); `[]` when both are. Spread
 * these BEFORE the subcommand: `[...args, 'commit', …]`.
 */
export async function gitIdentityFallbackArgs(cwd: string): Promise<string[]> {
  const [name, email] = await Promise.all([
    readIdentityHalf(cwd, 'user.name'),
    readIdentityHalf(cwd, 'user.email'),
  ]);
  const args: string[] = [];
  if (!name) args.push('-c', `user.name=${FALLBACK_GIT_IDENTITY.name}`);
  if (!email) args.push('-c', `user.email=${FALLBACK_GIT_IDENTITY.email}`);
  return args;
}
