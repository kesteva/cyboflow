import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { ResolvedCodexExecutable } from '../../../panels/codex/codexExecutablePath';
import { externalRequires, isSelfContainedMcpBundle, resolveToolchainSources } from '../toolchainResolver';
import { ToolchainUnavailableError, toolchainArchFromUname, type ToolchainArch } from '../types';
import { BUNDLED_MCP, TSC_MCP, makeTempDir, writeFile } from './fixtures';

interface Layout {
  root: string;
  pkgJson: (arch: ToolchainArch) => string;
  mcp: string;
  vendor: (arch: ToolchainArch) => string;
}

/** Dev-shaped node_modules with only the arches listed. */
function devLayout(arches: ToolchainArch[], mcpText = BUNDLED_MCP): Layout {
  const root = makeTempDir();
  const pkgDir = (arch: ToolchainArch): string => path.join(root, 'node_modules', '@anthropic-ai', `claude-agent-sdk-darwin-${arch}`);
  for (const arch of arches) {
    writeFile(path.join(pkgDir(arch), 'claude'), 'bin', 0o755);
    writeFile(path.join(pkgDir(arch), 'package.json'), JSON.stringify({ version: '0.3.284' }));
  }
  const mcp = path.join(root, 'dist', 'cyboflowMcpServer.js');
  writeFile(mcp, mcpText, 0o755);
  return {
    root,
    pkgJson: (arch) => path.join(pkgDir(arch), 'package.json'),
    mcp,
    vendor: (arch) => path.join(root, 'codex', arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'),
  };
}

function fakeCodex(layout: Layout, available: ToolchainArch[]): (arch: ToolchainArch) => ResolvedCodexExecutable {
  return (arch) => {
    if (!available.includes(arch)) throw new Error(`Cannot resolve Codex native package @openai/codex-darwin-${arch}`);
    const v = layout.vendor(arch);
    return {
      executablePath: path.join(v, 'bin', 'codex'),
      pathDir: path.join(v, 'codex-path'),
      version: '0.159.2',
      target: arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin',
    };
  };
}

function devDeps(layout: Layout, codexArches: ToolchainArch[] = ['arm64']) {
  return {
    isPackaged: false,
    resolvePackageJson: (name: string): string => {
      const m = /^@anthropic-ai\/claude-agent-sdk-darwin-(arm64|x64)$/.exec(name);
      const p = m ? layout.pkgJson(m[1] as ToolchainArch) : '';
      if (!p || !fs.existsSync(p)) throw new Error(`Cannot find module '${name}/package.json'`);
      return p;
    },
    mcpScriptPath: () => layout.mcp,
    resolveCodex: fakeCodex(layout, codexArches),
  };
}

describe('toolchainArchFromUname', () => {
  it('maps uname -m to the node arch spelling', () => {
    expect(toolchainArchFromUname('arm64')).toBe('arm64');
    expect(toolchainArchFromUname('aarch64\n')).toBe('arm64');
    expect(toolchainArchFromUname('x86_64')).toBe('x64');
    expect(toolchainArchFromUname('i386')).toBeNull();
    expect(toolchainArchFromUname('')).toBeNull();
  });
});

describe('resolveToolchainSources (dev)', () => {
  it('resolves claude, the bundled MCP server and the whole codex vendor dir for arm64', () => {
    const layout = devLayout(['arm64']);
    const r = resolveToolchainSources('arm64', devDeps(layout));
    expect(r.arch).toBe('arm64');
    expect(r.claudePath).toBe(path.join(path.dirname(layout.pkgJson('arm64')), 'claude'));
    expect(r.claudeVersion).toBe('0.3.284');
    expect(r.mcpBundlePath).toBe(layout.mcp);
    expect(r.codex).toEqual({ target: 'aarch64-apple-darwin', version: '0.159.2', vendorDir: layout.vendor('arm64') });
    expect(r.codexUnavailableReason).toBeNull();
  });

  it('throws ToolchainUnavailableError when the x64 claude package is not installed', () => {
    const layout = devLayout(['arm64']);
    let caught: unknown;
    try {
      resolveToolchainSources('x64', devDeps(layout, ['arm64', 'x64']));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolchainUnavailableError);
    const err = caught as ToolchainUnavailableError;
    expect(err.name).toBe('ToolchainUnavailableError');
    expect(err.reason).toBe('arch-missing');
    expect(err.arch).toBe('x64');
    expect(err.message).toBe('This build of cyboflow has no x64 tools');
  });

  it('treats a package dir without the claude binary as missing', () => {
    const layout = devLayout(['x64']);
    fs.rmSync(path.join(path.dirname(layout.pkgJson('x64')), 'claude'));
    expect(() => resolveToolchainSources('x64', devDeps(layout, ['x64']))).toThrow('This build of cyboflow has no x64 tools');
  });

  it('rejects an unbundled (tsc-only) MCP server file', () => {
    const layout = devLayout(['arm64'], TSC_MCP);
    let caught: unknown;
    try {
      resolveToolchainSources('arm64', devDeps(layout));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolchainUnavailableError);
    expect((caught as ToolchainUnavailableError).reason).toBe('mcp-unbundled');
    expect((caught as Error).message).toBe('The MCP server bundle is not built; run pnpm build:main');
  });

  it('rejects a missing MCP server file', () => {
    const layout = devLayout(['arm64']);
    fs.rmSync(layout.mcp);
    expect(() => resolveToolchainSources('arm64', devDeps(layout))).toThrow(/run pnpm build:main/);
  });

  it('degrades to a claude-only toolchain when codex is unavailable for the arch, saying why', () => {
    const layout = devLayout(['x64']);
    const r = resolveToolchainSources('x64', devDeps(layout, ['arm64']));
    expect(r.codex).toBeNull();
    expect(r.codexUnavailableReason).toMatch(/codex-darwin-x64/);
  });

  it('refuses an unexpected codex layout', () => {
    const layout = devLayout(['arm64']);
    const r = resolveToolchainSources('arm64', {
      ...devDeps(layout),
      resolveCodex: () => ({
        executablePath: path.join(layout.root, 'elsewhere', 'codex'),
        pathDir: path.join(layout.vendor('arm64'), 'codex-path'),
        version: '0.159.2',
        target: 'aarch64-apple-darwin',
      }),
    });
    expect(r.codex).toBeNull();
    expect(r.codexUnavailableReason).toMatch(/Unexpected Codex package layout/);
  });
});

describe('resolveToolchainSources (packaged)', () => {
  it('reads claude from app.asar.unpacked for the requested arch, not the local one', () => {
    const resources = makeTempDir();
    const pkgDir = path.join(resources, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-x64');
    writeFile(path.join(pkgDir, 'claude'), 'bin', 0o755);
    const layout = devLayout([]);
    const r = resolveToolchainSources('x64', {
      isPackaged: true,
      resourcesPath: resources,
      resolvePackageJson: () => {
        throw new Error('dev resolution must not be used when packaged');
      },
      mcpScriptPath: () => layout.mcp,
      resolveCodex: fakeCodex(layout, ['x64']),
    });
    expect(r.claudePath).toBe(path.join(pkgDir, 'claude'));
    expect(r.claudeVersion).toBeNull();
    expect(r.codex?.target).toBe('x86_64-apple-darwin');
  });

  it('a packaged build without the arch fails with ToolchainUnavailableError', () => {
    const resources = makeTempDir();
    const layout = devLayout([]);
    expect(() =>
      resolveToolchainSources('arm64', {
        isPackaged: true,
        resourcesPath: resources,
        mcpScriptPath: () => layout.mcp,
        resolveCodex: fakeCodex(layout, []),
      }),
    ).toThrow(ToolchainUnavailableError);
  });
});

describe('MCP bundle self-containment', () => {
  it('ignores require() text inside strings and template literals (ajv code generation)', () => {
    expect(externalRequires(BUNDLED_MCP)).toEqual([]);
    expect(isSelfContainedMcpBundle(BUNDLED_MCP)).toBe(true);
  });

  it('flags package and relative requires in code position', () => {
    expect(externalRequires(TSC_MCP)).toEqual(['../orchAuthToken', '@modelcontextprotocol/sdk/server/index.js']);
    expect(externalRequires("const z = require('zod');")).toEqual(['zod']);
    expect(externalRequires('x(require("ajv"))')).toEqual(['ajv']);
    expect(isSelfContainedMcpBundle('')).toBe(false);
  });

  it('accepts builtins with and without the node: prefix, including subpaths', () => {
    expect(externalRequires('require("fs/promises"); require("node:net"); require("child_process")')).toEqual([]);
  });
});

/** Smoke against this checkout's real packages (darwin dev only; CI on another platform has no darwin packages). */
const localRequire = createRequire(__filename);
function installed(name: string): boolean {
  try {
    localRequire.resolve(`${name}/package.json`);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(process.platform === 'darwin' && installed('@anthropic-ai/claude-agent-sdk-darwin-arm64'))('resolveToolchainSources (this checkout)', () => {
  it('finds the real claude binary and codex vendor tree with the default lookups', () => {
    const layout = devLayout([]);
    const r = resolveToolchainSources('arm64', { mcpScriptPath: () => layout.mcp });
    expect(path.basename(r.claudePath)).toBe('claude');
    expect(r.claudePath).toContain('claude-agent-sdk-darwin-arm64');
    if (r.codex) {
      expect(r.codex.target).toBe('aarch64-apple-darwin');
      expect(fs.existsSync(path.join(r.codex.vendorDir, 'bin', 'codex'))).toBe(true);
    }
  });
});
