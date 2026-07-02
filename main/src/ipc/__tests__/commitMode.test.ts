/**
 * Behavioral tests for commit-mode IPC handlers (main/src/ipc/commitMode.ts).
 *
 * Covered:
 *  - commit-mode:update-session-settings round-trips a CommitModeSettings object
 *    into the DB as JSON UNCHANGED (mode column + serialized settings), so an
 *    optional field like allowClaudeTools survives the write→read cycle.
 *  - commit-mode:check-checkpoint-warning returns a usable default
 *    ({ shouldWarn: false }) instead of throwing when the underlying
 *    commitManager probe fails — the "failure returns usable default (no throw)"
 *    contract.
 *  - commit-mode:get-project-characteristics: success path returns the detector
 *    output verbatim; a detector failure REJECTS (current behavior — see the
 *    deviation note in the return).
 *
 * The handlers register against the module-scoped `ipcMain` from electron, so the
 * electron module is mocked with a handle() spy and the handlers are recovered
 * from its mock.calls. Service singletons (projectDetection, commitManager) are
 * mocked at the module level.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommitModeSettings, ProjectCharacteristics } from '../../../../shared/types';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../../services/projectDetection', () => ({
  projectDetectionService: {
    detectProjectCharacteristics: vi.fn(),
    getModeRecommendationReason: vi.fn(() => 'reason'),
  },
}));

vi.mock('../../services/commitManager', () => ({
  commitManager: {
    shouldWarnAboutCheckpointMode: vi.fn(),
    finalizeSession: vi.fn(),
    getPromptEnhancement: vi.fn(() => ''),
  },
}));

import { ipcMain } from 'electron';
import { registerCommitModeHandlers } from '../commitMode';
import { projectDetectionService } from '../../services/projectDetection';
import { commitManager } from '../../services/commitManager';
import type { DatabaseService } from '../../database/database';

type Handler = (...args: unknown[]) => unknown;

function getHandler(channel: string): Handler {
  const calls = (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
    [string, Handler]
  >;
  const entry = calls.find(([c]) => c === channel);
  if (!entry) throw new Error(`No handler registered for channel: ${channel}`);
  return entry[1];
}

function makeDb() {
  return {
    updateSession: vi.fn(),
    getSession: vi.fn(() => undefined),
    updateProject: vi.fn(),
    getProject: vi.fn(),
  };
}

beforeEach(() => {
  (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe('commit-mode:update-session-settings', () => {
  it('persists the mode column plus the settings serialized to JSON unchanged', async () => {
    const db = makeDb();
    registerCommitModeHandlers(db as unknown as DatabaseService);

    const settings: CommitModeSettings = {
      mode: 'structured',
      structuredPromptTemplate: 'Commit with {{scope}}',
      checkpointPrefix: 'wip: ',
      allowClaudeTools: true,
    };

    await getHandler('commit-mode:update-session-settings')({}, 'sess-1', settings);

    expect(db.updateSession).toHaveBeenCalledTimes(1);
    const [sessionId, patch] = db.updateSession.mock.calls[0] as [
      string,
      { commit_mode: string; commit_mode_settings: string },
    ];
    expect(sessionId).toBe('sess-1');
    expect(patch.commit_mode).toBe('structured');
    // Round-trip: the stored JSON string parses back to the EXACT settings object,
    // including the optional allowClaudeTools flag (no field dropped or coerced).
    expect(JSON.parse(patch.commit_mode_settings)).toEqual(settings);
  });

  it('propagates a DB write failure to the caller (does not swallow it)', async () => {
    const db = makeDb();
    db.updateSession.mockImplementation(() => {
      throw new Error('db locked');
    });
    registerCommitModeHandlers(db as unknown as DatabaseService);

    await expect(
      getHandler('commit-mode:update-session-settings')({}, 'sess-1', {
        mode: 'checkpoint',
      } satisfies CommitModeSettings),
    ).rejects.toThrow('db locked');
  });
});

describe('commit-mode:check-checkpoint-warning', () => {
  it('returns the default { shouldWarn: false } when the probe throws (no rethrow)', async () => {
    const db = makeDb();
    vi.mocked(commitManager.shouldWarnAboutCheckpointMode).mockRejectedValueOnce(
      new Error('git failed'),
    );
    registerCommitModeHandlers(db as unknown as DatabaseService);

    const result = await getHandler('commit-mode:check-checkpoint-warning')({}, '/wt/path');
    expect(result).toEqual({ shouldWarn: false });
  });

  it('passes through the probe result when it succeeds', async () => {
    const db = makeDb();
    vi.mocked(commitManager.shouldWarnAboutCheckpointMode).mockResolvedValueOnce({
      shouldWarn: true,
      reason: 'uncommitted changes',
    });
    registerCommitModeHandlers(db as unknown as DatabaseService);

    const result = await getHandler('commit-mode:check-checkpoint-warning')({}, '/wt/path');
    expect(result).toEqual({ shouldWarn: true, reason: 'uncommitted changes' });
  });
});

describe('commit-mode:get-project-characteristics', () => {
  it('returns the detector characteristics verbatim on success', async () => {
    const db = makeDb();
    const characteristics: ProjectCharacteristics = {
      hasHusky: true,
      hasChangeset: false,
      hasConventionalCommits: true,
      suggestedMode: 'structured',
    };
    vi.mocked(projectDetectionService.detectProjectCharacteristics).mockResolvedValueOnce(
      characteristics,
    );
    registerCommitModeHandlers(db as unknown as DatabaseService);

    const result = await getHandler('commit-mode:get-project-characteristics')({}, '/proj');
    expect(result).toBe(characteristics);
  });

  it('rejects (current behavior) when the detector throws — does NOT return a default', async () => {
    // The batch spec described this as "returns usable default (no throw)", but
    // the handler RETHROWS. Pinning the actual behavior: the caller sees a
    // rejection, so any future silent-default change trips this test.
    const db = makeDb();
    vi.mocked(projectDetectionService.detectProjectCharacteristics).mockRejectedValueOnce(
      new Error('fs denied'),
    );
    registerCommitModeHandlers(db as unknown as DatabaseService);

    await expect(
      getHandler('commit-mode:get-project-characteristics')({}, '/proj'),
    ).rejects.toThrow('fs denied');
  });
});
