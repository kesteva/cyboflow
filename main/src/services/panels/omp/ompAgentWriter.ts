import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { providerForRuntime } from '../../../../../shared/types/agentRuntime';
import type { CliTool } from '../../../../../shared/types/cliTools';
import { isValidEffortForProvider } from '../../../../../shared/types/reasoningEffort';
import type { EffectiveAgent } from '../../../orchestrator/agents/effectiveAgents';
import type { Logger } from '../../../utils/logger';
import { resolveAgentModelAlias } from '../agentModelContext';
import { ensureWorktreeExcludesOmpDir } from './ompMcpConfigWriter';
import { OMP_THINKING_LEVELS, type OmpThinkingLevel } from './rpc/ompContract';

/**
 * ompAgentWriter — registers a run's cyboflow roles (`cyboflow-implement`,
 * `cyboflow-code-review`, …) as OMP PROJECT AGENTS, so an OMP orchestrator's
 * `task` delegation to `cyboflow-<key>` resolves to the run's actual role prompt.
 *
 * This is OMP's twin of the Claude overlay (`claude/agentOverlayWriter.ts`
 * `installAgentOverlay`, which writes `.claude/agents/cyboflow-<key>.md`). Without
 * it an OMP run never sees the role prompts at all: `.claude/agents/` is a Claude
 * discovery path, and OMP falls back to a same-named user/bundled agent or to none.
 *
 * What OMP 17.3.5 does with these files (verified live against the binary):
 *  - it discovers `<cwd>/.omp/agents/*.md` with a plain readdir that is NOT
 *    git-ignore aware, so the files are found even though `.omp/` sits in the
 *    worktree-local git exclude;
 *  - discovery is first-wins with the PROJECT dir first, so a `cyboflow-*` file
 *    here shadows any same-named user, plugin or bundled agent;
 *  - `name` and `description` are REQUIRED strings — an agent missing either is
 *    silently dropped, which is why a blank description gets a fallback below;
 *  - the body after the closing fence becomes the child's system prompt.
 *
 * Only the roles the run's frozen definition binds are written (the caller
 * resolves them via `resolveRunDeployableAgents`): every registered agent is
 * advertised in OMP's task-tool description, so the whole catalogue would cost
 * every turn of a run that deploys four roles.
 */

/** The `.omp/agents` subpath (relative to the worktree) OMP discovers project agents in. */
const OMP_AGENTS_DIR = ['.omp', 'agents'] as const;

/**
 * Which files in `.omp/agents/` cyboflow wrote. Everything else there belongs to
 * the user. Dot-prefixed and `.json`, so OMP's `*.md` discovery never reads it
 * as an agent.
 */
const OWNERSHIP_MANIFEST = '.cyboflow-agents.json';
const OWNERSHIP_MANIFEST_VERSION = 1;

/**
 * The only shape of file name this module will ever create or delete. Mirrors
 * the agents router's kebab-case key rule, and is re-checked on every manifest
 * entry before a delete: the manifest is a file on disk, and a hand-edited entry
 * naming `../../something` must never become an unlink outside this directory.
 */
const OWNED_FILE_NAME = /^cyboflow-[a-z0-9][a-z0-9-]*\.md$/;

interface OwnershipManifest {
  version: typeof OWNERSHIP_MANIFEST_VERSION;
  files: string[];
}

/**
 * CliTool → OMP built-in tool name, for the ALLOW list an agent's `tools:` line
 * is. OMP lowercases and aliases what it reads, but we emit its canonical names
 * so the file says what OMP will actually grant.
 *
 * Deliberately NOT `ompGateConfigBuilder.toOmpToolName`. That map feeds a DENY
 * list, where a Claude tool with no OMP twin must map to a name that matches
 * nothing — it sends `WebFetch` to `fetch`, a tool OMP does not have, which is
 * the harmless direction for a deny. This is the opposite direction: an allow
 * that names a non-existent tool silently grants nothing, so `WebFetch` maps to
 * `read`, which is how OMP fetches a URL (it has no fetch tool). The same
 * mapping on the gate side would deny every file read.
 */
