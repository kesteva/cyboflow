/** Shared fixtures for the toolchain tests: a tiny fake toolchain on disk (no real 200 MB binaries). */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ResolvedToolchainSources } from '../toolchainResolver';

export const BUNDLED_MCP = [
  '#!/usr/bin/env node',
  '"use strict";',
  'var __commonJS = (cb, mod) => function __require() { return mod; };',
  'var net = require("net");',
  'var proc = require("node:process");',
  "equal.code = 'require(\"ajv/dist/runtime/equal\").default';",
  'const c = (0, codegen_1._)`require("ajv/dist/runtime/validation_error").default`;',
  '',
].join('\n');

export const TSC_MCP = [
  '"use strict";',
  'const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");',
  'const net = __importStar(require("net"));',
  'const orchAuthToken_1 = require("../orchAuthToken");',
  '',
].join('\n');

export function makeTempDir(prefix = 'cf-toolchain-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function writeFile(p: string, data: string | Buffer, mode = 0o644): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  fs.chmodSync(p, mode);
}

export interface FakeToolchain {
  root: string;
  resolved: ResolvedToolchainSources;
}

/** claude (exec), the MCP bundle, and a codex vendor tree with nested dirs. */
export function makeFakeToolchain(opts: { withCodex?: boolean; claudeBytes?: number } = {}): FakeToolchain {
  const root = makeTempDir();
  const claudePath = path.join(root, 'sdk', 'claude');
  writeFile(claudePath, Buffer.alloc(opts.claudeBytes ?? 3000, 7), 0o755);
  const mcpBundlePath = path.join(root, 'dist', 'cyboflowMcpServer.js');
  writeFile(mcpBundlePath, BUNDLED_MCP, 0o755);
  const vendorDir = path.join(root, 'codex', 'vendor', 'aarch64-apple-darwin');
  if (opts.withCodex !== false) {
    writeFile(path.join(vendorDir, 'bin', 'codex'), 'codex-binary', 0o755);
    writeFile(path.join(vendorDir, 'codex-path', 'rg'), 'rg-binary', 0o755);
    writeFile(path.join(vendorDir, 'codex-package.json'), '{"layoutVersion":1}', 0o644);
    writeFile(path.join(vendorDir, 'codex-resources', 'voice', 'manifest.json'), '{}', 0o600);
  }
  return {
    root,
    resolved: {
      arch: 'arm64',
      claudePath,
      claudeVersion: '0.3.284',
      mcpBundlePath,
      codex: opts.withCodex === false ? null : { target: 'aarch64-apple-darwin', version: '0.159.2', vendorDir },
      codexUnavailableReason: opts.withCodex === false ? 'not installed' : null,
    },
  };
}
