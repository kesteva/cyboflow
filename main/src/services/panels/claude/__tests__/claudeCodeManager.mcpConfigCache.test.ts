/**
 * F14 — two-tier cache of the parsed MCP config sources.
 *
 * `.mcp.json` + `~/.claude.json` are consulted on EVERY turn
 * (getBaseProjectMcpServers → composeMcpServers → buildSdkOptions) and can be
 * large. Tier 1: a statSync fast-path (mtimeMs+size+ino) skips both the read and
 * the parse while the file is untouched. Tier 2: when metadata changed, the raw
 * text is re-read and the PARSED value is reused only on a byte-exact raw match —
 * a SAME-LENGTH edit still re-parses. The cached parse is deep-frozen and each
 * read structuredClones a fresh map, so the composition step (which deletes
 * disabled servers + injects the cyboflow entry) can never leak a mutation back
 * into the cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { ClaudeCodeManager } from '../claudeCodeManager';
import type { SessionManager } from '../../../sessionManager';

vi.mock('../../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));
// fs properties are non-configurable, so spyOn(fs, …) fails; mock the module with
// vi.fn wrappers whose behavior each test sets via mockImplementation.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
    statSync: vi.fn(actual.statSync),
  };
});

const PROJECT_PATH = '/proj';
const MCP_JSON_PATH = path.join(PROJECT_PATH, '.mcp.json');

/** Exposes the private getBaseProjectMcpServers for direct cache assertions. */
class TestableClaudeCodeManager extends ClaudeCodeManager {
  publicGetBaseProjectMcpServers(sessionId: string): { mcpServers: Record<string, unknown> } {
    return (
      this as unknown as {
        getBaseProjectMcpServers(id: string): { mcpServers: Record<string, unknown> };
      }
    ).getBaseProjectMcpServers(sessionId);
  }
}

function makeManager(db: Database.Database): TestableClaudeCodeManager {
  const sessionManager = {
    getDbSession: vi.fn(() => ({ id: 's1', project_id: 1 })),
    getProjectById: vi.fn(() => ({ path: PROJECT_PATH })),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
  return new TestableClaudeCodeManager(sessionManager, undefined, undefined, db);
}

describe('ClaudeCodeManager — F14 MCP config parse cache', () => {
  let db: Database.Database;
  let mgr: TestableClaudeCodeManager;
  // Only .mcp.json exists; ~/.claude.json is absent so the test isolates one file.
  let mcpRaw: string;
  // Mirrors a real editor write: tests that change mcpRaw bump this too. size
  // intentionally tracks mcpRaw.length so a same-length edit exercises the
  // mtime component of the fast-path key, not the size component.
  let mcpMtimeMs: number;

  /** Simulate an on-disk write of new content (content change ⇒ mtime bump). */
  function writeMcpJson(raw: string): void {
    mcpRaw = raw;
    mcpMtimeMs += 1000;
  }

  beforeEach(() => {
    db = createTestDb();
    ApprovalRouter.initialize(dbAdapter(db));
    mgr = makeManager(db);
    mcpRaw = JSON.stringify({ mcpServers: { alpha: { command: 'a' }, beta: { command: 'b' } } });
    mcpMtimeMs = 1_000_000;

    // Only .mcp.json exists; ~/.claude.json is absent so the test isolates one file.
    vi.mocked(fs.existsSync).mockImplementation((p) => p === MCP_JSON_PATH);
    vi.mocked(fs.statSync).mockImplementation(((p: fs.PathLike) => {
      if (p === MCP_JSON_PATH) {
        return { mtimeMs: mcpMtimeMs, size: mcpRaw.length, ino: 42 } as fs.Stats;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }) as typeof fs.statSync);
    vi.mocked(fs.readFileSync).mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (p === MCP_JSON_PATH) return mcpRaw;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }) as typeof fs.readFileSync);
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  /** How many times JSON.parse ran against a given raw string. */
  function parseCountFor(spy: { mock: { calls: readonly unknown[][] } }, raw: string): number {
    return spy.mock.calls.filter((c) => c[0] === raw).length;
  }

  it('unchanged file metadata skips the read AND the parse (stat fast-path)', () => {
    const parseSpy = vi.spyOn(JSON, 'parse');

    const first = mgr.publicGetBaseProjectMcpServers('s1');
    const readsAfterFirst = vi.mocked(fs.readFileSync).mock.calls.length;
    const second = mgr.publicGetBaseProjectMcpServers('s1');

    expect(first.mcpServers).toHaveProperty('alpha');
    expect(second.mcpServers).toEqual(first.mcpServers);
    // Cache hit on the 2nd turn: no additional read, no additional parse.
    expect(vi.mocked(fs.readFileSync).mock.calls.length).toBe(readsAfterFirst);
    expect(parseCountFor(parseSpy, mcpRaw)).toBe(1);
  });

  it('touch-only rewrite (metadata changed, bytes identical) re-reads but reuses the parse', () => {
    const parseSpy = vi.spyOn(JSON, 'parse');

    mgr.publicGetBaseProjectMcpServers('s1'); // parse #1 of the original
    mcpMtimeMs += 1000; // e.g. `touch .mcp.json` — same bytes, new mtime

    const after = mgr.publicGetBaseProjectMcpServers('s1');
    expect(after.mcpServers).toHaveProperty('alpha');
    // Byte-exact fallback: read happened again, but the parse was reused.
    expect(parseCountFor(parseSpy, mcpRaw)).toBe(1);
  });

  it('re-parses when the content changes even at the SAME byte length', () => {
    const parseSpy = vi.spyOn(JSON, 'parse');

    mgr.publicGetBaseProjectMcpServers('s1'); // parse #1 of the original

    // A same-length edit (swap command 'a' → 'z') must NOT be served from cache.
    const changed = mcpRaw.replace('"command":"a"', '"command":"z"');
    expect(changed.length).toBe(mcpRaw.length);
    expect(changed).not.toBe(mcpRaw);
    writeMcpJson(changed);

    const after = mgr.publicGetBaseProjectMcpServers('s1');
    expect((after.mcpServers.alpha as { command: string }).command).toBe('z');
    expect(parseCountFor(parseSpy, changed)).toBe(1); // re-parsed the new content
  });

  it('never leaks a composition-style mutation back into the cache across turns', () => {
    // Turn 1: mutate the returned map exactly as composeMcpServers would (delete a
    // disabled server, inject a cyboflow entry, and even mutate a server value).
    const first = mgr.publicGetBaseProjectMcpServers('s1');
    delete first.mcpServers.beta;
    first.mcpServers.cyboflow = { command: 'node' };
    (first.mcpServers.alpha as { command: string }).command = 'MUTATED';

    // Turn 2 (same raw content, cache hit): a pristine, fully-decoupled map.
    const second = mgr.publicGetBaseProjectMcpServers('s1');
    expect(second.mcpServers).toEqual({ alpha: { command: 'a' }, beta: { command: 'b' } });
    expect(second.mcpServers).not.toHaveProperty('cyboflow');
    // Fresh object identity — structuredClone, not a shared reference to the cache.
    expect(second.mcpServers.alpha).not.toBe(first.mcpServers.alpha);
    // And the returned values are mutable (not the frozen cache).
    expect(Object.isFrozen(second.mcpServers.alpha)).toBe(false);
  });
});
