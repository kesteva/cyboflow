/**
 * agentRoles — register a run's deployable cyboflow roles as NATIVE Codex agent
 * roles, so an orchestrator thread's `spawn_agent({ agent_type: "cyboflow-<key>" })`
 * runs a child under that role's actual prompt instead of a bare, promptless one.
 * The Claude runtime gets the same roles as `.claude/agents/cyboflow-<key>.md`
 * native subagents (agentOverlayWriter.ts `installAgentOverlay`); this is the
 * Codex app-server equivalent.
 *
 * Mechanism (verified live on the pinned Codex 0.153.3 app-server, 2026-09-25):
 *   - The thread/start `config` override accepts
 *     `agents: { "<name>": { description, config_file } }`; `config_file` names a
 *     TOML config LAYER that becomes the child's configuration, so its
 *     `developer_instructions` are the child's instructions. Hyphenated names work.
 *   - `config_file` must be ABSOLUTE: a per-thread JSON override has no declaring
 *     file to resolve a relative path against.
 *   - Codex deserializes the file STANDALONE and a file it cannot deserialize is
 *     not an error — the role is silently dropped with only a `warning`
 *     notification ("Ignoring malformed agent role definition ..."). So the
 *     renderer below emits only keys verified to deserialize, and escapes
 *     strings by the TOML spec rather than by eye.
 *   - The file is read LAZILY (thread/start succeeds even when it is malformed or
 *     missing), so it must already exist before the turn that spawns the child —
 *     the manager materializes it before thread/start.
 *   - Only a fixed set of TYPED overrides in the file reaches the child
 *     (`AgentRoleOverrides` in codex-rs/core/src/agent/role.rs: developer
 *     instructions, model, reasoning effort/summary, verbosity, personality,
 *     service tier, and a few feature DISABLES). Everything else is validated
 *     and then dropped — `mcp_servers` and `sandbox_mode` included, confirmed
 *     live on 0.156.1: a role file disabling `mcp_servers.cyboflow` still left
 *     its child calling the cyboflow tools. So a role child inherits the parent
 *     thread's MCP servers and sandbox, and the single-writer invariant (roles
 *     never call the cyboflow_* write tools) rests on the role prompts and the
 *     runtime-adapter prompt, as it does on OMP. Nothing but the typed keys is
 *     emitted, so the file never implies a restriction it cannot enforce.
 *
 * Files are CONTENT-ADDRESSED (`cyboflow-<key>-<sha256 prefix>.toml`): a changed
 * prompt yields a new path, which changes the thread configuration and therefore
 * the warm-session fingerprint (codexSdkManager.computeWarmFingerprint) with no
 * extra plumbing, while identical content across runs shares one file. Nothing
 * rewrites a file in place, so a thread that registered a path keeps reading the
 * exact content it registered.
 *
 * Fail-soft throughout: this runs on the spawn path, so every failure degrades to
 * "that role (or every role) is not registered" with a `logger?.warn` — never a
 * throw. A run with no native roles still works: `spawn_agent` rejects the
 * unknown agent type, and the Codex runtime-adapter prompt
 * (workflowPromptRenderer) tells the orchestrator to do that role's work itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { LoggerLike } from '../../../../orchestrator/types';
import type { EffectiveAgent } from '../../../../orchestrator/agents/effectiveAgents';
import { providerForRuntime } from '../../../../../../shared/types/agentRuntime';
import { normalizeEffortSelection } from '../../../../../../shared/types/reasoningEffort';
import { getCyboflowSubdirectory } from '../../../../utils/cyboflowDirectory';

/**
 * One registered role, exactly as it rides in the thread `config.agents` map.
 * A type alias (not an interface) so it stays assignable to the protocol's
 * `AppServerJsonValue` index signature.
 */
export type CodexAgentRoleEntry = {
  description: string;
  config_file: string;
};

/** `config.agents` for a thread: `cyboflow-<agentKey>` → its role entry. */
export type CodexAgentRoles = Record<string, CodexAgentRoleEntry>;

/** The role-name / filename namespace, shared with the Claude overlay's `cyboflow-<key>.md`. */
const ROLE_PREFIX = 'cyboflow-';

/**
 * The agent-key shape the Agents tRPC surface validates on write
 * (`agentKeySchema`). Re-checked here because the key becomes a FILENAME: a key
 * that reached the DB by another path must not be able to name `../x`.
 */
