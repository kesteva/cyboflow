---
id: TASK-566
idea: SPRINT-002-compound
status: ready
created: 2026-05-12T00:00:00Z
files_owned:
  - main/src/utils/devDebugLog.ts
  - main/src/index.ts
files_readonly:
  - main/src/utils/logger.ts
acceptance_criteria:
  - criterion: "New helper module main/src/utils/devDebugLog.ts exists and exports getDevDebugLogPath and appendDevDebugLog"
    verification: "test -f main/src/utils/devDebugLog.ts && grep -nE 'export function getDevDebugLogPath|export function appendDevDebugLog' main/src/utils/devDebugLog.ts returns at least 2 matches"
  - criterion: "The string literals `cyboflow-frontend-debug.log` and `cyboflow-backend-debug.log` appear in main/src ONLY inside main/src/utils/devDebugLog.ts"
    verification: "grep -rn --include='*.ts' -E 'cyboflow-(frontend|backend)-debug\\.log' main/src/ | grep -v 'main/src/utils/devDebugLog.ts' returns 0 lines"
  - criterion: "The reset-debug-logs block at main/src/index.ts:91-103 calls getDevDebugLogPath instead of hardcoded path.join calls"
    verification: "grep -nE 'getDevDebugLogPath\\(.(frontend|backend).\\)' main/src/index.ts returns at least 2 matches in the reset block region"
  - criterion: "All 6 console-override blocks (frontend webContents listener + console.log/error/warn/info/debug overrides + the dev-mode console:log IPC handler) call appendDevDebugLog instead of building debug paths inline"
    verification: "grep -nE 'fs\\.appendFileSync\\(.*cyboflow-(frontend|backend)-debug\\.log' main/src/index.ts returns 0 matches AND grep -n 'appendDevDebugLog' main/src/index.ts returns at least 6 matches"
  - criterion: "Dev-mode console:log IPC handler at lines 640-657 uses appendDevDebugLog"
    verification: "grep -n 'appendDevDebugLog' main/src/index.ts returns at least 7 matches total (6 override blocks + 1 IPC handler)"
  - criterion: "Main typecheck passes and the file count touched by this task is exactly 2 (helper file + index.ts)"
    verification: "pnpm --filter main typecheck exits 0 AND the diff in this task's commit touches exactly main/src/utils/devDebugLog.ts and main/src/index.ts"
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: true
  justification: "appendDevDebugLog is small but on the hot path of every console.* call in dev mode. A regression that mis-formats the log line, mis-routes frontend logs to backend file (or vice versa), or throws an unhandled error would either lose debugging signal silently or crash the app in dev. Two unit cases cover stream routing and format correctness."
  targets:
    - behavior: "getDevDebugLogPath('frontend') returns a path ending in 'cyboflow-frontend-debug.log' under process.cwd(); getDevDebugLogPath('backend') returns a path ending in 'cyboflow-backend-debug.log'"
      test_file: main/src/utils/devDebugLog.test.ts
      type: unit
    - behavior: "appendDevDebugLog formats the line as `[<ISO timestamp>] [<SOURCE> <LEVEL>] <message>\\n` and routes frontend stream → frontend file, backend stream → backend file (verified via a mocked fs.appendFileSync spy)"
      test_file: main/src/utils/devDebugLog.test.ts
      type: unit
---

# Extract debug-log path helpers in main/src/index.ts to eliminate 6 hardcoded path blocks

## Objective

`main/src/index.ts` constructs the dev-mode debug log path `process.cwd() + 'cyboflow-{frontend,backend}-debug.log'` in 9 places (8 hardcoded `path.join` blocks + 1 in the reset-on-startup block). Each is followed by a near-identical 12-line block formatting `[<timestamp>] [<SOURCE> <LEVEL>] <message>` and calling `fs.appendFileSync`. TASK-558 had to lockstep-edit 8 of these for the `crystal→cyboflow` filename rename. This task extracts two pure helpers — `getDevDebugLogPath(stream)` and `appendDevDebugLog(stream, level, source, message)` — into `main/src/utils/devDebugLog.ts` and replaces every hardcoded block with a call.

