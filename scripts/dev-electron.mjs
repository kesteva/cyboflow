#!/usr/bin/env node
/**
 * dev-electron — cross-platform Electron launcher for the dev scripts.
 *
 * Node implementation so `pnpm dev`'s Electron half starts from cmd.exe too
 * (no `${VAR:-}` / `env -u` shell syntax). Same net effect on every platform:
 *   1. waits for the Vite dev server (port 4521, CYBOFLOW_VITE_PORT override);
 *   2. strips NODE_OPTIONS from the child env — the Electron binary rejects
 *      some host-Node-only flags;
 *   3. spawns the real Electron binary on the repo root, forwarding every
 *      flag not owned below, with stdio piped through.
 *
 * Flags owned by this script (never forwarded verbatim): --cdp appends
 * `--remote-debugging-port=<CYBOFLOW_CDP_PORT || 9223>`, --inspect appends
 * `--inspect=<CYBOFLOW_INSPECT_PORT || 9229>`, --perf sets
 * CYBOFLOW_PERF_TRACE=1 in the child env. Exits with the child's exit code;
 * signal handling keeps the wrapper (and `concurrently`, which waits on it)
 * from hanging after Ctrl+C — see the exit handler.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

const wants = (flag) => argv.includes(flag);
const forwarded = argv.filter((a) => !['--cdp', '--inspect', '--perf'].includes(a));
const cdpPort = process.env.CYBOFLOW_CDP_PORT || '9223';
const inspectPort = process.env.CYBOFLOW_INSPECT_PORT || '9229';
const vitePort = process.env.CYBOFLOW_VITE_PORT || '4521';

if (wants('--cdp')) forwarded.push(`--remote-debugging-port=${cdpPort}`);
if (wants('--inspect')) forwarded.push(`--inspect=${inspectPort}`);

// The electron npm package resolves to the binary path string when required
// from plain Node (outside Electron itself).
const require = createRequire(import.meta.url);
const electronBinary = require('electron');
if (typeof electronBinary !== 'string' || !electronBinary) {
  console.error('[dev-electron] could not resolve the electron binary — run pnpm install first');
  process.exit(1);
}

/**
 * Poll the Vite server; any HTTP response means it is up. The status is not
 * checked — a connection error is the real "not up yet" signal.
 */
async function waitOnVite() {
  const deadline = Date.now() + 120_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${vitePort}/`);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.error(`[dev-electron] Vite dev server on :${vitePort} did not come up within 120s (${lastError})`);
  process.exit(1);
}

await waitOnVite();

const childEnv = { ...process.env };
if (wants('--perf')) childEnv.CYBOFLOW_PERF_TRACE = '1';
// env -u NODE_OPTIONS equivalent — see header, point 2.
delete childEnv.NODE_OPTIONS;

const child = spawn(electronBinary, ['.', ...forwarded], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: childEnv,
});

/** True once the child has exited (by code or by signal). */
function childIsDead() {
  return child.exitCode !== null || child.signalCode !== null;
}

child.on('exit', (code, signal) => {
  if (!signal) {
    process.exit(code ?? 0);
  }
  // The child died FROM a signal, so re-raise the same one here to exit the
  // shell-conventional way. Our own handlers come off first: a handled signal
  // kills nothing, so leaving them installed would hang this wrapper and the
  // `concurrently` that waits on it.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.kill(process.pid, signal);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (childIsDead()) return; // exit handler owns the process now
    child.kill(sig);
  });
}
