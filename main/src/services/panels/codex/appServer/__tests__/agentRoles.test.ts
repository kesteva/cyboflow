import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EffectiveAgent } from '../../../../../orchestrator/agents/effectiveAgents';
import { makeSpyLogger } from '../../../../../orchestrator/__test_fixtures__/loggerLikeSpy';
import {
  _resetCodexAgentRolePruneForTesting,
  materializeCodexAgentRoles,
  pruneStaleCodexAgentRoleFiles,
  renderCodexAgentRoleToml,
  tomlBasicString,
} from '../agentRoles';

function agent(overrides: Partial<EffectiveAgent> = {}): EffectiveAgent {
  return {
    agentKey: 'code-review',
    name: 'cyboflow-code-review',
    role: 'Code reviewer',
    description: 'Reviews the lane diff for defects.',
    systemPrompt: 'You review code.\nReport blocking defects.',
    tools: ['Read', 'Grep'],
    model: null,
    enabledMcps: [],
    source: 'builtin',
    ...overrides,
  };
}

const INSTRUCTIONS_PREFIX = 'developer_instructions = ';

/** The TOML basic string on the `developer_instructions` line, decoded. */
function decodedInstructions(toml: string): string {
  const line = toml.split('\n')[0];
  expect(line.startsWith(INSTRUCTIONS_PREFIX)).toBe(true);
  return JSON.parse(line.slice(INSTRUCTIONS_PREFIX.length)) as string;
}

/**
 * A spec-level check that `encoded` is a legal TOML basic string: quoted, every
 * escape one TOML defines (a `\uXXXX` naming a Unicode SCALAR value, never a
 * surrogate), and no raw character TOML forbids (U+0000–U+0008, U+000A–U+001F,
 * U+007F). Returns the first violation, or null.
 */
function tomlBasicStringViolation(encoded: string): string | null {
  if (!encoded.startsWith('"') || !encoded.endsWith('"') || encoded.length < 2) return 'not quoted';
  const body = encoded.slice(1, -1);
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    const code = ch.charCodeAt(0);
    if (ch === '"') return `raw quote at ${i}`;
    if ((code <= 0x08) || (code >= 0x0a && code <= 0x1f) || code === 0x7f) {
      return `raw control U+${code.toString(16).padStart(4, '0')} at ${i}`;
    }
    if (ch !== '\\') continue;
    const next = body[i + 1];
    if (next !== undefined && '"\\bfnrt'.includes(next)) {
      i += 1;
      continue;
    }
    const hex = next === 'u' ? body.slice(i + 2, i + 6) : '';
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return `bad escape at ${i}`;
    const scalar = Number.parseInt(hex, 16);
    if (scalar >= 0xd800 && scalar <= 0xdfff) return `surrogate escape \\u${hex} at ${i}`;
    i += 5;
  }
  return null;
}

describe('tomlBasicString', () => {
  const tricky = [
    'plain',
    'back\\slash and C:\\path\\to',
    'triple """ and \'\'\' quotes',
    'line one\nline two\r\nline three',
    'tab\there and form\ffeed and bell\u0007 and nul\u0000',
    'emoji 🚀 and CJK 漢字 and combining é',
    'DEL\u007F char',
    'line separators \u2028 \u2029',
  ];

  it('round-trips tricky prompts losslessly and always yields a legal TOML basic string', () => {
    for (const input of tricky) {
      const encoded = tomlBasicString(input);
      expect(tomlBasicStringViolation(encoded), JSON.stringify(input)).toBeNull();
      expect(JSON.parse(encoded)).toBe(input);
    }
  });

  it('replaces lone surrogates with U+FFFD but keeps a valid surrogate PAIR intact', () => {
    const encoded = tomlBasicString('lone high \uD800 x lone low \uDC00 pair \uD83D\uDE80');
    expect(tomlBasicStringViolation(encoded)).toBeNull();
    expect(JSON.parse(encoded)).toBe('lone high \uFFFD x lone low \uFFFD pair 🚀');
  });

  it('negative control: bare JSON.stringify is NOT a TOML encoder (the validator can fail)', () => {
    // Proves the violation check above has teeth: the two gaps tomlBasicString
    // closes are exactly what a naive JSON.stringify leaves open.
    expect(tomlBasicStringViolation(JSON.stringify('lone \uD800'))).toMatch(/surrogate/);
    expect(tomlBasicStringViolation(JSON.stringify('del \u007F'))).toMatch(/U\+007f/);
  });
});