## Implementation Steps

1. **Sweep gate (run as step 1 every time the executor returns).** Run:
   ```
   grep -rn --include='*.ts' -E 'cyboflow-(frontend|backend)-debug\.log' main/src/
   ```
   At task start: 9 matches (all in `main/src/index.ts`). At task end: exactly 2 matches, both in `main/src/utils/devDebugLog.ts` (one for each stream's filename).

2. **Create `main/src/utils/devDebugLog.ts`** (new file):
   ```typescript
   /**
    * Dev-mode debug log helpers. In `pnpm dev` the main process appends
    * console output to `cyboflow-{frontend,backend}-debug.log` files at the
    * project root so the AI assistant can read them without asking the user
    * to paste console output. Production builds do not call these helpers.
    *
    * Centralizing here keeps the filename literals in exactly one site —
    * future rebrand or path changes touch one file instead of nine.
    */
   import * as fs from 'fs';
   import * as path from 'path';

   export type DevLogStream = 'frontend' | 'backend';
   export type DevLogLevel = 'log' | 'error' | 'warn' | 'info' | 'debug' | 'verbose';

   const FILENAMES: Record<DevLogStream, string> = {
     frontend: 'cyboflow-frontend-debug.log',
     backend: 'cyboflow-backend-debug.log',
   };

   /**
    * Returns the absolute path to the dev-mode debug log for the given stream.
    * Resolves against process.cwd() to match the existing convention (logs land
    * in the project root regardless of where the Electron binary was launched).
    */
   export function getDevDebugLogPath(stream: DevLogStream): string {
     return path.join(process.cwd(), FILENAMES[stream]);
   }

   /**
    * Appends one formatted line to the appropriate dev-mode debug log.
    * Format: `[<ISO timestamp>] [<SOURCE> <LEVEL>] <message>\n`
    * (matches the format the AI assistant reads in `pnpm dev`).
    *
    * Failures are swallowed and logged via originalConsole to avoid the
    * console-override recursion that the index.ts wrapper guards against.
    */
   export function appendDevDebugLog(
     stream: DevLogStream,
     level: DevLogLevel,
     source: string,
     message: string,
     originalConsole?: { error?: (...args: unknown[]) => void }
   ): void {
     const timestamp = new Date().toISOString();
     const line = `[${timestamp}] [${source.toUpperCase()} ${level.toUpperCase()}] ${message}\n`;
     try {
       fs.appendFileSync(getDevDebugLogPath(stream), line);
     } catch (error) {
       if (originalConsole?.error) {
         originalConsole.error(`[devDebugLog] Failed to write to ${stream} debug log:`, error);
       }
     }
   }
   ```
   Contract notes:
   - The `originalConsole` parameter is **optional** — most callers in `index.ts` will pass it because they're inside console-override handlers where the wrapper risks infinite recursion if it calls the wrapped `console.error`. Callers outside the override hot path (e.g., the reset-on-startup block) can omit it.
   - The format is `[<timestamp>] [<SOURCE-UPPERCASE> <LEVEL-UPPERCASE>] <message>` — exactly matching the existing format from `index.ts:229` (`[FRONTEND ERROR]`, `[BACKEND LOG]`, etc.). Test asserts byte-level equivalence.
   - Frontend-from-renderer messages (currently appended at L235 with `(${path.basename(sourceId)}:${line})` suffix) — the helper does NOT add that suffix; the caller continues to append it inline so we don't widen the API for one specific call site.

3. **Update `main/src/index.ts:91-103` (reset block).** Replace `const frontendLogPath = path.join(process.cwd(), 'cyboflow-frontend-debug.log')` and the parallel backend line with:
   ```typescript
   import { getDevDebugLogPath } from './utils/devDebugLog'; // add to existing imports near top of file
   // …
   const frontendLogPath = getDevDebugLogPath('frontend');
   const backendLogPath = getDevDebugLogPath('backend');
   ```
   The `fs.writeFileSync(frontendLogPath, '')` and `fs.writeFileSync(backendLogPath, '')` calls remain unchanged.

4. **Update the renderer console listener (`index.ts:218-248`).** The frontend-source path is built at L234 and the format at L229. Replace the inline `path.join` + `fs.appendFileSync` block with a call to `appendDevDebugLog`, then append the `(${path.basename(sourceId)}:${line})` suffix as a second line if the existing format is to be preserved verbatim. Concretely:
   ```typescript
   // Inside the existing if (isDevelopment) block:
   const levelNames = ['verbose', 'info', 'warning', 'error'];
   const levelName = levelNames[level] || 'unknown';
   const suffix = ` (${path.basename(sourceId)}:${line})`;
   appendDevDebugLog('frontend', levelName as DevLogLevel, 'FRONTEND', `${message}${suffix}`, { error: originalError });
   ```
   This consolidates the timestamp/format construction into the helper while preserving the source-file suffix the existing format carries.

5. **Update the 5 console method overrides (`index.ts:251-493` — log, error, warn, info, debug).** Each currently builds `const debugLogPath = path.join(process.cwd(), 'cyboflow-backend-debug.log')` and calls `fs.appendFileSync` inside `if (isDevelopment)`. Replace each with a single `appendDevDebugLog` call. Example for the `console.log` override (L264-277):
   ```typescript
   if (isDevelopment) {
     appendDevDebugLog('backend', 'log', 'BACKEND', message, { error: originalError });
   }
   ```
   Repeat for `console.error` (passing level `'error'`, source `'BACKEND'`), `console.warn` (`'warn'` / `'BACKEND'`), `console.info` (`'info'` / `'BACKEND'`), `console.debug` (`'debug'` / `'BACKEND'`). The `originalConsole` arg always passes the captured original (`originalError` / `originalWarn` / etc.) to preserve the recursion guard.

6. **Update the dev-mode IPC handler (`index.ts:639-657`).** This block builds the path at L647 and writes at L649. Replace with:
   ```typescript
   if (isDevelopment) {
     ipcMain.handle('console:log', (event, logData) => {
       const { level, args, timestamp: _ts, source } = logData; // helper rebuilds its own ISO timestamp; original `timestamp` ignored for format uniformity
       const message = args.join(' ');
       appendDevDebugLog('frontend', level as DevLogLevel, source, message);
       console.log(`[Frontend ${level}] ${message}`); // unchanged
     });
   }
   ```
   Note: the existing code uses the caller-supplied `timestamp` (`logData.timestamp`); the helper uses its own `new Date().toISOString()`. This is a **minor format change** — the timestamp now reflects when the main process appends, not when the renderer captured. If preserving the renderer timestamp matters (it does not for AI-debug-log readers in practice), pass it through as a separate arg. Default decision: accept the helper's timestamp; if a verifier flags drift, add an optional `timestamp?: string` arg to the helper.

7. **Re-run sweep grep from step 1.** Expected: exactly 2 matches, both inside `main/src/utils/devDebugLog.ts` (the `FILENAMES` record).

8. **Create `main/src/utils/devDebugLog.test.ts`** (new file):
   ```typescript
   import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
   import * as fs from 'fs';
   import * as path from 'path';
   import { getDevDebugLogPath, appendDevDebugLog } from './devDebugLog';

   describe('getDevDebugLogPath', () => {
     it('returns process.cwd()/cyboflow-frontend-debug.log for frontend', () => {
       const p = getDevDebugLogPath('frontend');
       expect(p).toBe(path.join(process.cwd(), 'cyboflow-frontend-debug.log'));
     });
     it('returns process.cwd()/cyboflow-backend-debug.log for backend', () => {
       const p = getDevDebugLogPath('backend');
       expect(p).toBe(path.join(process.cwd(), 'cyboflow-backend-debug.log'));
     });
   });

   describe('appendDevDebugLog', () => {
     let appendSpy: ReturnType<typeof vi.spyOn>;
     beforeEach(() => {
       appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
     });
     afterEach(() => {
       appendSpy.mockRestore();
     });

     it('writes a formatted line to the frontend file', () => {
       appendDevDebugLog('frontend', 'log', 'FRONTEND', 'hello');
       expect(appendSpy).toHaveBeenCalledOnce();
       const [calledPath, calledLine] = appendSpy.mock.calls[0];
       expect(calledPath).toBe(getDevDebugLogPath('frontend'));
       expect(calledLine).toMatch(/^\[.*\] \[FRONTEND LOG\] hello\n$/);
     });

     it('writes a formatted line to the backend file with the correct level uppercased', () => {
       appendDevDebugLog('backend', 'error', 'BACKEND', 'oops');
       const [calledPath, calledLine] = appendSpy.mock.calls[0];
       expect(calledPath).toBe(getDevDebugLogPath('backend'));
       expect(calledLine).toMatch(/^\[.*\] \[BACKEND ERROR\] oops\n$/);
     });

     it('swallows appendFileSync errors and calls originalConsole.error if provided', () => {
       appendSpy.mockImplementation(() => { throw new Error('boom'); });
       const errSpy = vi.fn();
       expect(() => appendDevDebugLog('frontend', 'log', 'X', 'm', { error: errSpy })).not.toThrow();
       expect(errSpy).toHaveBeenCalled();
     });
   });
   ```

9. **Run `pnpm --filter main typecheck` and `pnpm --filter main test`.** Both must exit 0.

## Acceptance Criteria

See frontmatter. Compound rule: the debug-log filename literals exist in exactly one source file, and the 6 console-override blocks + reset block all delegate to the helper.

## Test Strategy

See frontmatter `test_strategy.targets`. Vitest cases assert path resolution, line-format byte-equivalence, and the error-swallowing recursion-guard contract. The helper is small enough to fully unit-test; integration coverage of the dev-mode log routing is already implicit in `pnpm dev` workflow.

## Hardest Decision

Whether to route the helper through `main/src/utils/logger.ts` (the existing rolling-file logger with 10MB rotation and 5-file retention) instead of standalone `fs.appendFileSync`. **Decision: standalone helper, not logger-routed.** Three reasons: (1) the dev-mode debug logs have explicit per-launch reset semantics (`fs.writeFileSync(path, '')` at startup, L96-98) that conflict with logger.ts's append-and-rotate model — wiring logger.ts to support a "reset on init" mode would be a bigger change than this task. (2) logger.ts writes to `~/.cyboflow/logs/`, not project-root — the AI-assistant convention reads from project root (per `CLAUDE.md` "Frontend/Backend Debug Logs" block), so changing the path would break the documented workflow. (3) The current implementation uses synchronous `appendFileSync` deliberately to avoid losing the last log lines on crash; logger.ts uses an async write queue that drops late writes during shutdown. Both behaviors are correct for their purpose; mixing them is wrong. The "Optional: route through logger.ts" hint in the compounder direction is rejected.

## Rejected Alternatives

- **Inline the helper as a top-of-file local function in `index.ts` (no new module).** Rejected: index.ts is already 1000+ lines; extracting into `main/src/utils/` matches the existing pattern (shellEscape.ts, logger.ts, devDebugLog.ts as siblings) and the file is testable in isolation only as a separate module.
- **Use `console.log = …` wrappers that auto-route via the helper based on a side-table.** Rejected: too clever; preserves the obvious imperative call-per-block structure which matches the existing reviewer's mental model.
- **Pass through the renderer-supplied timestamp in the IPC handler.** Rejected for now (see step 6 note). If a verifier flags it, the helper can grow an optional `timestamp` arg in a 1-line change.

## Lowest Confidence Area

The frontend renderer console listener (step 4) — it appends a `(${path.basename(sourceId)}:${line})` suffix that no other call site uses. The current step builds the suffix outside the helper and concatenates it onto the message. An alternative is to give the helper a "suffix" parameter or to leave this one call site outside the helper entirely. The chosen approach keeps the helper API narrow while preserving format compatibility — but a reviewer might prefer one of the alternatives. Secondary uncertainty: the dev-mode IPC handler's caller-supplied timestamp (step 6) is dropped by the helper. If anyone is currently relying on that timestamp matching the renderer's clock (rare in practice — renderer and main run in the same process tree, clocks are aligned), they'll see a slightly different value after this lands. The "boring fix" is to add an optional `timestamp?` arg to the helper if that turns out to matter.
