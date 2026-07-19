/**
 * Integration tests for TranscriptTailSource.
 *
 * Hermetic: `projectsRoot` points at an `os.tmpdir()` temp dir (never touches the
 * real `~/.claude`). Fixture lines mirror the canonical Probe-E inventory recorded
 * in docs/probes/IDEA-013-probe-findings.md (session `efde13c6`, 2026-06-01):
 * noise types, panel-critical assistant/user lines, STRING-content user lines, and
 * stop_hook_summary / turn_duration turn-end markers.
 *
 * Covers: discovery of a new *.jsonl basename as the session UUID; discovery
 * timeout -> reject + loud logger; incremental tail with a split line + a
 * malformed line; onTurnEnd firing; truncation/re-append (inode/offset re-sync);
 * stop() exits the loop; and the collision fallback (binds the cwd-matching file).
 *
 * F15 (async tick I/O, main/src/.../transcriptTailSource.ts): the tail tick's
 * stat/open/read/close moved off the main thread onto `fs/promises`. Additional
 * coverage below: ticks never overlap (a slow tick suppresses the next 50ms
 * tick rather than racing it); stop() mid-read never lets a dispatch land after
 * teardown; and a second append landing while a tick is already mid-read is
 * picked up cleanly on the NEXT tick (no loss, no duplication).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TranscriptTailSource } from '../transcriptTailSource';
import { encodeCwd } from '../encodeCwd';

/**
 * F15: a controllable gate on `fs/promises`' `open()`, used by 'stop-during-read'
 * and 'append-during-read' below to land stop()/a second append EXACTLY inside a
 * tick's async I/O window (between stat() and the read) without depending on real
 * disk timing. `fs/promises`' exports are non-configurable (`vi.spyOn` throws
 * "Cannot redefine property"), so gating goes through `vi.mock` instead — its
 * factory is hoisted above imports, so the shared state must come from
 * `vi.hoisted` to be visible both there and in the tests that arm it. Every other
 * test passes through untouched (`armed` defaults false).
 */
const openGate = vi.hoisted(() => ({
  armed: false,
  reached: false,
  release: undefined as (() => void) | undefined,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (openGate.armed && !openGate.reached) {
        openGate.reached = true;
        await new Promise<void>((resolve) => {
          openGate.release = resolve;
        });
      }
      return actual.open(...args);
    },
  };
});

function makeSpyLogger() {
  return { warn: vi.fn(), error: vi.fn(), verbose: vi.fn() };
}

const WORKTREE = '/private/tmp/idea013-probe-worktree';

// Real-shaped fixture lines (Probe-E inventory).
function assistantTextLine(text: string, cwd = WORKTREE): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
    cwd,
    sessionId: 'efde13c6',
    uuid: 'ae153392',
  });
}

function fileHistorySnapshotLine(): string {
  // Real first physical line — carries NO top-level cwd.
  return JSON.stringify({
    type: 'file-history-snapshot',
    messageId: '01bc38e2',
    snapshot: { trackedFileBackups: {} },
    isSnapshotUpdate: false,
  });
}

function stopHookSummaryLine(cwd = WORKTREE): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount: 2,
    cwd,
    sessionId: 'efde13c6',
  });
}

let tmpRoot: string;
let keyDir: string;
const sources: TranscriptTailSource[] = [];

function trackedSource(opts: ConstructorParameters<typeof TranscriptTailSource>[0]): TranscriptTailSource {
  const s = new TranscriptTailSource(opts);
  sources.push(s);
  return s;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-transcript-'));
  keyDir = path.join(tmpRoot, encodeCwd(WORKTREE));
  fs.mkdirSync(keyDir, { recursive: true });
  openGate.armed = false;
  openGate.reached = false;
  openGate.release = undefined;
});

