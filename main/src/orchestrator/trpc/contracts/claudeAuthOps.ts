/**
 * Narrow structural contract for the `claudeAuth` tRPC router's business
 * logic — the in-app Claude sign-in (shared/types/claudeAuth.ts). The concrete
 * implementation is `ClaudeAuthLoginService` (main/src/services/
 * claudeAuthLogin.ts), wired from main/src/index.ts via createClaudeAuthOps;
 * declaring the interface here keeps the tRPC subtree's standalone-typecheck
 * invariant intact (no 'electron' or 'main/src/services/**' imports).
 */
import type { ClaudeAuthAccount, ClaudeLoginState } from '../../../../../shared/types/claudeAuth';

export interface ClaudeAuthOpsLike {
  /** `claude auth status` as the CLI sees it right now; null when no binary answers. */
  probeAccount(): Promise<ClaudeAuthAccount | null>;
  /** Current login-attempt state (cheap; the dialog polls it). */
  getLoginState(): ClaudeLoginState;
  /** Spawn `claude auth login`; idempotent while an attempt is live. */
  startLogin(): ClaudeLoginState;
  /** Feed the browser's authorization code to the waiting CLI. */
  submitLoginCode(code: string): ClaudeLoginState;
  /** Abandon the live attempt and return to idle. */
  cancelLogin(): ClaudeLoginState;
}
