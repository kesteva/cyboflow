/**
 * toolchainResolver — find the LOCAL source of every toolchain artifact for a remote arch (spec A5).
 *
 *  - claude: the native binary of `@anthropic-ai/claude-agent-sdk-darwin-<arch>`. Dev resolves the package from
 *    main's node_modules (require.resolve of its package.json); packaged reads the asar-UNPACKED copy, exactly the
 *    shape of claudeExecutablePath.ts (an app.asar-internal path is not a real file). Unlike that resolver this
 *    one takes the arch as a parameter: the remote may differ from this Mac. Missing → ToolchainUnavailableError
 *    ('arch-missing'), since per-arch DMGs normally ship only their own arch.
 *  - MCP bundle: resolveMcpServerScriptPath(), and it MUST be the esbuild bundle (scripts/bundle-mcp-server.mjs),
 *    because the remote has no node_modules. The bundler writes no marker, so bundledness is checked
 *    structurally: every `require("…")` CALL in the file must name a node builtin. tsc output fails that
 *    (`require("@modelcontextprotocol/sdk/…")`, `require("../orchAuthToken")`), while the code-generation strings
 *    ajv carries inside the bundle (`'require("ajv/dist/runtime/equal")'`, a template literal) are skipped
 *    because a quote or backtick precedes them. Not bundled → ToolchainUnavailableError ('mcp-unbundled').
 *  - codex: resolveCodexExecutablePath() for darwin/<arch>; the WHOLE `vendor/<target>/` directory is pushed
 *    (binary, codex-path helpers, resources). Codex is optional: when this build lacks it for the arch the
 *    toolchain is claude-only and `codexUnavailableReason` says why.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { app } from 'electron';
import { resolveMcpServerScriptPath } from '../../../orchestrator/mcpServer/scriptPath';
import {
  resolveCodexExecutablePath,
  type ResolvedCodexExecutable,
} from '../../panels/codex/codexExecutablePath';
import { CODEX_ENTRYPOINT_REL, CODEX_PATH_DIR_REL, ToolchainUnavailableError, type ToolchainArch } from './types';

const SDK_SCOPE = '@anthropic-ai';
/** The bundle is ~1.5 MB; anything far larger is not the file we expect. */
const MAX_MCP_BUNDLE_BYTES = 64 * 1024 * 1024;

export interface ResolvedCodexSource {
  /** e.g. `aarch64-apple-darwin`. */
  target: string;
  version: string;
  /** Absolute `…/vendor/<target>` directory; pushed whole to `<hash>/codex/<target>/`. */
  vendorDir: string;
}

export interface ResolvedToolchainSources {
  arch: ToolchainArch;
  claudePath: string;
  claudeVersion: string | null;
  mcpBundlePath: string;
  codex: ResolvedCodexSource | null;
  /** Why `codex` is null (readable, local paths only); null when codex resolved. */
  codexUnavailableReason: string | null;
}

export interface ToolchainResolverDeps {
  isPackaged?: boolean;
  resourcesPath?: string;
  /** Dev: absolute path of `<name>/package.json`; throws when the package is not installed. */
  resolvePackageJson?: (name: string) => string;
  isFile?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
  fileSize?: (p: string) => number;
  mcpScriptPath?: () => string;
  resolveCodex?: (arch: ToolchainArch) => ResolvedCodexExecutable;
}

const defaultRequire = createRequire(__filename);

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

function isBuiltinSpecifier(spec: string): boolean {
  if (spec.startsWith('node:')) return true;
  return BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]);
}

/**
 * A `require("x")` / `require('x')` call in CODE position: not preceded by an identifier char, `.`, or a quote /
 * backtick (which would make it text inside a string — ajv's generated-code snippets).
 */
const REQUIRE_CALL_RE = /(^|[^\w$.'"`])require\(\s*(['"])([^'"\n]+)\2\s*\)/gm;

/** The non-builtin modules `source` requires at runtime; empty for a self-contained bundle. */
export function externalRequires(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(REQUIRE_CALL_RE)) {
    const spec = m[3];
    if (!isBuiltinSpecifier(spec)) out.add(spec);
  }
  return [...out].sort();
}

export function isSelfContainedMcpBundle(source: string): boolean {
  return source.length > 0 && externalRequires(source).length === 0;
}

