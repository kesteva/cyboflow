import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A passthrough renameSync with a test hook: the writer's atomic writes all end
// in a rename, so a hook there observes the disk at the instant a role lands.
const renameHook = vi.hoisted(() => ({ before: null as ((to: string) => void) | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: import('node:fs').PathLike, to: import('node:fs').PathLike): void => {
      renameHook.before?.(String(to));
      actual.renameSync(from, to);
    },
  };
});
import type { EffectiveAgent } from '../../../../orchestrator/agents/effectiveAgents';
import { makeProdLoggerSpy } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';
import type { Logger } from '../../../../utils/logger';
import {
  ompAgentsDirPath,
  renderOmpAgentMarkdown,
  toOmpThinkingLevel,
  writeOmpAgentFiles,
} from '../ompAgentWriter';

function agent(overrides: Partial<EffectiveAgent> = {}): EffectiveAgent {
  return {
    agentKey: 'implement',
    name: 'cyboflow-implement',
    role: 'sprint',
    description: 'Implements one task.',
    systemPrompt: 'You implement one task.\n',
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    model: null,
    enabledMcps: [],
    source: 'builtin',
    ...overrides,
  };
}

/** The frontmatter lines between the two fences, located the way OMP does it. */
function frontmatterLines(markdown: string): string[] {
  expect(markdown.startsWith('---\n')).toBe(true);
  // OMP ends the frontmatter at the FIRST `\n---` after the opening fence.
  const end = markdown.indexOf('\n---', 3);
  return markdown.slice(4, end).split('\n');
}

/** One frontmatter key's value, decoded as the JSON string it is emitted as. */
function scalar(markdown: string, key: string): unknown {
  const line = frontmatterLines(markdown).find((l) => l.startsWith(`${key}: `));
  return line === undefined ? undefined : JSON.parse(line.slice(key.length + 2));
}

