import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RawResponseCompletedNotification, TokenUsageBreakdown } from './protocol';

/**
 * Per-response usage accounting reads `rawResponse/completed`, which the
 * app-server types as INTERNAL-ONLY — exactly the kind of surface a Codex bump
 * can change without notice. This pins its method name, field names and the
 * nullability of `usage` against the bindings the bundled Codex binary itself
 * generates (`codex app-server generate-ts`), so an upgrade that changes them
 * fails CI instead of silently degrading every count to the tokenUsage fallback.
 * The collab fields the descendant registry reads are pinned alongside.
 */

function resolveCodexEntrypoint(): string | null {
  try {
    const require = createRequire(__filename);
    return path.join(path.dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
  } catch {
    return null;
  }
}

/** `{ a: T, b: U | null, }` → { a: 'T', b: 'U | null' }, JSDoc stripped. */
function parseTypeLiteralFields(source: string, typeName: string): Record<string, string> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const match = new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\};`).exec(withoutComments);
  if (!match) throw new Error(`generated bindings no longer declare ${typeName} as a type literal`);
  const fields: Record<string, string> = {};
  for (const part of match[1].split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const colon = trimmed.indexOf(':');
    fields[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
  }
  return fields;
}

const entrypoint = resolveCodexEntrypoint();
let outDir = '';
let codexHome = '';

function generated(relativePath: string): string {
  return readFileSync(path.join(outDir, relativePath), 'utf8');
}

describe.skipIf(entrypoint === null)('rawResponse/completed protocol shape (generated Codex bindings)', () => {
  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), 'codex-protocol-'));
    codexHome = mkdtempSync(path.join(tmpdir(), 'codex-home-'));
    execFileSync(process.execPath, [entrypoint as string, 'app-server', 'generate-ts', '--out', outDir], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: 'pipe',
      timeout: 60_000,
    });
  });

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
    if (codexHome) rmSync(codexHome, { recursive: true, force: true });
  });

  it('keeps the notification method bound to RawResponseCompletedNotification', () => {
    expect(generated('ServerNotification.ts')).toContain(
      '{ "method": "rawResponse/completed", "params": RawResponseCompletedNotification }',
    );
  });

  it('keeps threadId/turnId/responseId and a nullable TokenUsageBreakdown usage', () => {
    const fields = parseTypeLiteralFields(
      generated('v2/RawResponseCompletedNotification.ts'),
      'RawResponseCompletedNotification',
    );
    expect(fields).toEqual({
      threadId: 'string',
      turnId: 'string',
      responseId: 'string',
      usage: 'TokenUsageBreakdown | null',
      usageMetadata: 'ResponseUsageMetadata | null',
    });
    // The reviewed interface names exactly the generated fields.
    const reviewed: Record<keyof RawResponseCompletedNotification, true> = {
      threadId: true,
      turnId: true,
      responseId: true,
      usage: true,
      usageMetadata: true,
    };
    expect(Object.keys(reviewed).sort()).toEqual(Object.keys(fields).sort());
  });

  it('keeps every TokenUsageBreakdown counter a number, as the accumulator reads them', () => {
    const fields = parseTypeLiteralFields(generated('v2/TokenUsageBreakdown.ts'), 'TokenUsageBreakdown');
    const reviewed: Record<keyof TokenUsageBreakdown, true> = {
      totalTokens: true,
      inputTokens: true,
      cachedInputTokens: true,
      cacheWriteInputTokens: true,
      outputTokens: true,
      reasoningOutputTokens: true,
    };
    expect(Object.keys(fields).sort()).toEqual(Object.keys(reviewed).sort());
    expect(new Set(Object.values(fields))).toEqual(new Set(['number']));
  });

  it('keeps the collab fields the descendant registry reads', () => {
    const threadItem = generated('v2/ThreadItem.ts').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(threadItem).toMatch(/"type": "collabAgentToolCall",[\s\S]*?senderThreadId: string,[\s\S]*?receiverThreadIds: Array<string>,[\s\S]*?model: string \| null,/);
    expect(threadItem).toMatch(/"type": "subAgentActivity", id: string, kind: SubAgentActivityKind, agentThreadId: string,/);
    expect(generated('v2/CollabAgentTool.ts')).toContain('"spawnAgent"');
  });
});