function resolveClaude(
  arch: ToolchainArch,
  deps: Required<Pick<ToolchainResolverDeps, 'isPackaged' | 'resolvePackageJson' | 'isFile' | 'readFileSync'>> & {
    resourcesPath: string | undefined;
  },
): { claudePath: string; claudeVersion: string | null } {
  const pkg = `${SDK_SCOPE}/claude-agent-sdk-darwin-${arch}`;
  let pkgDir: string;
  if (deps.isPackaged) {
    if (!deps.resourcesPath) throw new ToolchainUnavailableError('arch-missing', arch);
    pkgDir = path.join(deps.resourcesPath, 'app.asar.unpacked', 'node_modules', SDK_SCOPE, `claude-agent-sdk-darwin-${arch}`);
  } else {
    try {
      pkgDir = path.dirname(deps.resolvePackageJson(pkg));
    } catch {
      throw new ToolchainUnavailableError('arch-missing', arch);
    }
  }
  const claudePath = path.join(pkgDir, 'claude');
  if (!deps.isFile(claudePath)) throw new ToolchainUnavailableError('arch-missing', arch);
  let claudeVersion: string | null = null;
  try {
    const parsed: unknown = JSON.parse(deps.readFileSync(path.join(pkgDir, 'package.json')));
    if (parsed && typeof parsed === 'object' && typeof (parsed as { version?: unknown }).version === 'string') {
      claudeVersion = (parsed as { version: string }).version;
    }
  } catch {
    /* the version is informational only */
  }
  return { claudePath, claudeVersion };
}

function resolveCodexSource(
  arch: ToolchainArch,
  resolve: (arch: ToolchainArch) => ResolvedCodexExecutable,
): { codex: ResolvedCodexSource | null; reason: string | null } {
  let resolved: ResolvedCodexExecutable;
  try {
    resolved = resolve(arch);
  } catch (e) {
    return { codex: null, reason: errorMessage(e) };
  }
  const vendorDir = path.dirname(resolved.pathDir);
  if (
    path.basename(resolved.pathDir) !== CODEX_PATH_DIR_REL ||
    resolved.executablePath !== path.join(vendorDir, ...CODEX_ENTRYPOINT_REL.split('/'))
  ) {
    return { codex: null, reason: `Unexpected Codex package layout at ${vendorDir}` };
  }
  return { codex: { target: resolved.target, version: resolved.version, vendorDir }, reason: null };
}

/** Resolve every local source for `arch`. Throws ToolchainUnavailableError for a missing claude / unbundled MCP. */
export function resolveToolchainSources(arch: ToolchainArch, deps: ToolchainResolverDeps = {}): ResolvedToolchainSources {
  const isPackaged = deps.isPackaged ?? app.isPackaged;
  const resourcesPath = deps.resourcesPath ?? (isPackaged ? process.resourcesPath : undefined);
  const readFileSync = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const isFile = deps.isFile ?? defaultIsFile;
  const fileSize = deps.fileSize ?? ((p: string) => fs.statSync(p).size);

  const { claudePath, claudeVersion } = resolveClaude(arch, {
    isPackaged,
    resourcesPath,
    resolvePackageJson: deps.resolvePackageJson ?? ((name) => defaultRequire.resolve(`${name}/package.json`)),
    isFile,
    readFileSync,
  });

  const mcpBundlePath = (deps.mcpScriptPath ?? (() => resolveMcpServerScriptPath()))();
  let bundled = false;
  try {
    bundled = isFile(mcpBundlePath) && fileSize(mcpBundlePath) <= MAX_MCP_BUNDLE_BYTES &&
      isSelfContainedMcpBundle(readFileSync(mcpBundlePath));
  } catch {
    bundled = false;
  }
  if (!bundled) throw new ToolchainUnavailableError('mcp-unbundled', arch);

  const resolveCodex = deps.resolveCodex ?? ((a: ToolchainArch) => resolveCodexExecutablePath({
    process: { platform: 'darwin', arch: a, resourcesPath },
    isPackaged,
  }));
  const { codex, reason } = resolveCodexSource(arch, resolveCodex);

  return { arch, claudePath, claudeVersion, mcpBundlePath, codex, codexUnavailableReason: reason };
}