describe('renderOmpAgentMarkdown', () => {
  it('emits name, description and tools as JSON scalars, then the prompt verbatim', () => {
    expect(renderOmpAgentMarkdown(agent())).toBe(
      [
        '---',
        'name: "cyboflow-implement"',
        'description: "Implements one task."',
        'tools: ["read", "edit", "write", "bash", "grep", "glob"]',
        '---',
        '',
        'You implement one task.\n',
      ].join('\n'),
    );
  });

  it('keeps a description with quotes, colons and newlines on ONE line that decodes back exactly', () => {
    const description = 'Reviews code: "blocking" issues only.\n---\n# not a heading';
    const markdown = renderOmpAgentMarkdown(agent({ description }));

    // A raw newline + `---` here would have closed the frontmatter early.
    expect(frontmatterLines(markdown)).toHaveLength(3);
    expect(scalar(markdown, 'description')).toBe(description);
  });

  it('falls back to a non-empty description — OMP drops an agent without one', () => {
    const markdown = renderOmpAgentMarkdown(agent({ agentKey: 'code-review', description: '   ' }));
    expect(scalar(markdown, 'description')).toBe('Cyboflow code-review role');
  });

  it('maps CliTools onto OMP names, WebFetch to read, de-duplicated in first-occurrence order', () => {
    const markdown = renderOmpAgentMarkdown(
      agent({ tools: ['Grep', 'WebFetch', 'WebSearch', 'Read', 'Glob'] }),
    );
    expect(scalar(markdown, 'tools')).toEqual(['grep', 'read', 'web_search', 'glob']);
    // The gate's deny-side map sends WebFetch to `fetch`; that name must not leak here.
    expect(markdown).not.toContain('"fetch"');
  });

  it('omits the tools line for an empty tool set rather than writing `tools: []`', () => {
    const markdown = renderOmpAgentMarkdown(agent({ tools: [] }));
    expect(frontmatterLines(markdown).some((line) => line.startsWith('tools:'))).toBe(false);
  });

  it('never emits a Claude model pin, and only an OMP-runtime provider model', () => {
    const hasModel = (a: EffectiveAgent): boolean =>
      frontmatterLines(renderOmpAgentMarkdown(a)).some((line) => line.startsWith('model:'));

    expect(hasModel(agent({ model: 'sonnet' }))).toBe(false);
    expect(hasModel(agent({ model: null }))).toBe(false);
    expect(hasModel(agent({ runtime: 'codex-sdk', providerModel: 'gpt-5.6-sol' }))).toBe(false);
    expect(hasModel(agent({ runtime: 'omp-sdk', providerModel: '  ' }))).toBe(false);
    // A Claude alias typed into an OMP pin is dropped exactly as `--model` drops it.
    expect(hasModel(agent({ runtime: 'omp-sdk', providerModel: 'sonnet' }))).toBe(false);

    const pinned = renderOmpAgentMarkdown(
      agent({ runtime: 'omp-sdk', providerModel: 'anthropic/claude-haiku-4-5', model: 'opus' }),
    );
    expect(scalar(pinned, 'model')).toBe('anthropic/claude-haiku-4-5');
  });

  it('emits thinkingLevel only for an effort on OMP`s scale, after model', () => {
    const level = (a: EffectiveAgent): unknown => scalar(renderOmpAgentMarkdown(a), 'thinkingLevel');

    expect(level(agent({ effort: 'high' }))).toBe('high');
    expect(level(agent({ effort: 'off' }))).toBe('off');
    expect(level(agent({ effort: 'none' }))).toBeUndefined(); // Codex-only rung
    expect(level(agent())).toBeUndefined();

    const both = frontmatterLines(
      renderOmpAgentMarkdown(agent({ runtime: 'omp-sdk', providerModel: 'openai/gpt-5.6-sol', effort: 'max' })),
    );
    expect(both.slice(-2)).toEqual(['model: "openai/gpt-5.6-sol"', 'thinkingLevel: "max"']);
  });

  it('writes the prompt verbatim even when it contains `---` lines', () => {
    const systemPrompt = 'Intro\n---\n## Output\n---\nend';
    const markdown = renderOmpAgentMarkdown(agent({ systemPrompt }));

    const closing = markdown.indexOf('\n---', 3);
    // Our own closing fence is the first one OMP finds; the prompt's rules come after it.
    expect(frontmatterLines(markdown)).toHaveLength(3);
    expect(markdown.slice(closing + '\n---\n\n'.length)).toBe(systemPrompt);
  });
});

describe('toOmpThinkingLevel', () => {
  it('normalizes onto OMP`s scale and rejects anything off it', () => {
    expect(toOmpThinkingLevel(' High ')).toBe('high');
    expect(toOmpThinkingLevel('none')).toBeUndefined();
    expect(toOmpThinkingLevel('auto')).toBeUndefined();
    expect(toOmpThinkingLevel(undefined)).toBeUndefined();
  });
});

