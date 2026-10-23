/**
 * Per-run bearer tokens for the orchestrator Unix socket (orch.sock).
 *
 * WHY THIS EXISTS
 * ---------------
 * `OrchSocketServer` binds a connection to a run the first time that connection
 * sends an envelope carrying a `runId` (see `orchSocketServer.bindSocket`).
 * Before this module the runId was purely SELF-DECLARED: any local process that
 * could open the socket path could claim any run — including the global agent's
 * `agent:<threadId>` identity, which unlocks the cross-project filesystem/SQL
 * read family — and inherit that run's powers (shell-approval routing, entity
 * writes, workflow-spec edits).
 *
 * A token closes that: the orchestrator mints one random secret per runId at
 * SPAWN time, hands it to the processes it spawns for that run via the
 * `CYBOFLOW_ORCH_TOKEN` env var, and the server refuses a bind whose token does
 * not match.
 *
 * INVARIANTS
 * ----------
 *  - **Memory only on this machine.** Tokens live in this process's heap for the
 *    app's lifetime and are never written to disk locally, never logged, and
 *    never sent to the renderer. The one exception is a REMOTE run: the token
 *    must not ride an ssh argv, so it is written (over ssh stdin) to a 0600
 *    per-run file on the remote and the agent gets `CYBOFLOW_ORCH_TOKEN_FILE`;
 *    clients read it via `readOrchToken`. Local spawns keep passing the env
 *    var. Every transport that carries one (`claudeCodeManager`'s in-memory
 *    MCP entry, `interactiveClaudeManager`'s PTY env, the Codex app-server
 *    config, OMP's bare-name env indirection) is in-memory by construction —
 *    deliberately NOT the on-disk `.mcp.json` / `interactive-mcp.json` /
 *    `.omp/mcp.json` files those substrates also write. The Claude CLI passes
 *    its full process env down to stdio MCP servers, which is what lets the
 *    interactive substrate's config stay token-free.
 *  - **Idempotent per runId.** `mint` returns the SAME token for a runId it has
 *    already seen. Re-minting would break a warm SDK session (the options
 *    fingerprint would churn) and orphan an already-spawned client.
 *  - **Standalone-typecheck safe.** Imports nothing but `node:crypto`, so
 *    `orchSocketServer.ts` (which must not reach electron / better-sqlite3 /
 *    services) can depend on it.
 *
 * THREAT MODEL, honestly stated: the socket itself is chmodded 0600 and its
 * directory 0700, so the only processes that can reach it already run as this
 * user. The token is defense-in-depth on top of that — it stops a same-user
 * process (a stray agent, a leftover subprocess from another run, anything that
 * merely knows the socket path) from ASSERTING a run identity that is not its
 * own. It is not a defense against an attacker who already controls this user.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';

/** Env var carrying a spawned process's bearer token for its run. */
export const ORCH_TOKEN_ENV_VAR = 'CYBOFLOW_ORCH_TOKEN';

/**
 * Env var naming a file that holds the token (remote runs only). Used by
 * `readOrchToken` when `CYBOFLOW_ORCH_TOKEN` itself is unset.
 */
export const ORCH_TOKEN_FILE_ENV_VAR = 'CYBOFLOW_ORCH_TOKEN_FILE';

/** A token is 64 hex chars; anything past this is not a token file. */
const MAX_TOKEN_FILE_BYTES = 4096;

/**
 * Emergency rollback: set to '1' to restore the legacy accept-all binding.
 * Loudly logged by the server on every bind it lets through unauthenticated.
 */
export const ORCH_AUTH_KILL_SWITCH_ENV_VAR = 'CYBOFLOW_DISABLE_ORCH_SOCK_AUTH';

/** 32 random bytes, hex-encoded (64 chars). */
const TOKEN_BYTES = 32;

/** The verification half of the registry — all `OrchSocketServer` needs. */
export interface OrchTokenVerifier {
  /** True iff `token` is exactly the token minted for `runId`. */
  verify(runId: string, token: string | undefined): boolean;
}

/**
 * Compare two secrets in constant time regardless of length.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be an
 * oracle, so both sides are hashed to a fixed-width digest first.
 */
function secretsEqual(expected: string, actual: string): boolean {
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(actual, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * In-memory per-run token store.
 *
 * Entries are never evicted: a run's clients (shell hooks, the MCP subprocess,
 * a resumed session) may connect long after the run's last agent turn, and an
 * entry costs ~100 bytes. A pathological uptime of 10k runs holds ~1 MB.
 */
export class OrchTokenRegistry implements OrchTokenVerifier {
  private readonly tokens = new Map<string, string>();

  /**
   * Return the token for `runId`, minting one on first request.
   *
   * IDEMPOTENT BY CONTRACT — callers spawn several processes per run (MCP
   * subprocess, PTY, shell hooks) at different times and every one must present
   * the same secret.
   */
  mint(runId: string): string {
    const existing = this.tokens.get(runId);
    if (existing !== undefined) return existing;
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    this.tokens.set(runId, token);
    return token;
  }

  verify(runId: string, token: string | undefined): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    const expected = this.tokens.get(runId);
    if (expected === undefined) return false;
    return secretsEqual(expected, token);
  }

  /** Whether a token has been minted for `runId`. Diagnostics/tests only. */
  has(runId: string): boolean {
    return this.tokens.has(runId);
  }

  /** Drop a run's token. Nothing calls this in production — see the class note. */
  revoke(runId: string): void {
    this.tokens.delete(runId);
  }

  /** Test-only reset. */
  clear(): void {
    this.tokens.clear();
  }
}

/**
 * The process-wide registry.
 *
 * A module singleton rather than a boot-wired dependency because the minting
 * sites are scattered across six spawn seams in three layers
 * (`services/panels/claude`, `services/panels/codex`, `services/panels/omp`,
 * `orchestrator/mcpServer`), and threading a collaborator through all of them
 * would be far more invasive than the security fix itself. `OrchSocketServer`
 * still takes a verifier as a constructor argument (defaulting to this) so
 * tests can drive it hermetically.
 */
export const orchTokenRegistry = new OrchTokenRegistry();

/** Mint (or re-read) the process-wide token for `runId`. */
export function mintOrchToken(runId: string): string {
  return orchTokenRegistry.mint(runId);
}

/**
 * The env slice a spawned process needs to prove it belongs to `runId`.
 *
 * Spread into a spawn's `env` next to `CYBOFLOW_RUN_ID`, so the two always
 * travel together and can never disagree.
 */
export function orchTokenEnv(runId: string): Record<string, string> {
  return { [ORCH_TOKEN_ENV_VAR]: mintOrchToken(runId) };
}

/** Read this process's own bearer token (client side). */
export function readOrchToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env[ORCH_TOKEN_ENV_VAR];
  if (typeof token === 'string' && token.length > 0) return token;
  const file = env[ORCH_TOKEN_FILE_ENV_VAR];
  if (typeof file !== 'string' || file.length === 0) return undefined;
  try {
    const raw = readFileSync(file);
    if (raw.length > MAX_TOKEN_FILE_BYTES) return undefined;
    const trimmed = raw.toString('utf8').trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the emergency accept-all rollback is engaged. */
export function isOrchSockAuthDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ORCH_AUTH_KILL_SWITCH_ENV_VAR] === '1';
}
