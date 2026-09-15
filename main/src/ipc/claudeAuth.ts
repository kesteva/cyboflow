import type { ClaudeAuthOpsLike } from '../orchestrator/trpc/contracts/claudeAuthOps';
import {
  ClaudeAuthLoginService,
  resolveClaudeAuthBinary,
  resolveDevBundledClaudePath,
} from '../services/claudeAuthLogin';
import { resolveClaudeExecutablePath } from '../services/panels/claude/claudeExecutablePath';
import { findExecutableInPath, getShellPath } from '../utils/shellPath';

/**
 * The in-app Claude sign-in — the ops implementation behind the
 * `cyboflow.claudeAuth` tRPC router (createClaudeAuthOps, injected into the
 * tRPC context from index.ts). See shared/types/claudeAuth.ts for the
 * contract and why it exists.
 *
 * Binary ladder: the SDK's bundled CLI (packaged: the app.asar.unpacked copy
 * resolveClaudeExecutablePath finds; dev: the platform package in real
 * node_modules) → the user's configured `claudeExecutablePath` → `claude` on
 * the login-shell PATH. The bundled one comes first because it is the binary
 * the sessions actually run, so its credential store is the one that matters.
 */
export function createClaudeAuthOps(deps: {
  getConfiguredClaudePath: () => string | undefined;
  log?: (message: string) => void;
}): ClaudeAuthOpsLike & { dispose(): void } {
  const service = new ClaudeAuthLoginService({
    resolveBinary: () =>
      resolveClaudeAuthBinary({
        bundled: () => resolveClaudeExecutablePath() ?? resolveDevBundledClaudePath(),
        fallback: () => deps.getConfiguredClaudePath()?.trim() || findExecutableInPath('claude') || undefined,
      }),
    env: () => ({ ...process.env, PATH: getShellPath() }),
    log: deps.log,
  });
  return {
    probeAccount: () => service.probeAccount(),
    getLoginState: () => service.getState(),
    startLogin: () => service.start(),
    submitLoginCode: (code) => service.submitCode(code),
    cancelLogin: () => service.cancel(),
    dispose: () => service.dispose(),
  };
}
