import * as fs from 'fs';
import * as path from 'path';
import { electronRunAsNodeGuardEnv } from '../../../utils/electronNodeGuard';
import type { Logger } from '../../../utils/logger';
import { ensureGitExcludeEntries } from '../../../utils/gitExcludeWriter';
import { makeLoggerLike } from '../../../orchestrator/loggerAdapter';

/**
 * Writer for `<worktree>/.omp/mcp.json` — how the `cyboflow` MCP server (the
 * `cyboflow_*` tool surface) reaches an OMP session (proposal §5.4).
 *
 * SCOPE: this is the config the future `OmpSdkManager` (`omp --mode rpc`,
 * Phase 1 §5.1) writes at spawn. **The `omp-pty` interactive terminal lane
 * gets NO MCP in v1** (proposal §5.2: "No MCP, no structured side-channel — T0
 * floor by design") — `OmpPtyManager` never calls this writer. It lives here
 * (not co-located with the SDK manager, which does not exist in this task's
 * file set) because the MCP config contract and the git-exclude seam it needs
 * are independent of which manager ends up calling it.
 *
 * ONE STATIC FILE serves every concurrent lane sharing a worktree, regardless
 * of run id: the `env` values below are OMP's documented "bare-name" form
 * (`docs/mcp-config.md` §"Secrets and variable resolution", pre-connect
 * resolution step 3–4) — a value that names a set environment variable is
 * copied from the **omp process's own env** at spawn time, not from this file.
 * Cyboflow injects the real `CYBOFLOW_RUN_ID`/`CYBOFLOW_ORCH_SOCKET` into each
 * spawn's process env (the same way `runConfig.ts`'s Codex app-server config
 * and `writeInteractiveMcpConfig`'s Claude interactive config do it, except
 * those bake the literal value into a config written PER SPAWN — OMP's file is
 * written once and read by whichever lane happens to load it next). A missing
 * env var resolves to the literal string per OMP's own semantics (loud, not
 * silent — `cyboflowMcpServer` exits 1 on a malformed run id).
 */

const CYBOFLOW_SERVER_KEY = 'cyboflow';

interface OmpMcpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeout: number;
}