const CLI_TOOL_TO_OMP_TOOL: Readonly<Record<CliTool, string>> = {
  Read: 'read',
  Edit: 'edit',
  Write: 'write',
  Bash: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  WebSearch: 'web_search',
  WebFetch: 'read',
};

function isOmpThinkingLevel(value: string): value is OmpThinkingLevel {
  return (OMP_THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * An effort value as OMP's thinking level, or `undefined` when OMP's scale has
 * no such rung (a Codex-only `none`, an unknown string).
 *
 * The ONE normalizer for "effort on OMP": the spawn argv's `--thinking`
 * (`OmpSdkManager.resolveThinkingLevel`) and a role file's `thinkingLevel`
 * both go through it, so a role and a session can never disagree about what
 * the same effort means. Guarded against the provider scale first so a caller
 * that skipped `normalizeEffortSelection` cannot push an unaccepted value.
 */
export function toOmpThinkingLevel(effort: string | null | undefined): OmpThinkingLevel | undefined {
  if (!effort || !isValidEffortForProvider('omp', effort)) return undefined;
  const normalized = effort.toLowerCase().trim();
  return isOmpThinkingLevel(normalized) ? normalized : undefined;
}

/** The file an agent is registered under — also its OMP agent `name` plus `.md`. */
function ompAgentFileName(agentKey: string): string {
  return `cyboflow-${agentKey}.md`;
}

export function ompAgentsDirPath(worktreeRoot: string): string {
  return path.join(worktreeRoot, ...OMP_AGENTS_DIR);
}

/**
 * The model an OMP role file may pin: ONLY an explicit OMP-runtime pin with a
 * provider model id. `agent.model` is a Claude alias and is never emitted —
 * OMP cannot route `sonnet`, and a foreign agent file carrying `model: sonnet`
 * once killed an OMP step outright. Anything else inherits the session model.
 * Routed through the spawn seam's own resolver so a cross-family id (a Claude
 * alias typed into an OMP pin) is dropped here exactly as `--model` drops it.
 */
function ompModelFor(agent: EffectiveAgent): string | undefined {
  if (!agent.runtime || providerForRuntime(agent.runtime) !== 'omp') return undefined;
  return resolveAgentModelAlias('omp', agent.providerModel);
}

/**
 * Render one effective agent as an OMP project-agent markdown file. Pure.
 *
 * Frontmatter keys, in order: name, description, tools, then the optional
 * model and thinkingLevel. Every string scalar is emitted as `JSON.stringify`
 * output — a JSON string is a valid YAML double-quoted scalar, so quotes,
 * colons, `#` and newlines in a description need no bespoke escaping, and it
 * stays on ONE line, which matters: OMP ends the frontmatter at the first
 * `\n---`, so a raw multi-line value could close it early.
 *
 * Omitted on purpose:
 *  - `enabledMcps` — a `tools:` list does not restrict MCP tools in OMP (a
 *    role limited to read/grep/glob/bash still saw every `mcp__*` tool), so
 *    there is nothing to express; the gate extension is the MCP boundary.
 *  - `spawns` — absent means the role cannot delegate, which is what a
 *    cyboflow role is (none is granted `task`).
 *  - `yield` — OMP appends it to every tools list itself.
 *  - an EMPTY tools line — OMP reads an empty list as "no restriction", the
 *    same as a missing key, and `tools: []` would read to a human as "no tools".
 */
export function renderOmpAgentMarkdown(agent: EffectiveAgent): string {
  const description =
    agent.description.trim().length > 0 ? agent.description : `Cyboflow ${agent.agentKey} role`;
  const tools = [...new Set(agent.tools.map((tool) => CLI_TOOL_TO_OMP_TOOL[tool]))];
  const model = ompModelFor(agent);
  const thinkingLevel = toOmpThinkingLevel(agent.effort);

  const lines = [
    '---',
    `name: ${JSON.stringify(`cyboflow-${agent.agentKey}`)}`,
    `description: ${JSON.stringify(description)}`,
    ...(tools.length > 0 ? [`tools: [${tools.map((tool) => JSON.stringify(tool)).join(', ')}]`] : []),
    ...(model ? [`model: ${JSON.stringify(model)}`] : []),
    ...(thinkingLevel ? [`thinkingLevel: ${JSON.stringify(thinkingLevel)}`] : []),
    '---',
  ];
  return `${lines.join('\n')}\n\n${agent.systemPrompt}`;
}

export interface WriteOmpAgentFilesOptions {
  worktreeRoot: string;
  /** The run's deployable roles; `[]` is a no-op (see writeOmpAgentFiles). */
  agents: readonly EffectiveAgent[];
  logger?: Logger;
}

/** Basenames under `.omp/agents/`, grouped by what this call did with them. */
export interface OmpAgentFilesWriteResult {
  /** Created or rewritten this call (an unchanged file is in none of the lists). */
  written: string[];
  /** Present but NOT cyboflow's (absent from the manifest) — left untouched. */
  skipped: string[];
  /** Cyboflow-owned files for roles no longer in the set, deleted this call. */
  removed: string[];
}

/**
 * Materialize `agents` into `<worktreeRoot>/.omp/agents/cyboflow-<key>.md`.
 *
 * OWNERSHIP. `.omp/agents/` is OMP's own project-agent directory, so a user may
 * keep agents there — including one they chose to call `cyboflow-something`.
 * The manifest records exactly which files cyboflow wrote: a target that exists
 * but is not in it is the user's, and is skipped with a warning rather than
 * overwritten. Only manifest-listed files are ever rewritten or deleted.
 *
 * ORDER. `.omp/` joins the worktree-local git exclude BEFORE the first file is
 * created, so there is no window in which a checkpoint `git add -A` could sweep
 * a role file into a commit.
 *
 * WRITES. Each file is rewritten only when its content differs, via a temp file
 * in the same directory plus `renameSync`, so an OMP child already running in
 * this worktree never reads a half-written role. The temp name is dot-prefixed
 * and ends in `.tmp`, so it never matches OMP's `*.md` discovery either.
 *
 * CONCURRENCY. This function is synchronous, so two calls in one main process
 * never interleave; the sprint lanes of ONE run spawn concurrently into one
 * worktree, but they resolve the same frozen definition and write byte-identical
 * content, so every lane after the first is a no-op. Two DIFFERENT runs active
 * in the same worktree at once would overwrite (and prune) each other's role
 * files — assumed not to happen, since a worktree hosts one run at a time.
 *
 * NEVER THROWS — this runs on the spawn path, and a role file that could not be
 * written must cost the run its roles, not the spawn. Every failure degrades to
 * a warning and the summary of what did land.
 */
export function writeOmpAgentFiles(options: WriteOmpAgentFilesOptions): OmpAgentFilesWriteResult {
  const { worktreeRoot, agents, logger } = options;
  const result: OmpAgentFilesWriteResult = { written: [], skipped: [], removed: [] };
  const dir = ompAgentsDirPath(worktreeRoot);
  const manifestPath = path.join(dir, OWNERSHIP_MANIFEST);

  try {
    // An empty set touches nothing — no directory, no `git` subprocess, and no
    // prune. Empty is what a resolver failure, a quick chat, or a definition-less
    // flow resolves to, and pruning on it would delete roles a sibling lane of
    // the live run may be delegating to right now. Stale roles are pruned only
    // when a NON-empty set replaces them (another flow in the same worktree).
    if (agents.length === 0) return result;

    ensureWorktreeExcludesOmpDir(worktreeRoot, logger);
    fs.mkdirSync(dir, { recursive: true });

    const previouslyOwned = readOwnershipManifest(manifestPath, logger);
    const owned = new Set<string>();
    const wanted = new Set<string>();

    // Claim every file about to be CREATED before creating it. Were the manifest
    // written only at the end, a crash or a failed manifest write in between
    // would leave new `cyboflow-*.md` files unlisted — read as the user's from
    // then on, and so never updated or pruned again. A claimed file whose
    // creation then fails drops out of the final manifest below.
    const toCreate = agents
      .map((agent) => ompAgentFileName(agent.agentKey))
      .filter((fileName) => OWNED_FILE_NAME.test(fileName) && !fs.existsSync(path.join(dir, fileName)));
    if (toCreate.length > 0) {
      writeOwnershipManifest(manifestPath, new Set([...previouslyOwned, ...toCreate]));
    }

    for (const agent of agents) {
      const fileName = ompAgentFileName(agent.agentKey);
      if (!OWNED_FILE_NAME.test(fileName)) {
        logger?.warn(`[OMP] skipping role with an unusable agent key ${JSON.stringify(agent.agentKey)}`);
        continue;
      }
      if (wanted.has(fileName)) continue;
      wanted.add(fileName);

      const target = path.join(dir, fileName);
      const exists = fs.existsSync(target);
      if (exists && !previouslyOwned.has(fileName)) {
        result.skipped.push(fileName);
        logger?.warn(
          `[OMP] ${target} exists and was not written by cyboflow; leaving it untouched, so OMP ` +
            `will run that file for ${fileName.replace(/\.md$/, '')} instead of the run's role`,
        );
        continue;
      }

      try {
        const content = renderOmpAgentMarkdown(agent);
        if (!exists || fs.readFileSync(target, 'utf8') !== content) {
          writeFileAtomic(target, content);
          result.written.push(fileName);
        }
        owned.add(fileName);
      } catch (err) {
        // A file we owned before keeps being ours even if this rewrite failed —
        // dropping it from the manifest would turn our own stale file into a
        // "user" file we could never update again.
        if (exists) owned.add(fileName);
        logger?.warn(`[OMP] could not write ${target}: ${errorMessage(err)}`);
      }
    }

    for (const fileName of previouslyOwned) {
      if (wanted.has(fileName)) continue;
      const target = path.join(dir, fileName);
      try {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { force: true });
          result.removed.push(fileName);
        }
      } catch (err) {
        owned.add(fileName); // still ours; the next spawn retries the prune
        logger?.warn(`[OMP] could not remove stale role file ${target}: ${errorMessage(err)}`);
      }
    }

    writeOwnershipManifest(manifestPath, owned);

    if (result.written.length > 0 || result.removed.length > 0) {
      logger?.info(
        `[OMP] registered ${owned.size} cyboflow role(s) in ${dir} ` +
          `(wrote ${result.written.length}, removed ${result.removed.length})`,
      );
    }
  } catch (err) {
    logger?.warn(`[OMP] could not register cyboflow roles in ${dir}: ${errorMessage(err)}`);
  }
  return result;
}