describe('writeOmpAgentFiles', () => {
  let worktree: string;
  let logger: Logger;

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-agent-writer-test-'));
    logger = makeProdLoggerSpy() as unknown as Logger;
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  const agentsDir = (): string => ompAgentsDirPath(worktree);
  const rolePath = (key: string): string => path.join(agentsDir(), `cyboflow-${key}.md`);
  const manifest = (): unknown =>
    JSON.parse(fs.readFileSync(path.join(agentsDir(), '.cyboflow-agents.json'), 'utf8'));

  it('creates .omp/agents with one file per role and an ownership manifest', () => {
    const roles = [agent(), agent({ agentKey: 'code-review', systemPrompt: 'Review.' })];

    const result = writeOmpAgentFiles({ worktreeRoot: worktree, agents: roles, logger });

    expect(result).toEqual({
      written: ['cyboflow-implement.md', 'cyboflow-code-review.md'],
      skipped: [],
      removed: [],
    });
    expect(fs.readFileSync(rolePath('implement'), 'utf8')).toBe(renderOmpAgentMarkdown(roles[0]));
    expect(fs.readFileSync(rolePath('code-review'), 'utf8')).toBe(renderOmpAgentMarkdown(roles[1]));
    expect(manifest()).toEqual({ version: 1, files: ['cyboflow-code-review.md', 'cyboflow-implement.md'] });
    // No temp file survives the atomic rename.
    expect(fs.readdirSync(agentsDir()).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('excludes .omp/ from the worktree-local git exclude, so the roles never reach git status', () => {
    execFileSync('git', ['init', '-q'], { cwd: worktree });

    writeOmpAgentFiles({ worktreeRoot: worktree, agents: [agent()], logger });

    const excludePath = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: worktree,
      encoding: 'utf8',
    }).trim();
    const resolved = path.isAbsolute(excludePath) ? excludePath : path.join(worktree, excludePath);
    expect(fs.readFileSync(resolved, 'utf8')).toContain('.omp/');
    // Without the exclude this would list `?? .omp/`.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' })).toBe('');
    expect(fs.existsSync(path.join(worktree, '.gitignore'))).toBe(false);
  });

  it('never overwrites a same-named file the user owns, and reports it as skipped', () => {
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(rolePath('implement'), 'my own implement agent', 'utf8');

    const roles = [agent(), agent({ agentKey: 'code-review' })];
    const first = writeOmpAgentFiles({ worktreeRoot: worktree, agents: roles, logger });

    expect(first.skipped).toEqual(['cyboflow-implement.md']);
    expect(first.written).toEqual(['cyboflow-code-review.md']);
    expect(fs.readFileSync(rolePath('implement'), 'utf8')).toBe('my own implement agent');
    expect(manifest()).toEqual({ version: 1, files: ['cyboflow-code-review.md'] });
    expect(warnings(logger).some((message) => message.includes('not written by cyboflow'))).toBe(true);

    // Still the user's on the next spawn — skipping never adopts it into the manifest.
    const second = writeOmpAgentFiles({ worktreeRoot: worktree, agents: roles, logger });
    expect(second.skipped).toEqual(['cyboflow-implement.md']);
    expect(fs.readFileSync(rolePath('implement'), 'utf8')).toBe('my own implement agent');
  });

  it('removes owned role files that dropped out of the set, and nothing it does not own', () => {
    writeOmpAgentFiles({
      worktreeRoot: worktree,
      agents: [agent(), agent({ agentKey: 'code-review' })],
      logger,
    });
    fs.writeFileSync(path.join(agentsDir(), 'cyboflow-mine.md'), 'user agent', 'utf8');
    fs.writeFileSync(path.join(agentsDir(), 'helper.md'), 'user agent', 'utf8');

    const result = writeOmpAgentFiles({ worktreeRoot: worktree, agents: [agent()], logger });

    expect(result.removed).toEqual(['cyboflow-code-review.md']);
    expect(fs.existsSync(rolePath('code-review'))).toBe(false);
    expect(fs.existsSync(rolePath('implement'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(), 'cyboflow-mine.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(), 'helper.md'))).toBe(true);
    expect(manifest()).toEqual({ version: 1, files: ['cyboflow-implement.md'] });
  });

  it('leaves owned roles in place when the set is empty — a transient empty resolve must not delete live roles', () => {
    writeOmpAgentFiles({ worktreeRoot: worktree, agents: [agent()], logger });

    const result = writeOmpAgentFiles({ worktreeRoot: worktree, agents: [], logger });

    expect(result).toEqual({ written: [], skipped: [], removed: [] });
    expect(fs.existsSync(rolePath('implement'))).toBe(true);
    expect(manifest()).toEqual({ version: 1, files: ['cyboflow-implement.md'] });
  });

  it('claims a new role in the manifest before creating it', () => {
    const manifestAtFirstRoleWrite: unknown[] = [];
    renameHook.before = (to) => {
      if (to.endsWith('.md') && manifestAtFirstRoleWrite.length === 0) {
        manifestAtFirstRoleWrite.push(manifest());
      }
    };
    try {
      writeOmpAgentFiles({ worktreeRoot: worktree, agents: [agent()], logger });
    } finally {
      renameHook.before = null;
    }

    // Without the up-front claim there is no manifest yet when the role lands
    // (manifest() would throw ENOENT inside the hook).
    expect(manifestAtFirstRoleWrite).toEqual([{ version: 1, files: ['cyboflow-implement.md'] }]);
  });

  it('touches nothing at all for an empty set in a worktree it never wrote to', () => {
    const result = writeOmpAgentFiles({ worktreeRoot: worktree, agents: [], logger });

    expect(result).toEqual({ written: [], skipped: [], removed: [] });
    expect(fs.existsSync(path.join(worktree, '.omp'))).toBe(false);
  });

  it('is a no-op on a second identical write, and rewrites only a role whose content changed', () => {
    const roles = [agent(), agent({ agentKey: 'code-review' })];
    writeOmpAgentFiles({ worktreeRoot: worktree, agents: roles, logger });
    // Backdate everything so a rewrite is visible even on a coarse-mtime filesystem.
    const past = new Date(Date.now() - 60_000);
    for (const name of fs.readdirSync(agentsDir())) fs.utimesSync(path.join(agentsDir(), name), past, past);
    const mtime = (name: string): number => fs.statSync(path.join(agentsDir(), name)).mtimeMs;
    const before = new Map(fs.readdirSync(agentsDir()).map((name) => [name, mtime(name)]));

    const again = writeOmpAgentFiles({ worktreeRoot: worktree, agents: roles, logger });
    expect(again).toEqual({ written: [], skipped: [], removed: [] });
    for (const [name, at] of before) expect(mtime(name)).toBe(at);

    const changed = writeOmpAgentFiles({
      worktreeRoot: worktree,
      agents: [agent({ systemPrompt: 'A new prompt.' }), roles[1]],
      logger,
    });
    expect(changed.written).toEqual(['cyboflow-implement.md']);
    expect(fs.readFileSync(rolePath('implement'), 'utf8')).toContain('A new prompt.');
    expect(mtime('cyboflow-code-review.md')).toBe(before.get('cyboflow-code-review.md'));
  });

  it('never deletes outside .omp/agents on a tampered manifest entry', () => {
    fs.mkdirSync(agentsDir(), { recursive: true });
    const outside = path.join(worktree, 'keep.md');
    fs.writeFileSync(outside, 'precious', 'utf8');
    fs.writeFileSync(
      path.join(agentsDir(), '.cyboflow-agents.json'),
      JSON.stringify({ version: 1, files: ['../../keep.md'] }),
      'utf8',
    );

    // `../../keep.md` relative to .omp/agents IS `keep.md`: an unchecked prune
    // of that entry would delete it. (A non-empty set, so the prune runs.)
    writeOmpAgentFiles({ worktreeRoot: worktree, agents: [agent()], logger });

    expect(fs.readFileSync(outside, 'utf8')).toBe('precious');
  });

  it('never throws on a root it cannot write under, and reports nothing written', () => {
    const notADirectory = path.join(worktree, 'a-file');
    fs.writeFileSync(notADirectory, '', 'utf8');

    let result: ReturnType<typeof writeOmpAgentFiles> | undefined;
    expect(() => {
      result = writeOmpAgentFiles({ worktreeRoot: notADirectory, agents: [agent()], logger });
    }).not.toThrow();

    expect(result).toEqual({ written: [], skipped: [], removed: [] });
    expect(warnings(logger).some((message) => message.includes('could not register'))).toBe(true);
  });
});

/** Every message the spied logger was warned with. */
function warnings(logger: Logger): string[] {
  return vi.mocked(logger.warn).mock.calls.map((call) => String(call[0]));
}