/** Shape of `.omp/mcp.json`. Unknown top-level keys ($schema, disabledServers, …) pass through untouched. */
interface OmpMcpConfigFile {
  mcpServers: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Build the `cyboflow` MCP server entry. `nodeExecutablePath`/`bridgeScriptPath`
 * are taken as parameters rather than resolved here, mirroring how
 * `runConfig.ts`'s `buildMcpConfig` (the Codex app-server precedent) obtains
 * them from its caller's already-resolved `CodexAppServerMcpRuntimeConfig`.
 *
 * `timeout: 0` disables OMP's 30s per-server MCP timeout (`mcp-config.md`
 * §"Supported server fields") — mandatory, not a tuning choice: a blocking
 * human gate (`cyboflow_request_user_input`) would otherwise be killed
 * mid-wait, the same lesson that set Codex's `tool_timeout_sec` to a week
 * (`runConfig.ts`'s `buildMcpConfig` comment).
 *
 * `ELECTRON_RUN_AS_NODE` (when `nodeExecutablePath` resolves to the packaged
 * Electron binary rather than a standalone `node`) is baked in as a LITERAL
 * value here, unlike the bare-name run-id/socket entries: whether the host
 * has a real `node` on PATH is a machine-wide fact, invariant across every
 * concurrent lane, so there is no per-spawn indirection to preserve.
 */
export function buildOmpCyboflowMcpServerEntry(
  nodeExecutablePath: string,
  bridgeScriptPath: string,
): OmpMcpServerEntry {
  return {
    command: nodeExecutablePath,
    args: [bridgeScriptPath],
    env: {
      CYBOFLOW_RUN_ID: 'CYBOFLOW_RUN_ID',
      CYBOFLOW_ORCH_SOCKET: 'CYBOFLOW_ORCH_SOCKET',
      // Bare-name indirection is load-bearing for this one, not just stylistic:
      // it is a per-run SECRET (orchAuthToken.ts), and this file is shared by
      // every lane in the worktree and persists on disk. Naming the var makes
      // OMP copy the value from its own process env at spawn
      // (`ompSdkManager.buildSpawnEnvironment`), so the token never lands here.
      CYBOFLOW_ORCH_TOKEN: 'CYBOFLOW_ORCH_TOKEN',
      ...electronRunAsNodeGuardEnv(nodeExecutablePath),
    },
    timeout: 0,
  };
}

export function ompMcpConfigPath(worktreeRoot: string): string {
  return path.join(worktreeRoot, '.omp', 'mcp.json');
}

export interface WriteOmpMcpConfigOptions {
  worktreeRoot: string;
  nodeExecutablePath: string;
  bridgeScriptPath: string;
  logger?: Logger;
}

export interface OmpMcpConfigWriteResult {
  configPath: string;
  /** True when the file's content actually changed (or was created) this call. */
  wrote: boolean;
}

/**
 * Idempotently write (or merge into) `<worktree>/.omp/mcp.json`'s `cyboflow`
 * server entry.
 *
 * MERGE-SAFE (not overwrite-with-comment): every other `mcpServers` entry and
 * every other top-level key ($schema, disabledServers, enabledServers, …) an
 * existing file carries is preserved verbatim — this writer owns exactly the
 * `cyboflow` key, the same "one entry, ours" stance
 * `writeInteractiveMcpConfig`/`buildMcpConfig` take for their substrates. A
 * user who has hand-authored other MCP servers into this project's
 * `.omp/mcp.json` keeps them.
 *
 * IDEMPOTENT: rewrites the file only when the merged content actually differs
 * from what a re-parse of the existing file would produce (structural
 * equality, not raw-string equality, so re-running this with the same inputs
 * against a file IT already wrote never rewrites it, regardless of surrounding
 * whitespace). The `.omp/` git exclusion is still (idempotently) ensured.
 *
 * Malformed existing JSON is NOT silently discarded — a corrupt hand-edited
 * file may still name servers the user cares about, so this logs a warning
 * and refuses to write rather than clobber it (`wrote: false`). Callers must
 * treat that as "MCP injection unavailable this spawn", never a fatal error.
 */
export function writeOmpMcpConfig(options: WriteOmpMcpConfigOptions): OmpMcpConfigWriteResult {
  const { worktreeRoot, nodeExecutablePath, bridgeScriptPath, logger } = options;
  const configPath = ompMcpConfigPath(worktreeRoot);
  const cyboflowEntry = buildOmpCyboflowMcpServerEntry(nodeExecutablePath, bridgeScriptPath);

  // On EVERY call, before any write — not only when this call rewrites the
  // file. A worktree whose `.omp/mcp.json` already matches (a second lane, a
  // respawn, a file restored by hand) would otherwise return "unchanged" below
  // and never exclude `.omp/`, leaving it to the diff rail and to a checkpoint
  // `git add -A`. The append is idempotent, so a repeat call costs one
  // `git rev-parse`.
  ensureWorktreeExcludesOmpDir(worktreeRoot, logger);

  let existing: OmpMcpConfigFile = { mcpServers: {} };
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not a JSON object');
      }
      const obj = parsed as Record<string, unknown>;
      const mcpServers = obj.mcpServers;
      existing = {
        ...obj,
        mcpServers:
          mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)
            ? (mcpServers as Record<string, unknown>)
            : {},
      };
    } catch (err) {
      logger?.warn(
        `[OMP] could not parse existing ${configPath} (${err instanceof Error ? err.message : String(err)}); leaving it untouched, cyboflow MCP injection skipped this spawn`,
      );
      return { configPath, wrote: false };
    }
  }

  const next: OmpMcpConfigFile = {
    ...existing,
    mcpServers: { ...existing.mcpServers, [CYBOFLOW_SERVER_KEY]: cyboflowEntry },
  };

  if (JSON.stringify(next) === JSON.stringify(existing)) {
    return { configPath, wrote: false };
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  logger?.info(`[OMP] wrote MCP config: ${configPath}`);
  return { configPath, wrote: true };
}

const OMP_EXCLUDE_LINE = '.omp/';

/**
 * Append `.omp/` to the worktree's LOCAL git exclude (`$GIT_DIR/info/exclude`,
 * never the tracked `.gitignore`) so nothing cyboflow writes under `.omp/` —
 * `mcp.json` here, the role files `ompAgentWriter` registers under
 * `.omp/agents/` — ever shows up in the session diff rail or gets swept into a
 * `git add -A` checkpoint commit. `.omp/` joins `.cyboflow/` in that file, per
 * proposal §5.4. Exported so both writers share the one exclusion.
 *
 * Delegates the git-path resolution, idempotent append and fail-soft error
 * handling to the shared `gitExcludeWriter` — the single implementation that
 * replaced this function's own copy plus
 * `InteractiveClaudeManager.ensureWorktreeExcludesCyboflowDir` (`.cyboflow/`)
 * and `workflowBundleInstall.ensureBundleExcluded` (the `cyboflow-*.md`
 * bundle globs), per this doc comment's own note that a fourth copy should
 * not land.
 */
export function ensureWorktreeExcludesOmpDir(worktreePath: string, logger?: Logger): void {
  const result = ensureGitExcludeEntries(worktreePath, [OMP_EXCLUDE_LINE], {
    logger: makeLoggerLike(logger),
    label: 'OMP',
  });
  if (result !== null && result.added.length > 0) {
    logger?.info(`[OMP] excluded .omp/ via worktree-local git exclude in ${worktreePath}`);
  }
}
