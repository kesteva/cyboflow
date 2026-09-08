import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { electronRunAsNodeGuardEnv } from '../../../utils/electronNodeGuard';
import type { Logger } from '../../../utils/logger';
import { resolveGitCommand } from '../../../utils/gitExeFinder';

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
 * against a file IT already wrote is a true no-op regardless of surrounding
 * whitespace).
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
  ensureWorktreeExcludesOmpDir(worktreeRoot, logger);
  return { configPath, wrote: true };
}

const OMP_EXCLUDE_LINE = '.omp/';

/**
 * Append `.omp/` to the worktree's LOCAL git exclude (`$GIT_DIR/info/exclude`,
 * never the tracked `.gitignore`) so `.omp/mcp.json` never shows up in the
 * session diff rail or gets swept into a `git add -A` checkpoint commit —
 * `.omp/` joins `.cyboflow/` in that file, per proposal §5.4.
 *
 * SEAM NOTE for the wiring step: this is a THIRD independent implementation of
 * "idempotently append a line to the worktree-local git exclude, fail-soft on
 * a non-git dir". The other two are
 * `InteractiveClaudeManager.ensureWorktreeExcludesCyboflowDir`
 * (`main/src/services/panels/claude/interactiveClaudeManager.ts`, appends
 * `.cyboflow/`) and `workflowBundleInstall.ensureBundleExcluded`
 * (`main/src/services/panels/claude/workflowBundleInstall.ts`, appends the
 * `cyboflow-*.md` bundle globs behind a marker comment). Neither is exported
 * or otherwise shared, and both live outside this task's file set
 * (`main/src/services/panels/omp/`), so this is a fresh copy rather than a
 * call into either. Worth extracting a single
 * `ensureWorktreeGitExclude(worktreePath, lines, logger?)` helper at the
 * wiring step instead of a fourth copy landing later.
 */
function ensureWorktreeExcludesOmpDir(worktreePath: string, logger?: Logger): void {
  try {
    const raw = execFileSync(resolveGitCommand(), ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: worktreePath,
      encoding: 'utf8',
      windowsHide: true,
      // Pin git's message language the same way workflowBundleInstall does,
      // so a locale-dependent "not a git repository" message never surprises
      // a caller trying to distinguish "no repo" from a real failure here —
      // this function does not need that distinction (both paths just warn),
      // but the pin costs nothing and keeps the two implementations aligned.
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (raw.length === 0) return;
    const excludePath = path.isAbsolute(raw) ? raw : path.resolve(worktreePath, raw);

    let existingExclude = '';
    try {
      existingExclude = fs.readFileSync(excludePath, 'utf-8');
    } catch {
      /* no exclude file yet — created below */
    }
    const hasLine = existingExclude
      .split(/\r?\n/)
      .some((line) => line.trim() === OMP_EXCLUDE_LINE || line.trim() === '/.omp/');
    if (hasLine) return;

    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const sep = existingExclude.length === 0 || existingExclude.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(excludePath, `${sep}${OMP_EXCLUDE_LINE}\n`, 'utf-8');
    logger?.info(`[OMP] excluded .omp/ via worktree-local ${excludePath}`);
  } catch (err) {
    logger?.warn(
      `[OMP] could not write worktree exclude for .omp/ (non-git dir?): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
