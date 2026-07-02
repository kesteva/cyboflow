/**
 * verifyConfigLoader — the SOLE reader of a project's `.cyboflow/verify.json`
 * (see docs/visual-verification-design.md §"Config homes" + #6).
 *
 * `.cyboflow/verify.json` is the per-project, per-deliverable "how to run this"
 * product config that travels WITH the deliverable at the project root (sibling
 * to `.cyboflow/artifacts`) — deliberately NOT in `.claude/settings.json` or the
 * DB. This loader is SHARED INFRA: the createRun stamp reads its
 * `enabled` / `defaultType` for the project rungs of the resolver ladder; the
 * S2 dev-server runner reads each deliverable's `build` / `start` / `readyWhen`;
 * the S5 baselines read `baselineKey`. One reader, one fail-soft contract.
 *
 * Fail-soft contract (never throws, never fatal):
 *   - file absent (ENOENT)  → return null (an absent config is the common case).
 *   - malformed JSON        → logger?.warn + return null (a typo must not wedge a
 *                             run launch; the run simply resolves the disabled /
 *                             floor posture as if no config existed).
 *   - valid JSON            → return the parsed object typed as VerifyConfigFile.
 *
 * Standalone-typecheck invariant: imports ONLY node:fs/promises (readFile),
 * node:path (join), the shared verify types, and the orchestrator LoggerLike. NO
 * electron, NO better-sqlite3, NO services/* — fs/promises is explicitly allowed
 * for orchestrator modules (same as runFileExplorer / runLauncher).
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  DeliverableVerifyConfig,
  VerifyConfigFile,
} from '../../../shared/types/visualVerification';
import type { LoggerLike } from './types';

/**
 * The project-root-relative path of the verify config. A single constant so the
 * loader, future writers, and tests reference one canonical location.
 */
export const VERIFY_CONFIG_RELATIVE_PATH = '.cyboflow/verify.json';

/**
 * Narrow type guard for the Node `ENOENT` error (file absent). Avoids an `any`
 * cast on the caught error while keeping the absent-file path distinct from a
 * genuine read failure.
 */
function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Load + parse `<projectPath>/.cyboflow/verify.json`.
 *
 * @param projectPath absolute path to the project root.
 * @param logger      optional structured logger; a malformed-JSON warning is
 *                    emitted through it when supplied (omitted = silent fail-soft).
 * @returns the parsed VerifyConfigFile, or null when the file is absent or
 *          unparseable. NEVER throws.
 */
