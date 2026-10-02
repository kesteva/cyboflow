import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Ratchet: the legacy `ipcMain.handle` surface may only SHRINK.
 *
 * The declared direction for renderer↔main calls is the tRPC ipcLink
 * (docs/CODE-PATTERNS.md → "IPC handler structure"): every tRPC procedure
 * carries a zod-validated input and end-to-end types, while a raw handler gets
 * validation only if its author remembers `validateInput` (3 of ~28 modules do)
 * and its request/response types drift silently across the boundary. Freezing
 * the per-file handler counts makes the migration ratchet-shaped: migrating a
 * handler means deleting it here (and updating this map downward), while a NEW
 * raw handler — in an existing file or a new one — fails this test and should
 * be a procedure under main/src/orchestrator/trpc/routers/ instead.
 *
 * The scan is call-site-anchored on the literal `ipcMain.handle(`; a wrapper
 * that hides that call would dodge it, but the wrapper itself would have to
 * contain the literal, so the surface stays countable.
 */

/** Frozen 2026-10-02 at 109 handlers — down from 110 when
 * `panels:get-output` (`ipc/session.ts`) was deleted: its only caller was
 * useClaudePanel's Crystal output-load, whose one consumer (the slash-command
 * list) now reads the projected transcript instead.
 *
 * Earlier 2026-10-02: 110 handlers — down from 111 when the caller-less
 * `panels:emitEvent` (`ipc/panels.ts`) was deleted along with its
 * generic-invoke allowlist entry; main-side code emits panel events directly.
 *
 * Earlier 2026-10-02: 111 handlers — down from 115 when four
 * caller-less Crystal session-scoped reads/continue were deleted from
 * `ipc/session.ts`: `sessions:continue`, `sessions:get-output`,
 * `sessions:get-conversation` and `sessions:get-conversation-messages` (the
 * panel-scoped channels superseded them).
 *
 * Earlier 2026-10-02: 115 handlers — down from 126 when
 * `ipc/baseAIPanelHandler.ts` (9 never-exposed `claude-panels:*` common
 * handlers) was folded into `ipc/claudePanel.ts`, which also dropped the
 * never-exposed `claude-panels:start` / `claude-panels:continue`.
 *
 * Earlier 2026-10-02: 126 handlers — down from 128 when the orphaned
 * `claude-panels:get-substrate` / `set-substrate` bridges (`ipc/claudePanel.ts`)
 * were deleted; the per-panel substrate is set at creation via
 * CreatePanelRequest.substrate.
 *
 * Earlier 2026-10-02: 128 handlers — down from 130 when the 'Compact
 * context' feature was deleted: `sessions:generate-compacted-context`
 * (`ipc/session.ts`) and its never-exposed twin
 * `claude-panels:generate-compacted-context` (`ipc/claudePanel.ts`).
 *
 * Earlier 2026-10-02: 130 handlers — down from 137 when `ipc/folders.ts`
 * (7 `folders:*` handlers) was deleted with the vestigial sidebar project-folder
 * UI.
 *
 * Earlier 2026-10-02: 137 handlers — down from 140 when three dead granular
 * channels were deleted: `sessions:add-log` (`ipc/logs.ts`; internal producers
 * call `addSessionLog()` directly) and `ui-state:save-expanded-projects` /
 * `ui-state:save-expanded-folders` (`ipc/uiState.ts`; superseded by the
 * combined `ui-state:save-expanded`).
 *
 * Earlier 2026-10-02: 144 handlers — down from 146 when the 2
 * `dashboard:*` handlers (`ipc/dashboard.ts`) were deleted with the retired
 * per-project dashboard panel.
 *
 * Earlier 2026-10-02: 146 handlers — down from 150 when the unreachable
 * `ipc/editorPanel.ts` (4 `editor:*` handlers, never exposed in preload) was
 * deleted with the hidden Monaco editor panel.
 *
 * Frozen 2026-08-30 (150 handlers — down from 166: 16 `ipc/session.ts`
 * handlers left the raw surface in batch 1 of the session-surface IPC→tRPC
 * migration — 15 became the cyboflow.sessions tRPC router and
 * `debug:get-table-structure` was deleted outright, having had zero callers.
 * The 166 before that came from slice 3, which retired all 21 `ipc/git.ts`
 * handlers the same way.) Entries may decrease or disappear, never grow — and a
 * decrease MUST be recorded here, so the map tracks reality. */
const FROZEN_HANDLER_COUNTS: Record<string, number> = {
  'index.ts': 2,
  'ipc/app.ts': 10,
  'ipc/artifactHtml.ts': 2,
  'ipc/artifactImages.ts': 2,
  'ipc/bugReport.ts': 3,
  'ipc/claudePanel.ts': 7,
  'ipc/cyboflow.ts': 1,
  'ipc/designPrototypeServer.ts': 3,
  'ipc/dialog.ts': 2,
  'ipc/ideaAttachments.ts': 2,
  'ipc/logs.ts': 2,
  'ipc/models.ts': 4,
  'ipc/panels.ts': 15,
  'ipc/project.ts': 13,
  'ipc/providerDetection.ts': 3,
  'ipc/script.ts': 12,
  'ipc/session.ts': 20,
  'ipc/uiState.ts': 2,
  'ipc/updater.ts': 4,
};

function locateSrcRoot(): string {
  let dir = process.cwd();
  for (;;) {
    for (const candidate of [path.join(dir, 'src'), path.join(dir, 'main', 'src')]) {
      if (fs.existsSync(path.join(candidate, 'ipc', 'index.ts'))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not locate main/src from ${process.cwd()}`);
    dir = parent;
  }
}

function countHandlers(root: string): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const matches = fs.readFileSync(full, 'utf8').match(/ipcMain\.handle\(/g);
        if (matches) counts.set(path.relative(root, full).split(path.sep).join('/'), matches.length);
      }
    }
  };
  walk(root);
  return counts;
}

describe('legacy ipcMain.handle surface', () => {
  const actual = countHandlers(locateSrcRoot());

  it('no file grows its handler count, and no new file registers handlers', () => {
    const violations = [...actual.entries()]
      .filter(([file, count]) => count > (FROZEN_HANDLER_COUNTS[file] ?? 0))
      .map(
        ([file, count]) =>
          `${file}: ${count} handlers (frozen at ${FROZEN_HANDLER_COUNTS[file] ?? 0}). ` +
          `New renderer→main surface goes in a tRPC router (main/src/orchestrator/trpc/routers/), not ipcMain.handle.`,
      );
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('a migrated handler is recorded here (stale frozen entries fail)', () => {
    const stale = Object.entries(FROZEN_HANDLER_COUNTS)
      .filter(([file, frozen]) => (actual.get(file) ?? 0) < frozen)
      .map(
        ([file, frozen]) =>
          `${file}: frozen at ${frozen} but only ${actual.get(file) ?? 0} remain — lower (or delete) its entry in FROZEN_HANDLER_COUNTS`,
      );
    expect(stale, stale.join('\n')).toEqual([]);
  });
});