/**
 * The basenames the manifest says cyboflow owns. A missing manifest owns
 * nothing. A malformed one also owns nothing — the fail-safe direction: every
 * existing `cyboflow-*.md` then reads as the user's and is never clobbered,
 * at the cost of those roles going un-updated until someone removes them.
 */
function readOwnershipManifest(manifestPath: string, logger?: Logger): Set<string> {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const files =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).files
        : undefined;
    if (!Array.isArray(files)) throw new Error('no files array');
    const owned = new Set<string>();
    for (const entry of files) {
      if (typeof entry === 'string' && OWNED_FILE_NAME.test(entry)) owned.add(entry);
      else logger?.warn(`[OMP] ignoring invalid entry ${JSON.stringify(entry)} in ${manifestPath}`);
    }
    return owned;
  } catch (err) {
    logger?.warn(
      `[OMP] could not parse ${manifestPath} (${errorMessage(err)}); treating every existing role file as user-owned`,
    );
    return new Set();
  }
}

/**
 * Persist the ownership set, only when it changed. An empty set (every owned
 * file pruned or failed) removes the manifest instead of writing `files: []`.
 */
function writeOwnershipManifest(manifestPath: string, owned: ReadonlySet<string>): void {
  if (owned.size === 0) {
    fs.rmSync(manifestPath, { force: true });
    return;
  }
  const manifest: OwnershipManifest = { version: OWNERSHIP_MANIFEST_VERSION, files: [...owned].sort() };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== content) writeFileAtomic(manifestPath, content);
}

function writeFileAtomic(target: string, content: string): void {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Already gone or unremovable; the original error is the one worth reporting.
    }
    throw err;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
