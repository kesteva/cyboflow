/**
 * Inbound agent text is untrusted: nothing under components/agentsEnv may render it through a markdown or
 * HTML path. This pins the source, so a future "nicer rendering" change fails here first.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const FORBIDDEN = /dangerouslySetInnerHTML|MarkdownPreview|MarkdownRenderer|react-markdown|UnifiedChatView|ChatTranscript/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('untrusted rendering', () => {
  const root = path.resolve(__dirname, '..');
  const files = walk(root);

  it('scans the component files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [path.relative(root, f), f] as const))('%s uses no markdown or HTML renderer', (_name, file) => {
    const src = fs.readFileSync(file, 'utf8');
    expect(src).not.toMatch(FORBIDDEN);
  });

  it('the guard actually matches the forbidden names', () => {
    expect(FORBIDDEN.test('<div dangerouslySetInnerHTML={{ __html: x }} />')).toBe(true);
    expect(FORBIDDEN.test("import ReactMarkdown from 'react-markdown'")).toBe(true);
  });
});