const AGENT_KEY_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Role files untouched for this long are pruned (each spawn that uses one refreshes its mtime). */
const ROLE_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Our own role files, plus the temp files an interrupted atomic write could
 * leave behind (`<file>.<nonce>.tmp`) — anything else in the directory is not
 * ours to delete.
 */
const PRUNABLE_FILE = /^cyboflow-.+\.toml(?:\.[^.]+\.tmp)?$/;

/** Lone UTF-16 surrogates: a high not followed by a low, or a low not preceded by a high. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Directories already pruned by this process (at most one sweep per directory per process). */
const prunedDirs = new Set<string>();

/** Test-only: forget which directories this process already pruned. */
export function _resetCodexAgentRolePruneForTesting(): void {
  prunedDirs.clear();
}

/**
 * Where role files live by default: under the Cyboflow data dir, so every run
 * (and every worktree) shares one content-addressed pool. Resolved to an
 * absolute path because `config_file` must be absolute (see the header).
 */
export function defaultCodexAgentRolesDir(): string {
  return path.resolve(getCyboflowSubdirectory('codex', 'agent-roles'));
}

/**
 * Encode `value` as a TOML basic string ("...").
 *
 * JSON.stringify is almost exactly a TOML basic-string encoder: every escape it
 * emits (`\"` `\\` `\b` `\f` `\n` `\r` `\t` `\uXXXX`) is also a valid TOML
 * escape, and it escapes every control character in U+0000–U+001F, which TOML
 * requires. Two gaps remain, both closed here rather than by a TOML dependency:
 *   - LONE SURROGATES. JSON.stringify emits them as `\uD800`-style escapes, but
 *     a TOML `\uXXXX` must name a Unicode SCALAR value, and surrogates are not —
 *     the file would fail to deserialize and Codex would silently drop the role.
 *     They are replaced with U+FFFD first (they carry no text a model could use).
 *   - DEL (U+007F). TOML forbids it raw in a basic string; JSON.stringify
 *     leaves it raw. It is escaped as `\u007F`.
 * No other raw character JSON.stringify leaves unescaped is forbidden by TOML.
 */
export function tomlBasicString(value: string): string {
  return JSON.stringify(value.replace(LONE_SURROGATE, '�')).replace(/\u007F/g, '\\u007F');
}

/**
 * The model the child should run on, or null to inherit the parent thread's.
 * Only an agent explicitly pinned onto a CODEX runtime carries a model Codex can
 * run: `agent.model` is a Claude alias, and a providerModel pinned for another
 * provider (OMP, pi) names a model this app-server does not serve.
 */
function codexRoleModel(agent: EffectiveAgent): string | null {
  if (!agent.runtime || providerForRuntime(agent.runtime) !== 'codex') return null;
  const model = agent.providerModel?.trim();
  return model ? model : null;
}

/**
 * Pure: the TOML config layer for one role. Top-level keys first — TOML assigns
 * every key after a `[table]` header to that table, so the MCP table must come
 * last. Deliberately NOT emitted:
 *   - `sandbox_mode` — a role's sandbox does not restrict the child (the parent
 *     thread's sandbox wins, verified live), so it would only mislead a reader.
 *   - `agent.tools` / `agent.enabledMcps` — Codex role layers have no per-role
 *     tool allow-list; the role prompt states its own scope.
 *   - `agent.model` — a Claude alias, meaningless to Codex (see codexRoleModel).
 */
