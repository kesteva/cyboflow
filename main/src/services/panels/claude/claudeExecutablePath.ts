/**
 * claudeExecutablePath — resolve the native `claude` binary shipped by
 * @anthropic-ai/claude-agent-sdk-<platform>-<arch>, accounting for ASAR packaging.
 *
 * WHY THIS EXISTS
 * ---------------
 * The SDK's query() resolves the native claude binary via require.resolve() from
 * inside its own sdk.mjs. In a packaged app sdk.mjs lives INSIDE app.asar, so
 * require.resolve returns an app.asar-INTERNAL path
 * (…/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-<arch>/claude).
 *
 * fs.existsSync() reports that path as present — Electron's asar fs shim makes
 * archive members look like real files — so the SDK's existence check passes.
 * But child_process.spawn() execve()s the literal path and FAILS with ENOTDIR,
 * because the OS cannot traverse into the app.asar archive (it is a file, not a
 * directory). The claude subprocess never starts, query() yields no messages,
 * and the SDK session appears "stuck — no reply". This only happens in packaged
 * builds; in dev node_modules is real on disk so the resolved path is spawnable.
 *
 * electron-builder unpacks the Mach-O binary to app.asar.unpacked (it must, in
 * order to codesign it individually), so a runnable copy IS on disk. We point the
 * SDK straight at it via options.pathToClaudeCodeExecutable, bypassing the SDK's
 * require.resolve-to-asar-path resolution.
 *
 * Mirrors the resolution strategy in orchestrator/mcpServer/scriptPath.ts.
 *
 * Returns undefined in dev (the SDK resolves correctly from real node_modules)
 * or when the unpacked binary cannot be located (let the SDK fall back to its
 * own resolution rather than handing it a bad path).
 *
 * Standalone-typecheck invariant: imports 'electron' only for app.isPackaged,
 * which is mocked in the Vitest setup.
 */
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

const SDK_SCOPE = '@anthropic-ai';

/**
 * Resolve the absolute, spawnable path to the native `claude` executable.
 *
 * @param overrides  Test-only hooks to drive both branches without a packaged
 *                   app: `isPackaged`, `resourcesPath`, `platform`, `arch`, and
 *                   an `existsSync` probe. Production callers pass nothing.
 */
export function resolveClaudeExecutablePath(overrides?: {
  isPackaged?: boolean;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  existsSync?: (p: string) => boolean;
}): string | undefined {
  const isPackaged = overrides?.isPackaged ?? app.isPackaged;
  if (!isPackaged) return undefined;

  const platform = overrides?.platform ?? process.platform;
  const arch = overrides?.arch ?? process.arch;
  const resourcesPath = overrides?.resourcesPath ?? process.resourcesPath;
  const exists = overrides?.existsSync ?? fs.existsSync;

  const pkg = `claude-agent-sdk-${platform}-${arch}`;
  const binName = platform === 'win32' ? 'claude.exe' : 'claude';

  const unpacked = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    SDK_SCOPE,
    pkg,
    binName,
  );

  return exists(unpacked) ? unpacked : undefined;
}