afterEach(() => {
  for (const s of sources) s.stop();
  sources.length = 0;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('TranscriptTailSource', () => {
  it('discovers a newly-written *.jsonl basename as the session UUID', async () => {
    // One pre-existing file in the snapshot so discovery must pick the NEW one.
    fs.writeFileSync(path.join(keyDir, 'preexisting-0000.jsonl'), '');

    const logger = makeSpyLogger();
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start(() => undefined);

    const newUuid = 'efde13c6-ea3e-4e43-86bb-f082bb8a66f7';
    fs.writeFileSync(path.join(keyDir, `${newUuid}.jsonl`), assistantTextLine('hi') + '\n');

    await src.waitForFirstLine(1500);
    expect(src.getSessionUuid()).toBe(newUuid);
  });

  it('soft timeout: rejects firstLine with a loud diagnostic but does NOT give up (warn, not error)', async () => {
    const logger = makeSpyLogger();
    const onGiveUp = vi.fn();
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 80,
      // Long extended window so the soft timeout does NOT roll into a give-up here.
      lateDiscoveryWindowMs: 5000,
      logger,
      onGiveUp,
    });

    await src.start(() => undefined);

    await expect(src.waitForFirstLine(80)).rejects.toThrow(/discovery timeout/i);
    // Soft timeout is recoverable: warn locally, NOT error, and NOT a give-up.
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('late recovery: a transcript appearing AFTER the soft timeout still binds + fires onLateBind', async () => {
    const logger = makeSpyLogger();
    const onLateBind = vi.fn();
    const received: unknown[] = [];
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 80,
      lateDiscoveryWindowMs: 5000,
      logger,
      onLateBind,
    });

    await src.start((obj) => received.push(obj));

    // The soft timeout fires first (no file yet) — the firstLine promise rejects.
    await expect(src.waitForFirstLine(80)).rejects.toThrow(/discovery timeout/i);

    // Now the slow claude launch finally writes its transcript — the background
    // poll must still discover + bind it and attach the structured pipeline.
    const lateUuid = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
    fs.writeFileSync(path.join(keyDir, `${lateUuid}.jsonl`), assistantTextLine('late') + '\n');

    await waitFor(() => received.length >= 1);
    expect(src.getSessionUuid()).toBe(lateUuid);
    expect(onLateBind).toHaveBeenCalledWith(lateUuid);
    const e0 = received[0] as { message: { content: Array<{ text: string }> } };
    expect(e0.message.content[0].text).toBe('late');
  });

  it('true give-up: the extended window elapsing with no transcript fires onGiveUp (error)', async () => {
    const logger = makeSpyLogger();
    const onGiveUp = vi.fn();
    const onLateBind = vi.fn();
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 40,
      lateDiscoveryWindowMs: 60,
      logger,
      onGiveUp,
      onLateBind,
    });

    await src.start(() => undefined);
    await expect(src.waitForFirstLine(40)).rejects.toThrow(/discovery timeout/i);

    // After the soft timeout (40ms) + extended window (60ms), give up for real.
    await waitFor(() => onGiveUp.mock.calls.length >= 1);
    expect(logger.error).toHaveBeenCalled();
    expect(onLateBind).not.toHaveBeenCalled();
  });

  it('tails incrementally: split line reassembled, malformed line skipped, in order', async () => {
    const logger = makeSpyLogger();
    const received: unknown[] = [];
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start((obj) => received.push(obj));

    const file = path.join(keyDir, 'session-aaaa.jsonl');
    fs.writeFileSync(file, '');
    await src.waitForFirstLine(1500);

    // Write line 1 split across two appends, then a malformed line, then line 2.
    const l1 = assistantTextLine('first');
    fs.appendFileSync(file, l1.slice(0, 20));
    await new Promise((r) => setTimeout(r, 80));
    fs.appendFileSync(file, l1.slice(20) + '\n');
    fs.appendFileSync(file, '{ this is not json }\n');
    fs.appendFileSync(file, assistantTextLine('second') + '\n');

    await waitFor(() => received.length >= 2);

    expect(received).toHaveLength(2);
    const e0 = received[0] as { type: string; message: { content: Array<{ text: string }> } };
    const e1 = received[1] as { type: string; message: { content: Array<{ text: string }> } };
    expect(e0.type).toBe('assistant');
    expect(e0.message.content[0].text).toBe('first');
    expect(e1.message.content[0].text).toBe('second');
    expect(logger.warn).toHaveBeenCalled(); // malformed line skipped (logged)
  });

  it('fires onTurnEnd on a stop_hook_summary line (not via onLine)', async () => {
    const logger = makeSpyLogger();
    const lines: unknown[] = [];
    const turnEnds: string[] = [];
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start(
      (obj) => lines.push(obj),
      (marker) => turnEnds.push(marker),
    );

    const file = path.join(keyDir, 'session-bbbb.jsonl');
    fs.writeFileSync(file, '');
    await src.waitForFirstLine(1500);

    fs.appendFileSync(file, assistantTextLine('working') + '\n');
    fs.appendFileSync(file, stopHookSummaryLine() + '\n');

    await waitFor(() => turnEnds.length >= 1);
    expect(turnEnds).toContain('stop_hook_summary');
    // The turn-end marker was NOT forwarded as a panel line.
    expect(lines).toHaveLength(1);
  });

  it('survives truncation + re-append (inode/offset re-sync)', async () => {
    const logger = makeSpyLogger();
    const received: unknown[] = [];
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start((obj) => received.push(obj));

    const file = path.join(keyDir, 'session-cccc.jsonl');
    fs.writeFileSync(file, assistantTextLine('before') + '\n');
    await src.waitForFirstLine(1500);
    await waitFor(() => received.length >= 1);

    // Truncate + rewrite the file (size shrinks below offset -> re-sync to 0).
    fs.rmSync(file);
    fs.writeFileSync(file, assistantTextLine('after') + '\n');

    await waitFor(() => received.length >= 2);
    const last = received[received.length - 1] as { message: { content: Array<{ text: string }> } };
    expect(last.message.content[0].text).toBe('after');
  });

  it('stops the tail loop and forwards nothing after stop()', async () => {
    const logger = makeSpyLogger();
    const received: unknown[] = [];
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start((obj) => received.push(obj));
    const file = path.join(keyDir, 'session-dddd.jsonl');
    fs.writeFileSync(file, assistantTextLine('one') + '\n');
    await src.waitForFirstLine(1500);
    await waitFor(() => received.length >= 1);

    src.stop();
    const countAtStop = received.length;

    fs.appendFileSync(file, assistantTextLine('two') + '\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(countAtStop); // nothing more forwarded
  });

  it('ticks never overlap: a slow tick suppresses the next 50ms tick rather than racing it', async () => {
    const logger = makeSpyLogger();
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start(() => undefined);
    const file = path.join(keyDir, 'session-overlap.jsonl');
    fs.writeFileSync(file, '');
    await src.waitForFirstLine(1500);

    // Stub the tick body itself so concurrency is asserted directly, independent
    // of real disk-I/O timing (which is far faster than the 50ms cadence locally
    // and would never naturally overlap).
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = async (): Promise<void> => {
      calls++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate;
      concurrent--;
    };
    (src as unknown as { readAppended: () => Promise<void> }).readAppended = stub;

    // Let several 50ms ticks elapse while the first stubbed call is stuck on the gate.
    await new Promise((r) => setTimeout(r, 220));
    expect(calls).toBe(1); // every later interval firing was skipped, not queued
    expect(maxConcurrent).toBe(1);

    release?.();
    await waitFor(() => calls >= 2); // once released, ticking resumes normally
  });

  it('stop-during-read: no dispatch lands after teardown even if the in-flight read finishes later', async () => {
    const logger = makeSpyLogger();
    const received: unknown[] = [];
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start((obj) => received.push(obj));
    const file = path.join(keyDir, 'session-stopread.jsonl');
    fs.writeFileSync(file, '');
    await src.waitForFirstLine(1500);

    fs.appendFileSync(file, assistantTextLine('pending') + '\n');

    // Gate the tick's open() so it is caught between stat() (already resolved)
    // and the actual read — the window where stop() must still prevent dispatch.
    openGate.armed = true;
    await waitFor(() => openGate.reached);
    src.stop();
    openGate.release?.();

    // Let the gated read actually finish in the background before asserting.
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(0); // stop() landed before the read completed
  });

  it('append-during-read: a second append mid-tick is picked up cleanly next tick (no loss, no duplication)', async () => {
    const logger = makeSpyLogger();
    const received: unknown[] = [];
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 1500,
      logger,
    });

    await src.start((obj) => received.push(obj));
    const file = path.join(keyDir, 'session-appendread.jsonl');
    fs.writeFileSync(file, '');
    await src.waitForFirstLine(1500);

    fs.appendFileSync(file, assistantTextLine('first') + '\n');

    // Gate open() so a SECOND append lands AFTER this tick's stat() already
    // captured the smaller (first-line-only) size — it must not be swept into
    // this tick's read.
    openGate.armed = true;
    await waitFor(() => openGate.reached);
    fs.appendFileSync(file, assistantTextLine('second') + '\n');
    openGate.release?.();

    await waitFor(() => received.length >= 2);

    expect(received).toHaveLength(2);
    const r0 = received[0] as { message: { content: Array<{ text: string }> } };
    const r1 = received[1] as { message: { content: Array<{ text: string }> } };
    expect(r0.message.content[0].text).toBe('first');
    expect(r1.message.content[0].text).toBe('second');
  });

  it('collision fallback: binds the file whose top-level cwd matches the worktree', async () => {
    const logger = makeSpyLogger();
    const src = trackedSource({
      worktreePath: WORKTREE,
      projectsRoot: tmpRoot,
      discoveryTimeoutMs: 2000,
      logger,
    });

    await src.start(() => undefined);

    // Two NEW files in the same encodeCwd key dir. First physical line is a
    // file-history-snapshot (no cwd); the first cwd-bearing line differs.
    const matchUuid = 'match-1111-2222-3333-444444444444';
    const otherUuid = 'other-aaaa-bbbb-cccc-dddddddddddd';

    const otherFile = path.join(keyDir, `${otherUuid}.jsonl`);
    const matchFile = path.join(keyDir, `${matchUuid}.jsonl`);

    fs.writeFileSync(
      otherFile,
      fileHistorySnapshotLine() + '\n' + assistantTextLine('other', '/some/other/worktree') + '\n',
    );
    fs.writeFileSync(
      matchFile,
      fileHistorySnapshotLine() + '\n' + assistantTextLine('mine', WORKTREE) + '\n',
    );

    await src.waitForFirstLine(2000);
    expect(src.getSessionUuid()).toBe(matchUuid);
  });

  // bindKnownFileFromEnd — no-fork resume: bind the pre-existing transcript and
  // tail from EOF so post-resume lines flow WITHOUT re-emitting the prior history.
  describe('bindKnownFileFromEnd (no-fork resume)', () => {
    it('binds a pre-existing file from EOF: prior history is NOT re-emitted, new appends ARE', async () => {
      const logger = makeSpyLogger();
      const received: unknown[] = [];
      const src = trackedSource({
        worktreePath: WORKTREE,
        projectsRoot: tmpRoot,
        discoveryTimeoutMs: 1500,
        logger,
      });

      // Pre-existing transcript with prior history (would be re-emitted if bound
      // from offset 0).
      const uuid = 'resume-1234-5678-9abc-def000000000';
      const file = path.join(keyDir, `${uuid}.jsonl`);
      fs.writeFileSync(
        file,
        assistantTextLine('history one') + '\n' + assistantTextLine('history two') + '\n',
      );

      await src.start((obj) => received.push(obj));
      const bound = src.bindKnownFileFromEnd(uuid);
      expect(bound).toBe(true);
      await src.waitForFirstLine(1500);
      expect(src.getSessionUuid()).toBe(uuid);

      // Nothing dispatched yet — we tailed from EOF, skipping the prior history.
      await new Promise((r) => setTimeout(r, 120));
      expect(received).toHaveLength(0);

      // A new (post-resume) append IS dispatched.
      fs.appendFileSync(file, assistantTextLine('after resume') + '\n');
      await waitFor(() => received.length >= 1);
      const last = received[received.length - 1] as { message: { content: Array<{ text: string }> } };
      expect(last.message.content[0].text).toBe('after resume');
    });

    it('returns false when the known file is absent (leaves discovery running)', async () => {
      const logger = makeSpyLogger();
      const src = trackedSource({
        worktreePath: WORKTREE,
        projectsRoot: tmpRoot,
        discoveryTimeoutMs: 80,
        logger,
      });

      await src.start(() => undefined);
      const bound = src.bindKnownFileFromEnd('does-not-exist-0000-0000-000000000000');
      expect(bound).toBe(false);
      // Discovery still owns settlement → times out loudly (not silently bound).
      await expect(src.waitForFirstLine(80)).rejects.toThrow(/discovery timeout/i);
    });

    it('is a no-op once already bound via discovery', async () => {
      const logger = makeSpyLogger();
      const src = trackedSource({
        worktreePath: WORKTREE,
        projectsRoot: tmpRoot,
        discoveryTimeoutMs: 1500,
        logger,
      });

      await src.start(() => undefined);
      const discovered = 'disc-1111-2222-3333-444444444444';
      fs.writeFileSync(path.join(keyDir, `${discovered}.jsonl`), assistantTextLine('hi') + '\n');
      await src.waitForFirstLine(1500);
      expect(src.getSessionUuid()).toBe(discovered);

      // A pre-existing other file exists, but bind is refused (already bound).
      const other = 'other-9999-8888-7777-666666666666';
      fs.writeFileSync(path.join(keyDir, `${other}.jsonl`), assistantTextLine('x') + '\n');
      expect(src.bindKnownFileFromEnd(other)).toBe(false);
      expect(src.getSessionUuid()).toBe(discovered);
    });
  });
});
