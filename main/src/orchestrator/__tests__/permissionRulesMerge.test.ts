/**
 * The pure permission-rule merge (mergePermissionRuleSources) behind loadMergedPermissionRules, and the injected-
 * reader loader for a project dir this Mac cannot read (loadMergedPermissionRulesFrom — an SSH environment's
 * worktree, spec M2 §5 D2): same trust model, user rules from this Mac, fail-closed on a project read failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadMergedPermissionRules,
  loadMergedPermissionRulesFrom,
  mergePermissionRuleSources,
  ruleArrayFromSettingsText,
  setProjectPermissionTrustResolver,
} from '../permissionRules';

const settings = (permissions: Record<string, unknown>): string => JSON.stringify({ permissions });

describe('ruleArrayFromSettingsText', () => {
  it('reads the string entries of one key; null / malformed / non-array → []', () => {
    expect(ruleArrayFromSettingsText(settings({ allow: ['Bash(ls:*)', 3, 'Read'] }), 'allow')).toEqual(['Bash(ls:*)', 'Read']);
    expect(ruleArrayFromSettingsText(null, 'allow')).toEqual([]);
    expect(ruleArrayFromSettingsText('{not json', 'deny')).toEqual([]);
    expect(ruleArrayFromSettingsText(settings({ ask: 'Bash' }), 'ask')).toEqual([]);
  });
});

describe('mergePermissionRuleSources', () => {
  const user = settings({ allow: ['Read', 'Bash(git status)'], deny: ['Bash(rm:*)'], ask: ['Bash(git push:*)'] });
  const project = settings({ allow: ['Bash'], deny: ['Bash(curl:*)', 'Bash(rm:*)'], ask: ['WebFetch'] });
  const local = settings({ allow: ['Edit'], deny: ['Write'] });

  it('untrusted: user allow only; deny/ask unioned and de-duplicated in first-seen order', () => {
    expect(mergePermissionRuleSources({ userText: user, projectTexts: [project, local], trustProject: false })).toEqual({
      allow: ['Read', 'Bash(git status)'],
      deny: ['Bash(rm:*)', 'Bash(curl:*)', 'Write'],
      ask: ['Bash(git push:*)', 'WebFetch'],
    });
  });

  it('trusted: project allow rules join after the user ones', () => {
    expect(mergePermissionRuleSources({ userText: user, projectTexts: [project, local], trustProject: true }).allow)
      .toEqual(['Read', 'Bash(git status)', 'Bash', 'Edit']);
  });

  it('missing files contribute nothing', () => {
    expect(mergePermissionRuleSources({ userText: null, projectTexts: [null, null], trustProject: true }))
      .toEqual({ allow: [], deny: [], ask: [] });
  });
});

describe('loaders', () => {
  let home: string;
  let project: string;
  const prevTrust = process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-perm-home-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-perm-proj-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), settings({ allow: ['Read'], deny: ['Bash(rm:*)'] }));
    delete process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES;
    setProjectPermissionTrustResolver(() => false);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    if (prevTrust === undefined) delete process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES;
    else process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES = prevTrust;
    setProjectPermissionTrustResolver(() => false);
  });

  it('the injected-reader loader matches the local loader for the same files', async () => {
    const files: Record<string, string> = {
      '.claude/settings.json': settings({ allow: ['Bash'], deny: ['Bash(curl:*)'] }),
      '.claude/settings.local.json': settings({ ask: ['WebFetch'] }),
    };
    fs.mkdirSync(path.join(project, '.claude'));
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(project, rel), text);
    const remoteRoot = '/srv/remote/wt';
    const reads: string[] = [];
    const reader = async (p: string): Promise<string | null> => {
      reads.push(p);
      return files[p.slice(remoteRoot.length + 1)] ?? null;
    };
    for (const trusted of [false, true]) {
      setProjectPermissionTrustResolver((dir) => trusted && (dir === project || dir === remoteRoot));
      expect(await loadMergedPermissionRulesFrom(remoteRoot, reader, home)).toEqual(loadMergedPermissionRules(project, home));
    }
    expect(reads.slice(0, 2)).toEqual([`${remoteRoot}/.claude/settings.json`, `${remoteRoot}/.claude/settings.local.json`]);
  });

  it('missing project files → the user rules alone', async () => {
    expect(await loadMergedPermissionRulesFrom('/srv/wt', async () => null, home)).toEqual({
      allow: ['Read'],
      deny: ['Bash(rm:*)'],
      ask: [],
    });
  });

  it('fails closed: an unreadable project file drops EVERY allow rule but keeps what it could read', async () => {
    process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES = '1';
    const reader = async (p: string): Promise<string | null> => {
      if (p.endsWith('settings.local.json')) throw new Error('host unreachable');
      return settings({ allow: ['Bash'], deny: ['Write'] });
    };
    expect(await loadMergedPermissionRulesFrom('/srv/wt', reader, home)).toEqual({
      allow: [],
      deny: ['Bash(rm:*)', 'Write'],
      ask: [],
    });
  });

  it('a throwing trust resolver is untrusted', async () => {
    setProjectPermissionTrustResolver(() => {
      throw new Error('db gone');
    });
    const rules = await loadMergedPermissionRulesFrom('/srv/wt', async () => settings({ allow: ['Bash'] }), home);
    expect(rules.allow).toEqual(['Read']);
  });
});
