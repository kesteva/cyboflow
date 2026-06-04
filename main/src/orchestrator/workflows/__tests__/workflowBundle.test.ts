/**
 * Unit tests for resolveWorkflowBundle (IDEA-013 rung-(ii)).
 *
 * The bundle is co-located with the prose `.md`: `<dir>/<basename>/commands/*.md`
 * and `<dir>/<basename>/agents/*.md`. Covers:
 *   (a) resolves commands + agents from the sibling bundle dir, name = basename;
 *   (b) returns a deterministic (sorted) order;
 *   (c) ignores non-.md files;
 *   (d) fail-soft empty bundle for: null/empty path, a `.md` with no sibling dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWorkflowBundle } from '../workflowBundle';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-bundle-resolve-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Lay out `<root>/<name>.md` + a sibling `<root>/<name>/{commands,agents}` tree. */
function scaffold(name: string, commands: Record<string, string>, agents: Record<string, string>): string {
  const mdPath = path.join(root, `${name}.md`);
  fs.writeFileSync(mdPath, `# ${name} prose`, 'utf8');
  const commandsDir = path.join(root, name, 'commands');
  const agentsDir = path.join(root, name, 'agents');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const [file, content] of Object.entries(commands)) fs.writeFileSync(path.join(commandsDir, file), content, 'utf8');
  for (const [file, content] of Object.entries(agents)) fs.writeFileSync(path.join(agentsDir, file), content, 'utf8');
  return mdPath;
}

describe('resolveWorkflowBundle', () => {
  it('(a) resolves commands and agents from the sibling bundle dir, name = file basename', () => {
    const mdPath = scaffold(
      'planner',
      { 'context.md': 'CTX', 'tasks.md': 'TASKS' },
      { 'researcher.md': 'R' },
    );

    const bundle = resolveWorkflowBundle(mdPath);

    expect(bundle.commands.map((c) => c.name)).toEqual(['context', 'tasks']);
    expect(bundle.commands.find((c) => c.name === 'context')?.content).toBe('CTX');
    expect(bundle.agents).toEqual([{ name: 'researcher', content: 'R' }]);
  });

  it('(b) returns commands in deterministic sorted order', () => {
    const mdPath = scaffold('sprint', { 'b.md': 'B', 'a.md': 'A', 'c.md': 'C' }, {});
    expect(resolveWorkflowBundle(mdPath).commands.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('(c) ignores non-.md files in the bundle dirs', () => {
    const mdPath = scaffold('planner', { 'context.md': 'CTX', 'README.txt': 'x', '.keep': '' }, {});
    expect(resolveWorkflowBundle(mdPath).commands.map((c) => c.name)).toEqual(['context']);
  });

  it('(d) fail-soft empty bundle for null / empty / no-sibling-dir', () => {
    expect(resolveWorkflowBundle(null)).toEqual({ commands: [], agents: [] });
    expect(resolveWorkflowBundle('')).toEqual({ commands: [], agents: [] });
    expect(resolveWorkflowBundle('   ')).toEqual({ commands: [], agents: [] });

    // A .md that exists but has no sibling bundle dir.
    const lonely = path.join(root, 'custom.md');
    fs.writeFileSync(lonely, '# custom', 'utf8');
    expect(resolveWorkflowBundle(lonely)).toEqual({ commands: [], agents: [] });
  });
});
