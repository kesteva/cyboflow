/**
 * Narrow structural contract for the `gitPrerequisite` tRPC router's business
 * logic — the onboarding git probe (shared/types/gitPrerequisite.ts). The
 * concrete implementation (main/src/ipc/gitPrerequisite.ts,
 * `createGitPrerequisiteOps`) resolves git through the same finder every
 * worktree operation uses and may import main/src/utils/*; declaring the
 * interface here keeps the tRPC subtree's standalone-typecheck invariant
 * intact (no 'electron' or 'main/src/services/**' imports).
 */
import type {
  GitDetectRequest,
  GitIdentityInput,
  GitPrerequisiteResult,
} from '../../../../../shared/types/gitPrerequisite';

export type GitIdentityWriteResult =
  | { success: true; data: GitPrerequisiteResult }
  | { success: false; error: string };

export interface GitPrerequisiteOpsLike {
  /** Is git runnable, and does it have a commit identity? Never throws — a probe failure is a 'missing' result. */
  detect(request: GitDetectRequest): Promise<GitPrerequisiteResult>;
  /** Writes `user.name` / `user.email` with `git config --global`, then returns a fresh probe. */
  setIdentity(input: GitIdentityInput): Promise<GitIdentityWriteResult>;
}