describe('renderCodexAgentRoleToml', () => {
  it('puts the system prompt in developer_instructions, losslessly, for a hostile prompt', () => {
    const prompt = 'Use \\n literally, """fences""", \'\'\'raw\'\'\', tabs\tand\nnewlines 🚀 lone\uD800';
    const toml = renderCodexAgentRoleToml(agent({ systemPrompt: prompt }));
    expect(decodedInstructions(toml)).toBe(prompt.replace('\uD800', '\uFFFD'));
    // The prompt occupies exactly one physical line — no raw newline leaked.
    expect(toml.split('\n')[1]).not.toContain('newlines');
  });

  it('emits only the typed keys Codex applies to a role child — never mcp_servers or sandbox_mode', () => {
    const toml = renderCodexAgentRoleToml(agent({
      runtime: 'codex-sdk',
      providerModel: 'gpt-5.6-sol',
      effort: 'high',
    }));
    const keys = toml
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split(' = ')[0]);
    // Codex drops every other key of a role file (codex-rs/core/src/agent/role.rs
    // AgentRoleOverrides); a table here would read as a restriction it is not.
    expect(keys).toEqual(['developer_instructions', 'model', 'model_reasoning_effort']);
    expect(toml).not.toContain('[');
  });

  it('never emits sandbox_mode (a role sandbox does not restrict the child)', () => {
    const toml = renderCodexAgentRoleToml(agent({ runtime: 'codex-sdk', providerModel: 'm', effort: 'low' }));
    expect(toml).not.toMatch(/sandbox/);
  });

  it('emits model ONLY for an agent pinned onto a Codex runtime with a providerModel', () => {
    const modelLine = (overrides: Partial<EffectiveAgent>): string | undefined =>
      renderCodexAgentRoleToml(agent(overrides)).split('\n').find((line) => line.startsWith('model = '));

    expect(modelLine({ runtime: 'codex-sdk', providerModel: 'gpt-5.6-sol' })).toBe('model = "gpt-5.6-sol"');
    // No runtime pin: the child inherits the parent thread's model.
    expect(modelLine({ providerModel: 'gpt-5.6-sol' })).toBeUndefined();
    // A providerModel pinned for ANOTHER provider names a model Codex does not serve.
    expect(modelLine({ runtime: 'omp-sdk', providerModel: 'anthropic/claude-x' })).toBeUndefined();
    // A Claude alias is never a Codex model.
    expect(modelLine({ runtime: 'claude-sdk', model: 'sonnet' })).toBeUndefined();
    expect(modelLine({ model: 'opus' })).toBeUndefined();
    // Codex runtime with no/blank providerModel: nothing to pin.
    expect(modelLine({ runtime: 'codex-sdk' })).toBeUndefined();
    expect(modelLine({ runtime: 'codex-sdk', providerModel: '   ' })).toBeUndefined();
  });

  it('emits model_reasoning_effort ONLY for a value on Codex\'s scale', () => {
    const effortLine = (effort: EffectiveAgent['effort']): string | undefined =>
      renderCodexAgentRoleToml(agent({ effort })).split('\n').find((line) => line.startsWith('model_reasoning_effort'));

    expect(effortLine('high')).toBe('model_reasoning_effort = "high"');
    expect(effortLine('xhigh')).toBe('model_reasoning_effort = "xhigh"');
    // Codex-only rungs are kept.
    expect(effortLine('none')).toBe('model_reasoning_effort = "none"');
    expect(effortLine('minimal')).toBe('model_reasoning_effort = "minimal"');
    // Claude's `max` and OMP's `off` are not on Codex's scale — an unknown value
    // would fail the whole role file, so they are dropped.
    expect(effortLine('max')).toBeUndefined();
    expect(effortLine('off')).toBeUndefined();
    expect(effortLine(undefined)).toBeUndefined();
  });
});

