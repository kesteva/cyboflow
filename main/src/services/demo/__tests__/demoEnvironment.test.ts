import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetDemoEnvironment, DEMO_REMOTE_URL } from '../demoEnvironment';

function gitOut(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8' }).trim();
}

describe('resetDemoEnvironment', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('builds a sandbox repo on main with seed files and an initial commit', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-demo-test-'));
    const env = resetDemoEnvironment(root);

    expect(env.sandboxPath).toBe(path.join(root, 'demo-project'));
    expect(env.databasePath).toBe(path.join(root, 'demo.db'));
    expect(fs.existsSync(path.join(env.sandboxPath, 'src/notes.ts'))).toBe(true);
    expect(fs.existsSync(path.join(env.sandboxPath, 'README.md'))).toBe(true);

    expect(gitOut(env.sandboxPath, 'branch --show-current')).toBe('main');
    expect(gitOut(env.sandboxPath, 'log --oneline')).toContain('Initial commit');
    // Worktree is clean — everything seeded is committed.
    expect(gitOut(env.sandboxPath, 'status --porcelain')).toBe('');
  });

  it('points origin fetch at the fake GitHub URL and push at the local bare repo', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-demo-test-'));
    const env = resetDemoEnvironment(root);

    expect(gitOut(env.sandboxPath, 'remote get-url origin')).toBe(DEMO_REMOTE_URL);
    expect(gitOut(env.sandboxPath, 'remote get-url --push origin')).toBe(env.bareRemotePath);
    // main was pushed to the bare remote so PR pushes have a base.
    expect(gitOut(env.bareRemotePath, 'branch')).toContain('main');
  });

  it('wipes prior state on every reset (the no-persistence contract)', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-demo-test-'));
    const first = resetDemoEnvironment(root);
    const leftover = path.join(first.sandboxPath, 'leftover.txt');
    fs.writeFileSync(leftover, 'stale demo data');
    fs.writeFileSync(path.join(root, 'demo.db'), 'stale db');

    const second = resetDemoEnvironment(root);
    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(second.databasePath)).toBe(false);
    expect(gitOut(second.sandboxPath, 'status --porcelain')).toBe('');
  });
});