export async function loadVerifyConfig(
  projectPath: string,
  logger?: LoggerLike,
): Promise<VerifyConfigFile | null> {
  const configPath = join(projectPath, VERIFY_CONFIG_RELATIVE_PATH);

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    // Absent config is not an error — it is the common, expected case.
    if (isFileNotFound(err)) {
      return null;
    }
    // Any OTHER read failure (permissions, a directory in the way, an I/O error)
    // is also fail-soft: the launch must never wedge on a config read. Surface it
    // through the logger so it is diagnosable, then resolve as if absent.
    logger?.warn('verifyConfigLoader: failed to read verify.json', {
      configPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  try {
    // The on-disk shape is trusted to match VerifyConfigFile (every member is
    // optional, so a partial / empty object is valid). Downstream consumers
    // (resolver, dev-server runner, baselines) defensively read each field.
    const parsed = JSON.parse(raw) as VerifyConfigFile;
    return parsed;
  } catch (err) {
    logger?.warn('verifyConfigLoader: failed to parse verify.json (malformed JSON)', {
      configPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Matches a `${PORT}` / `$PORT` placeholder in a deliverable `url` template. Kept
 * a module constant so the template→regex compile references one spelling. The
 * `${PORT}` alternative is listed FIRST so a `${PORT}` literal is consumed whole
 * (never split as a bare `$PORT` prefix). Global so a template with several
 * placeholders replaces every one.
 */
const PORT_PLACEHOLDER = /\$\{PORT\}|\$PORT/g;

/** Escape a literal string for embedding in a RegExp source (no `any`, no deps). */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a deliverable `url` template into a prefix-anchored RegExp, treating the
 * `${PORT}` / `$PORT` placeholder as a numeric wildcard, or null when the template
 * carries no placeholder (a concrete url — matched by exact string, never here).
 *
 * The port wildcard is `\d{2,5}(?![0-9])`: 2–5 digits NOT followed by another
 * digit, so a non-numeric (`:abc`) or out-of-range (`:1`, `:123456`) port shape is
 * rejected rather than partially matched. The rest of the template is escaped
 * literally and the whole is anchored at the START only — a request url matches
 * when it shares the template's host+port+PATH PREFIX (e.g. the template
 * `http://localhost:${PORT}/app` matches `http://localhost:29260/app/sub`), while a
 * different host or scheme never matches (the literal segments differ).
 */
function portTemplateToRegex(template: string): RegExp | null {
  PORT_PLACEHOLDER.lastIndex = 0;
  if (!PORT_PLACEHOLDER.test(template)) return null;
  // split() on a group-free global regex drops the separators, so each surviving
  // segment is literal text to escape; rejoin with the numeric port wildcard.
  const escaped = template.split(PORT_PLACEHOLDER).map(escapeRegExp).join('\\d{2,5}(?![0-9])');
  return new RegExp(`^${escaped}`);
}

/** Resolve a possibly-relative deliverable/request path to an absolute path against `root`. */
function toAbsolute(root: string, p: string): string {
  return resolve(root, p);
}

/**
 * HONEST deliverable matching — resolve which verify.json deliverable a request
 * targets, or null when NONE genuinely does (there is deliberately NO
 * "first startable" consolation fallback — a non-match must leave the request's own
 * url/htmlPath capture untouched rather than bind + spawn an unrelated deliverable).
 *
 * Match order (first hit wins):
 *   (a) htmlPath EXACT — both the request htmlPath and each deliverable htmlPath are
 *       normalized to absolute against `checkoutRoot`, then compared.
 *   (b) url EXACT — the request url equals a deliverable url string verbatim.
 *   (c) url TEMPLATE — a deliverable url containing `${PORT}`/`$PORT` matches the
 *       request url on host+port+path-prefix (portTemplateToRegex).
 *   (d) NO url AND NO htmlPath on the request AND EXACTLY ONE startable deliverable
 *       (a `start` command) — the hydration-driven case where the agent passed only
 *       intent/taskRef; two-or-more startables is ambiguous ⇒ null.
 *
 * Pure over shared types + node:path — no fs/electron — so it is unit-testable
 * without a runtime (standalone-typecheck invariant).
 */
export function matchDeliverable(
  config: VerifyConfigFile | null,
  input: { url?: string; htmlPath?: string },
  checkoutRoot: string,
): DeliverableVerifyConfig | null {
  const deliverables = config?.deliverables ?? [];
  if (deliverables.length === 0) return null;

  const reqUrl = input.url?.trim();
  const reqHtmlPath = input.htmlPath?.trim();

  // (a) htmlPath exact (normalized absolute against the config's checkout root).
  if (reqHtmlPath && reqHtmlPath.length > 0) {
    const wantAbs = toAbsolute(checkoutRoot, reqHtmlPath);
    const byHtml = deliverables.find(
      (d) => d.htmlPath && toAbsolute(checkoutRoot, d.htmlPath) === wantAbs,
    );
    if (byHtml) return byHtml;
  }

  if (reqUrl && reqUrl.length > 0) {
    // (b) url exact string match.
    const byUrl = deliverables.find((d) => d.url === reqUrl);
    if (byUrl) return byUrl;
    // (c) url template match (`${PORT}` as a numeric wildcard, host+port+path prefix).
    const byTemplate = deliverables.find((d) => {
      if (!d.url) return false;
      const re = portTemplateToRegex(d.url);
      return re ? re.test(reqUrl) : false;
    });
    if (byTemplate) return byTemplate;
  }

  // (d) hydration-driven: no target on the request + exactly one startable deliverable.
  const hasTarget = Boolean((reqUrl && reqUrl.length > 0) || (reqHtmlPath && reqHtmlPath.length > 0));
  if (!hasTarget) {
    const startable = deliverables.filter((d) => d.start && d.start.trim().length > 0);
    if (startable.length === 1) return startable[0];
  }

  // No honest match — the caller captures the request's own url/htmlPath unchanged.
  return null;
}

/**
 * WORKTREE-FIRST deliverable context resolution (locked seam for the index.ts
 * devServerContextResolver closure — the closure supplies the worktree/project
 * paths from the DB, this helper does all the fs + matching so it is unit-testable
 * without electron).
 *
 * Config load precedence (locked decision #1): a run's build/start commands execute
 * in its WORKTREE, so a deliverable recipe added/edited by the very branch under
 * verification must be read from the worktree — not the project ROOT checkout.
 *   1. When `worktreePath` is set, load `<worktree>/.cyboflow/verify.json`; if that
 *      yields a usable config (present + parseable — loadVerifyConfig returns
 *      non-null), the worktree WINS and `cwd = worktreePath`.
 *   2. Otherwise (no worktree path / worktree has no verify.json / it is malformed)
 *      fall back to `<projectPath>/.cyboflow/verify.json` with `cwd = projectPath`.
 * The returned `cwd` is ALWAYS the same checkout the winning config was loaded from,
 * so the recipe and its execution can never disagree.
 *
 * Then matchDeliverable picks the deliverable the request genuinely targets;
 * a null match (or an absent config) returns null — the request captures its own
 * url/htmlPath unchanged (no dev-server context, no unrelated-deliverable binding).
 */
export async function resolveDeliverableContext(
  args: {
    worktreePath: string | null;
    projectPath: string;
    input: { url?: string; htmlPath?: string };
  },
  logger?: LoggerLike,
): Promise<{ cwd: string; deliverable: DeliverableVerifyConfig } | null> {
  let config: VerifyConfigFile | null = null;
  let cwd = args.projectPath;

  if (args.worktreePath && args.worktreePath.trim().length > 0) {
    const worktreeConfig = await loadVerifyConfig(args.worktreePath, logger);
    if (worktreeConfig) {
      config = worktreeConfig;
      cwd = args.worktreePath;
    }
  }
  if (!config) {
    config = await loadVerifyConfig(args.projectPath, logger);
    cwd = args.projectPath;
  }

  const deliverable = matchDeliverable(config, args.input, cwd);
  if (!deliverable) return null;
  return { cwd, deliverable };
}
