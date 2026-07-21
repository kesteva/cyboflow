/**
 * Integration tests for the S0.4 global-agent filesystem tools
 * (mcp-fs-read / -list / -grep) on McpQueryHandler.
 *
 * Enforcement is entirely server-side, so these drive the handler directly
 * against a real tmpdir fixture: a "project" directory registered via a
 * `projects` row in the fixture DB (the always-included root), plus a SECOND
 * tmpdir OUTSIDE that scope reachable only through an in-scope symlink (the
 * classic escape). They assert the canonical-prefix + realpath scope guard, the
 * secret deny-list (while list still surfaces the names), binary refusal, the
 * read/grep/list caps, symlink-skipping + skip-dir pruning in grep, invalid
 * regex, and the config-extra root widening the allowed set.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpQueryHandler, type McpQueryResponse } from '../mcpQueryHandler';
import type * as net from 'net';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSocketDouble(): { socket: net.Socket; writes: string[] } {
  const writes: string[] = [];
  const socket = {
    write: (chunk: string | Buffer) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
  } as unknown as net.Socket;
  return { socket, writes };
}

function parseLastWrite(writes: string[]): McpQueryResponse {
  return JSON.parse(writes[writes.length - 1]) as McpQueryResponse;
}

const AGENT_RUN_ID = 'agent:thread-fs-test';

// ---------------------------------------------------------------------------
// Fixture
//   <projectDir>/                       (registered project root)
//     hello.txt                         normal file
//     src/index.ts                      normal file in a subdir
//     .env                              secret (deny content, show name)
//     id_rsa                            secret (deny content, show name)
//     node_modules/x.js                 skip-dir content
//     big.txt                           > 256KB (read truncation)
//     lines.txt                         multi-line (offset/limit paging)
//     escape                -> outsideDir/secret.txt   (symlink escaping scope)
//     binfile.bin                       NUL byte in the head (binary)
//   <outsideDir>/secret.txt             OUTSIDE every root
//   <extraDir>/note.md                  an out-of-scope folder granted via config dep
// ---------------------------------------------------------------------------

let tmpRoot: string;
let projectDir: string;
let outsideDir: string;
let extraDir: string;
let dbPath: string;
let rawDb: Database.Database;
let handler: McpQueryHandler;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cyboflow-fs-'));
  projectDir = join(tmpRoot, 'project');
  outsideDir = join(tmpRoot, 'outside');
  extraDir = join(tmpRoot, 'extra');
  mkdirSync(projectDir);
  mkdirSync(outsideDir);
  mkdirSync(extraDir);
  mkdirSync(join(projectDir, 'src'));
  mkdirSync(join(projectDir, 'node_modules'));

  writeFileSync(join(projectDir, 'hello.txt'), 'hello world\nsecond line\n');
  writeFileSync(join(projectDir, 'src', 'index.ts'), 'export const NEEDLE = 42;\n');
  writeFileSync(join(projectDir, '.env'), 'SECRET_TOKEN=shhh\n');
  writeFileSync(join(projectDir, 'id_rsa'), '-----BEGIN PRIVATE KEY-----\n');
  writeFileSync(join(projectDir, 'node_modules', 'x.js'), 'const NEEDLE = "in node_modules";\n');
  writeFileSync(join(projectDir, 'big.txt'), 'x'.repeat(300_000));
  writeFileSync(
    join(projectDir, 'lines.txt'),
    Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n') + '\n',
  );
  writeFileSync(join(projectDir, 'binfile.bin'), Buffer.from([0x61, 0x62, 0x00, 0x63]));
  writeFileSync(join(outsideDir, 'secret.txt'), 'NEEDLE outside scope\n');
  writeFileSync(join(extraDir, 'note.md'), 'NEEDLE in the extra folder\n');
  symlinkSync(join(outsideDir, 'secret.txt'), join(projectDir, 'escape'));

  dbPath = join(tmpRoot, 'test.db');
  rawDb = new Database(dbPath);
  rawDb.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, path TEXT)');
  rawDb.prepare('INSERT INTO projects (name, path) VALUES (?, ?)').run('proj', projectDir);
  handler = new McpQueryHandler(dbAdapter(rawDb));
});

afterEach(() => {
  rawDb.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scope guard
// ---------------------------------------------------------------------------

describe('mcp-fs — scope guard', () => {
  it('rejects a run-scoped (non agent:) runId for all three tools', async () => {
    for (const msg of [
      { type: 'mcp-fs-read' as const, requestId: 'r', runId: 'not-agent', path: join(projectDir, 'hello.txt') },
      { type: 'mcp-fs-list' as const, requestId: 'r', runId: 'not-agent', path: projectDir },
      { type: 'mcp-fs-grep' as const, requestId: 'r', runId: 'not-agent', pattern: 'x', path: projectDir },
    ]) {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(msg, socket);
      const resp = parseLastWrite(writes);
      expect(resp.ok).toBe(false);
      expect(resp.error).toBe('not_a_global_agent_run');
    }
  });

  it('an out-of-scope path returns scope_denied naming the allowed roots', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-read', requestId: 'r', runId: AGENT_RUN_ID, path: join(outsideDir, 'secret.txt') },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/^scope_denied/);
    // Roots are named (realpath'd) so the model can self-correct.
    expect(resp.error).toContain(realpathSync(projectDir));
  });

  it('a symlink escaping scope is caught by the realpath check (scope_denied)', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-read', requestId: 'r', runId: AGENT_RUN_ID, path: join(projectDir, 'escape') },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/^scope_denied/);
  });

  it('a nonexistent path returns not_found', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-read', requestId: 'r', runId: AGENT_RUN_ID, path: join(projectDir, 'does-not-exist.txt') },
      socket,
    );
    expect(parseLastWrite(writes).error).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// fs_read
// ---------------------------------------------------------------------------

describe('mcp-fs-read', () => {
  it('reads an in-scope file', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-read', requestId: 'r', runId: AGENT_RUN_ID, path: join(projectDir, 'hello.txt') },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    const data = resp.data as { content: string; truncated: boolean; totalBytes: number };
    expect(data.content).toBe('hello world\nsecond line\n');
    expect(data.truncated).toBe(false);
    expect(data.totalBytes).toBe(24);
  });

  it('refuses a .env with denied_secret_pattern', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-read', requestId: 'r', runId: AGENT_RUN_ID, path: join(projectDir, '.env') },
      socket,
    );
    expect(parseLastWrite(writes).error).toBe('denied_secret_pattern');
  });

  it('refuses an id_rsa with denied_secret_pattern', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-read', requestId: 'r', runId: AGENT_RUN_ID, path: join(projectDir, 'id_rsa') },
      socket,
    );
    expect(parseLastWrite(writes).error).toBe('denied_secret_pattern');
  });

  it('refuses a binary file with binary_file', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-read', requestId: 'r', runId: AGENT_RUN_ID, path: join(projectDir, 'binfile.bin') },
      socket,
    );
    expect(parseLastWrite(writes).error).toBe('binary_file');
  });

  it('truncates a file larger than the byte cap and reports totalBytes', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-read', requestId: 'r', runId: AGENT_RUN_ID, path: join(projectDir, 'big.txt') },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    const data = resp.data as { content: string; truncated: boolean; totalBytes: number };
    expect(data.truncated).toBe(true);
    expect(data.totalBytes).toBe(300_000);
    expect(data.content.length).toBe(256_000);
  });

  it('offset_line + limit_lines page a window of a multi-line file', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-read', requestId: 'r', runId: AGENT_RUN_ID, path: join(projectDir, 'lines.txt'), offsetLine: 3, limitLines: 2 },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    const data = resp.data as { content: string; truncated: boolean };
    expect(data.content).toBe('line-3\nline-4');
    expect(data.truncated).toBe(true); // more lines exist beyond the window
  });

  it('rejects reading a directory with is_a_directory', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-read', requestId: 'r', runId: AGENT_RUN_ID, path: projectDir },
      socket,
    );
    expect(parseLastWrite(writes).error).toBe('is_a_directory');
  });
});

// ---------------------------------------------------------------------------
// fs_list
// ---------------------------------------------------------------------------

describe('mcp-fs-list', () => {
  it('lists entries INCLUDING secret names (metadata only, content still unreachable)', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-list', requestId: 'r', runId: AGENT_RUN_ID, path: projectDir },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    const data = resp.data as { entries: Array<{ name: string; type: string; size: number }>; truncated: boolean };
    const byName = new Map(data.entries.map((e) => [e.name, e]));
    expect(byName.has('.env')).toBe(true);
    expect(byName.has('id_rsa')).toBe(true);
    expect(byName.get('src')!.type).toBe('dir');
    expect(byName.get('hello.txt')!.type).toBe('file');
    expect(byName.get('escape')!.type).toBe('symlink');
    expect(data.truncated).toBe(false);
  });

  it('rejects listing a file with not_a_directory', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-list', requestId: 'r', runId: AGENT_RUN_ID, path: join(projectDir, 'hello.txt') },
      socket,
    );
    expect(parseLastWrite(writes).error).toBe('not_a_directory');
  });
});

// ---------------------------------------------------------------------------
// fs_grep
// ---------------------------------------------------------------------------

describe('mcp-fs-grep', () => {
  it('finds a match in an in-scope file and skips node_modules/.git', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-grep', requestId: 'r', runId: AGENT_RUN_ID, pattern: 'NEEDLE', path: projectDir },
      socket,
    );
    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    const data = resp.data as { matches: Array<{ file: string; line: number; text: string }>; filesScanned: number };
    const files = data.matches.map((m) => m.file);
    expect(files.some((f) => f.endsWith('src/index.ts'))).toBe(true);
    // node_modules is a skip-dir — its NEEDLE never surfaces.
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    // The escaping symlink is never followed, so the outside NEEDLE never appears.
    expect(files.some((f) => f.includes('secret.txt'))).toBe(false);
  });

  it('is case-insensitive by default and case-sensitive on request', async () => {
    const insensitive = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-grep', requestId: 'r', runId: AGENT_RUN_ID, pattern: 'needle', path: join(projectDir, 'src') },
      insensitive.socket,
    );
    expect((parseLastWrite(insensitive.writes).data as { matches: unknown[] }).matches.length).toBe(1);

    const sensitive = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-grep', requestId: 'r', runId: AGENT_RUN_ID, pattern: 'needle', path: join(projectDir, 'src'), caseSensitive: true },
      sensitive.socket,
    );
    expect((parseLastWrite(sensitive.writes).data as { matches: unknown[] }).matches.length).toBe(0);
  });

  it('a glob filters by basename', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-grep', requestId: 'r', runId: AGENT_RUN_ID, pattern: 'NEEDLE', path: projectDir, glob: '*.ts' },
      socket,
    );
    const data = parseLastWrite(writes).data as { matches: Array<{ file: string }> };
    expect(data.matches.length).toBe(1);
    expect(data.matches[0].file.endsWith('index.ts')).toBe(true);
  });

  it('an invalid regex returns invalid_regex', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-grep', requestId: 'r', runId: AGENT_RUN_ID, pattern: '(unclosed', path: projectDir },
      socket,
    );
    expect(parseLastWrite(writes).error).toBe('invalid_regex');
  });

  it('grepping a secret file directly is denied', async () => {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-grep', requestId: 'r', runId: AGENT_RUN_ID, pattern: 'SECRET', path: join(projectDir, '.env') },
      socket,
    );
    expect(parseLastWrite(writes).error).toBe('denied_secret_pattern');
  });

  it('caps matches at max_results and sets truncated', async () => {
    // A file with many matching lines.
    writeFileSync(join(projectDir, 'many.txt'), Array.from({ length: 50 }, () => 'MATCH').join('\n') + '\n');
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-grep', requestId: 'r', runId: AGENT_RUN_ID, pattern: 'MATCH', path: join(projectDir, 'many.txt'), maxResults: 10 },
      socket,
    );
    const data = parseLastWrite(writes).data as { matches: unknown[]; truncated: boolean };
    expect(data.matches.length).toBe(10);
    expect(data.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config-extra root
// ---------------------------------------------------------------------------

describe('mcp-fs — config-extra root widens the allowed set', () => {
  it('a folder granted via getAssistantFolderAccess becomes readable', async () => {
    const extraHandler = new McpQueryHandler(dbAdapter(rawDb), undefined, {
      getAssistantFolderAccess: () => [extraDir],
    });

    // Without the dep the extra folder is out of scope.
    const denied = makeSocketDouble();
    await handler.handleMessage(
      { type: 'mcp-fs-read', requestId: 'r', runId: AGENT_RUN_ID, path: join(extraDir, 'note.md') },
      denied.socket,
    );
    expect(parseLastWrite(denied.writes).error).toMatch(/^scope_denied/);

    // With the dep it is readable.
    const allowed = makeSocketDouble();
    await extraHandler.handleMessage(
      { type: 'mcp-fs-read', requestId: 'r', runId: AGENT_RUN_ID, path: join(extraDir, 'note.md') },
      allowed.socket,
    );
    const resp = parseLastWrite(allowed.writes);
    expect(resp.ok).toBe(true);
    expect((resp.data as { content: string }).content).toContain('extra folder');
  });
});
