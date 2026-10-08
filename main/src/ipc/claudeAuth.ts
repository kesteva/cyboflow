import type { ClaudeAuthOpsLike } from '../orchestrator/trpc/contracts/claudeAuthOps';
import type { ClaudeAuthAccount } from '../../../shared/types/claudeAuth';
import {
  ClaudeAuthLoginService,
  probeClaudeAuthStatus,
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
function resolveAuthBinary(configuredPath: string | undefined): string | null {
  return resolveClaudeAuthBinary({
    bundled: () => resolveClaudeExecutablePath() ?? resolveDevBundledClaudePath(),
    fallback: () => configuredPath?.trim() || findExecutableInPath('claude') || undefined,
  });
}

function authEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: getShellPath() };
}

/**
 * The CLI's own verdict on the login (`claude auth status`), from the same
 * binary the sign-in runs. The onboarding provider probe uses it to catch what
 * a credential-presence check cannot: a leftover account marker or Keychain
 * entry for a login the CLI no longer accepts. Null = no answer (unknown).
 */
export function probeClaudeLoginStatus(configuredPath: string | undefined): Promise<ClaudeAuthAccount | null> {
  return probeClaudeAuthStatus(resolveAuthBinary(configuredPath), authEnv());
}

export function createClaudeAuthOps(deps: {
  getConfiguredClaudePath: () => string | undefined;
  log?: (message: string) => void;
}): ClaudeAuthOpsLike & { dispose(): void } {
  const service = new ClaudeAuthLoginService({
    resolveBinary: () => resolveAuthBinary(deps.getConfiguredClaudePath()),
    env: authEnv,
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
