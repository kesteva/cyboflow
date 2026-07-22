#!/usr/bin/env node
/**
 * driverCli — compiled entry point for `$VERIFY_DRIVER`
 * (docs/proposals/verification-agent-redesign.md §5.4 step 4). The
 * VerificationAgentRunner sets `VERIFY_DRIVER` to a command that invokes this
 * COMPILED script (`main/dist/main/src/orchestrator/verify/driver/driverCli.js`)
 * under the app's own node runtime — never under a target project's own
 * tooling, so the target project needs no playwright install.
 *
 * All logic lives in driverCore.ts (fully unit-testable with fake deps); this
 * file only wires the real deps, drives argv/env, and sets process.exit.
 *
 * Standalone invariant (mirrors preToolUseShellHook.ts / stopShellHook.ts):
 * this file is spawned as a bare child process, not through Electron's
 * module graph — driverCore.ts's real deps only touch node builtins plus a
 * lazy `import('playwright')`, never 'electron' or 'better-sqlite3'.
 */
import { createDefaultDriverDeps, runDriverCommand } from './driverCore';

export async function main(): Promise<void> {
  const deps = createDefaultDriverDeps();
  const exitCode = await runDriverCommand(process.argv.slice(2), process.env, deps);
  process.exit(exitCode);
}

// Run only when invoked directly (not when imported by a test).
if (require.main === module) {
  void main();
}