export function renderCodexAgentRoleToml(agent: EffectiveAgent): string {
  const lines = [`developer_instructions = ${tomlBasicString(agent.systemPrompt)}`];
  const model = codexRoleModel(agent);
  if (model) lines.push(`model = ${tomlBasicString(model)}`);
  // A cross-provider effort is dropped when Codex's scale lacks it (Claude's
  // `max`, OMP's `off`) — an unknown value would fail the whole role file.
  const effort = agent.effort ? normalizeEffortSelection('codex', agent.effort) : undefined;
  if (effort) lines.push(`model_reasoning_effort = ${tomlBasicString(effort)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Write `content` to `file` so a concurrent reader (Codex lazily opening the role
 * on a `spawn_agent`) never sees a partial file: write a sibling temp file in the
 * SAME directory (rename is only atomic within one filesystem), then rename.
 */
function writeFileAtomic(file: string, content: string): void {
  const temp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Best effort — a leftover temp file is pruned by the stale-file sweep.
    }
    throw err;
  }
}

/**
 * Ensure the content-addressed file exists. A present file already holds this
 * exact content (its name is the content's digest), so it is never rewritten —
 * only its mtime is refreshed, which is what keeps an in-use role out of the
 * stale-file sweep.
 */
function ensureRoleFile(file: string, content: string): void {
  // statSync-with-throwIfNoEntry rather than existsSync: something that is NOT a
  // regular file at this path (a directory) must fall through to the write —
  // whose rename then fails and omits the role — instead of being registered.
  // The size check catches a truncated file (a rename that survived a power
  // loss without its data): an EMPTY file is valid TOML, so Codex would register
  // the role with no instructions.
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat?.isFile() && stat.size === Buffer.byteLength(content, 'utf8')) {
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch {
      // Best effort: a stale mtime only risks a later prune, after which the
      // next spawn simply writes the file again.
    }
    return;
  }
  writeFileAtomic(file, content);
}

/**
 * Delete this pool's role files (and leftover temp files) whose mtime is older
 * than {@link ROLE_FILE_MAX_AGE_MS}. Returns how many were deleted. Fail-soft:
 * an unreadable directory or a file that cannot be removed is skipped.
 *
 * Safe against live threads because every spawn that registers a file refreshes
 * its mtime first, and a thread whose process is gone re-materializes its roles
 * (rewriting a pruned file) on resume.
 */
export function pruneStaleCodexAgentRoleFiles(
  rolesDir: string,
  logger?: LoggerLike,
  now: number = Date.now(),
): number {
  let names: string[];
  try {
    names = fs.readdirSync(rolesDir);
  } catch (err) {
    logger?.warn(
      `[CodexAgentRoles] could not list ${rolesDir} for pruning: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!PRUNABLE_FILE.test(name)) continue;
    const file = path.join(rolesDir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || now - stat.mtimeMs <= ROLE_FILE_MAX_AGE_MS) continue;
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch (err) {
      logger?.warn(
        `[CodexAgentRoles] could not prune ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return removed;
}

/**
 * Materialize every agent as a role file under `rolesDir` and return the
 * thread-config `agents` map for the ones that landed. An agent whose file cannot
 * be written (or whose key is not a safe filename) is warned about and OMITTED —
 * registering a `config_file` that does not exist would have Codex silently
 * ignore the role anyway, so omission is the honest state. Never throws.
 */
export function materializeCodexAgentRoles(
  agents: readonly EffectiveAgent[],
  rolesDir: string,
  logger?: LoggerLike,
): CodexAgentRoles {
  const roles: CodexAgentRoles = {};
  if (agents.length === 0) return roles;

  let dir: string;
  try {
    dir = path.resolve(rolesDir);
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    logger?.warn(
      `[CodexAgentRoles] could not create ${rolesDir}; registering no roles: ${err instanceof Error ? err.message : String(err)}`,
    );
    return roles;
  }

  // One sweep per directory per process — pruning is housekeeping, not something
  // every spawn should pay a readdir + N stats for.
  if (!prunedDirs.has(dir)) {
    prunedDirs.add(dir);
    pruneStaleCodexAgentRoleFiles(dir, logger);
  }

  for (const agent of agents) {
    try {
      if (!AGENT_KEY_PATTERN.test(agent.agentKey)) {
        logger?.warn(`[CodexAgentRoles] skipping agent with an unsafe key: ${JSON.stringify(agent.agentKey)}`);
        continue;
      }
      const content = renderCodexAgentRoleToml(agent);
      const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
      const file = path.join(dir, `${ROLE_PREFIX}${agent.agentKey}-${digest}.toml`);
      ensureRoleFile(file, content);
      // A blank description would still register, but Codex advertises it in the
      // spawn_agent tool text — give the orchestrator something to choose by.
      const description = typeof agent.description === 'string' ? agent.description.trim() : '';
      roles[`${ROLE_PREFIX}${agent.agentKey}`] = {
        description: description.length > 0 ? description : `Cyboflow ${agent.agentKey} role`,
        config_file: file,
      };
    } catch (err) {
      logger?.warn(
        `[CodexAgentRoles] could not materialize role ${ROLE_PREFIX}${agent.agentKey}; omitting it: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return roles;
}