describe('materializeCodexAgentRoles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'codex-agent-roles-'));
    _resetCodexAgentRolePruneForTesting();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The content-addressed path the materializer must pick for `a` under `dir`. */
  function expectedPath(a: EffectiveAgent): string {
    const digest = createHash('sha256').update(renderCodexAgentRoleToml(a)).digest('hex').slice(0, 16);
    return path.join(dir, `cyboflow-${a.agentKey}-${digest}.toml`);
  }

  it('writes a content-addressed role file and returns its absolute path under cyboflow-<key>', () => {
    const review = agent();
    const roles = materializeCodexAgentRoles([review], dir);

    expect(Object.keys(roles)).toEqual(['cyboflow-code-review']);
    const entry = roles['cyboflow-code-review'];
    expect(entry.description).toBe('Reviews the lane diff for defects.');
    expect(path.isAbsolute(entry.config_file)).toBe(true);
    expect(entry.config_file).toBe(expectedPath(review));
    expect(path.basename(entry.config_file)).toMatch(/^cyboflow-code-review-[0-9a-f]{16}\.toml$/);
    expect(readFileSync(entry.config_file, 'utf8')).toBe(renderCodexAgentRoleToml(review));
    // The atomic write leaves no temp file behind.
    expect(readdirSync(dir)).toEqual([path.basename(entry.config_file)]);
  });

  it('resolves a relative rolesDir to an absolute config_file (a per-thread override has no base dir)', () => {
    const roles = materializeCodexAgentRoles([agent()], path.relative(process.cwd(), dir));
    expect(path.isAbsolute(roles['cyboflow-code-review'].config_file)).toBe(true);
    expect(existsSync(roles['cyboflow-code-review'].config_file)).toBe(true);
  });

  it('falls back to a generated description when the agent has none', () => {
    const roles = materializeCodexAgentRoles([agent({ description: '  ' })], dir);
    expect(roles['cyboflow-code-review'].description).toBe('Cyboflow code-review role');
  });

  it('reuses a present file without rewriting it, refreshing only its mtime', () => {
    const review = agent();
    const first = materializeCodexAgentRoles([review], dir)['cyboflow-code-review'].config_file;
    // A same-length sentinel body + an old mtime: a rewrite would restore the
    // rendered body, and a missing touch would leave the mtime old.
    const sentinel = 'S'.repeat(Buffer.byteLength(readFileSync(first, 'utf8'), 'utf8'));
    writeFileSync(first, sentinel);
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(first, old, old);

    const second = materializeCodexAgentRoles([review], dir)['cyboflow-code-review'].config_file;

    expect(second).toBe(first);
    expect(readFileSync(second, 'utf8')).toBe(sentinel);
    expect(statSync(second).mtimeMs).toBeGreaterThan(old.getTime() + 60_000);
  });

  it('rewrites a truncated role file — an empty file is valid TOML with no instructions', () => {
    const review = agent();
    const file = materializeCodexAgentRoles([review], dir)['cyboflow-code-review'].config_file;
    const rendered = readFileSync(file, 'utf8');
    writeFileSync(file, '');

    materializeCodexAgentRoles([review], dir);

    expect(readFileSync(file, 'utf8')).toBe(rendered);
  });

  it('gives a changed prompt a DIFFERENT path (what busts the warm fingerprint)', () => {
    const a = materializeCodexAgentRoles([agent({ systemPrompt: 'Prompt A' })], dir);
    const b = materializeCodexAgentRoles([agent({ systemPrompt: 'Prompt B' })], dir);
    expect(a['cyboflow-code-review'].config_file).not.toBe(b['cyboflow-code-review'].config_file);
    expect(existsSync(a['cyboflow-code-review'].config_file)).toBe(true);
    expect(existsSync(b['cyboflow-code-review'].config_file)).toBe(true);
  });

  it('omits ONLY the agent whose file cannot be written, and warns', () => {
    const implement = agent({ agentKey: 'implement', systemPrompt: 'Implement it.' });
    const review = agent();
    // A directory squatting on implement's exact target path: the rename fails.
    mkdirSync(expectedPath(implement));
    const logger = makeSpyLogger();

    const roles = materializeCodexAgentRoles([implement, review], dir, logger);

    expect(Object.keys(roles)).toEqual(['cyboflow-code-review']);
    expect(logger.calls.some((c) => c.level === 'warn' && c.message.includes('cyboflow-implement'))).toBe(true);
  });

  it('omits an agent whose key is not a safe filename', () => {
    const logger = makeSpyLogger();
    // Unguarded, `cyboflow-../../escape-<digest>.toml` normalizes to a writable
    // `<dir>/escape-<digest>.toml` and the role would register.
    const roles = materializeCodexAgentRoles([agent({ agentKey: '../../escape' }), agent()], dir, logger);
    expect(Object.keys(roles)).toEqual(['cyboflow-code-review']);
    expect(readdirSync(dir)).toEqual([path.basename(roles['cyboflow-code-review'].config_file)]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never throws: an unrenderable agent is omitted and an unusable dir yields {}', () => {
    const broken = agent({ agentKey: 'implement', systemPrompt: undefined as unknown as string });
    expect(Object.keys(materializeCodexAgentRoles([broken, agent()], dir))).toEqual(['cyboflow-code-review']);

    const fileNotDir = path.join(dir, 'not-a-dir');
    writeFileSync(fileNotDir, 'x');
    const logger = makeSpyLogger();
    expect(materializeCodexAgentRoles([agent()], fileNotDir, logger)).toEqual({});
    expect(logger.warn).toHaveBeenCalled();
  });

  it('touches nothing on disk when there are no agents', () => {
    const nested = path.join(dir, 'never-created');
    expect(materializeCodexAgentRoles([], nested)).toEqual({});
    expect(existsSync(nested)).toBe(false);
  });

  it('prunes stale files at most once per process per directory, then re-writes a pruned in-use role', () => {
    const stalePath = path.join(dir, 'cyboflow-old-0000000000000000.toml');
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const plant = (file: string): void => {
      writeFileSync(file, 'stale');
      utimesSync(file, ancient, ancient);
    };

    // The role in use is ITSELF stale on disk: pruned, then written back.
    const review = agent();
    plant(expectedPath(review));
    plant(stalePath);
    const roles = materializeCodexAgentRoles([review], dir);
    expect(existsSync(stalePath)).toBe(false);
    expect(readFileSync(roles['cyboflow-code-review'].config_file, 'utf8')).toBe(renderCodexAgentRoleToml(review));

    // Second call in the same process: no second sweep.
    plant(stalePath);
    materializeCodexAgentRoles([review], dir);
    expect(existsSync(stalePath)).toBe(true);

    // The test hook re-arms it.
    _resetCodexAgentRolePruneForTesting();
    materializeCodexAgentRoles([review], dir);
    expect(existsSync(stalePath)).toBe(false);
  });
});

describe('pruneStaleCodexAgentRoleFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'codex-agent-roles-prune-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes only OUR role files (and leftover temps) older than 7 days', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const plant = (name: string, ageDays: number): void => {
      const file = path.join(dir, name);
      writeFileSync(file, 'x');
      const at = new Date(now - ageDays * day);
      utimesSync(file, at, at);
    };
    plant('cyboflow-implement-aaaaaaaaaaaaaaaa.toml', 8);          // stale role → pruned
    plant('cyboflow-implement-aaaaaaaaaaaaaaaa.toml.1-x.tmp', 8);   // stale temp → pruned
    plant('cyboflow-code-review-bbbbbbbbbbbbbbbb.toml', 6);        // fresh role → kept
    plant('someone-else.toml', 30);                                 // not ours → kept
    plant('cyboflow-notes.txt', 30);                                // not a role file → kept
    mkdirSync(path.join(dir, 'cyboflow-dir.toml'));                 // not a file → kept

    expect(pruneStaleCodexAgentRoleFiles(dir, undefined, now)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([
      'cyboflow-code-review-bbbbbbbbbbbbbbbb.toml',
      'cyboflow-dir.toml',
      'cyboflow-notes.txt',
      'someone-else.toml',
    ]);
  });

  it('is fail-soft on a missing directory', () => {
    const logger = makeSpyLogger();
    expect(pruneStaleCodexAgentRoleFiles(path.join(dir, 'missing'), logger)).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});
