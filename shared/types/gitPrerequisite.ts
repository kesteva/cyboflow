/**
 * Git prerequisite probe — shared contract between the main-process handler
 * (`main/src/ipc/gitPrerequisite.ts`) and the onboarding gate.
 *
 * Every session Cyboflow starts lives in a git worktree, and the first thing a
 * fresh project gets is an `Initial commit`. Both fail — silently, as a 30s
 * "timed out waiting for quick session" — when git is not installed or when it
 * has no identity to sign commits with (a clean machine has neither). The tour
 * probes this once at boot and blocks on a prerequisite card until it clears,
 * so the failure is named where the user can fix it rather than surfacing as a
 * timeout after the wizard promised everything was ready.
 *
 * The result is computed MAIN-side so every consumer agrees on the mapping:
 *   !binary.found                        → 'missing'   (install git)
 *   binary.found && (!name || !email)    → 'identity'  (tell git who you are)
 *   binary.found && name && email        → 'ready'
 */
export type GitPrerequisiteState = 'ready' | 'missing' | 'identity';

export interface GitPrerequisiteResult {
  /** Host platform, so the card can show the right install command. */
  platform: 'darwin' | 'win32' | 'linux';
  binary: {
    found: boolean;
    /** Absolute path when the finder resolved one; null for a bare-PATH hit or when missing. */
    path: string | null;
    /** `git --version` output, e.g. "2.45.2"; null when unparseable or missing. */
    version: string | null;
  };
  /** The effective `user.name` / `user.email` git would sign a commit with. */
  identity: {
    name: string | null;
    email: string | null;
  };
  state: GitPrerequisiteState;
}

/** Request shape for {@link GIT_DETECT_CHANNEL}. */
export interface GitDetectRequest {
  /**
   * Drop the memoized shell PATH + git-binary resolution before probing, so a
   * "Check again" after the user installs git sees the new binary even though
   * the app's own PATH was captured at launch.
   */
  refresh: boolean;
}

/** Request shape for {@link GIT_SET_IDENTITY_CHANNEL} — written with `git config --global`. */
export interface GitIdentityInput {
  name: string;
  email: string;
}

export const GIT_DETECT_CHANNEL = 'git:detect';
export const GIT_SET_IDENTITY_CHANNEL = 'git:set-identity';
