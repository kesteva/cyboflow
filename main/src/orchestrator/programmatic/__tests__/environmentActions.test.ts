import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EnvironmentActions, type EnvironmentExec } from '../environmentActions';

describe('EnvironmentActions', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'env-actions-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const pkg = (rel: string, deps: Record<string, string>): void => {
    mkdirSync(join(dir, rel), { recursive: true });
    writeFileSync(join(dir, rel, 'package.json'), JSON.stringify({ name: rel, dependencies: deps }));
  };
  const okExec = (): EnvironmentExec & ReturnType<typeof vi.fn> =>
    vi.fn().mockResolvedValue({ stdout: 'Done in 3s', stderr: '' }) as EnvironmentExec & ReturnType<typeof vi.fn>;

  it('offers nothing without a lockfile', () => {
    pkg('.', { a: '1' });
    const env = new EnvironmentActions(dir, okExec(), 'darwin');
    expect(env.available()).toEqual([]);
    expect(env.missingDependencyDirs()).toEqual([]);
    expect(env.describe()).toContain('No JavaScript lockfile');
  });

  it('reports packages with dependencies but no node_modules, ignoring dependency-free ones', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    pkg('.', { a: '1' });
    pkg('frontend', { react: '1' });
    pkg('shared', {});
    pkg('main', { b: '1' });
    mkdirSync(join(dir, 'main', 'node_modules'));
    const env = new EnvironmentActions(dir, okExec(), 'darwin');
    expect(env.missingDependencyDirs().sort()).toEqual(['.', 'frontend']);
    expect(env.describe()).toContain('pnpm install --frozen-lockfile');
    expect(env.describe()).toContain('node_modules, frontend/node_modules');
  });

  it('runs the lockfile-implied FROZEN install, at most once per run', async () => {
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    const exec = okExec();
    const env = new EnvironmentActions(dir, exec, 'darwin');
    const first = await env.run('install_dependencies');
    const second = await env.run('install_dependencies');
    expect(first.ok).toBe(true);
    expect(second).toBe(first);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('npm', ['ci'], dir, expect.any(Number));
    expect(env.describe()).toContain('already ran in this run');
  });

  it('reports a failed install with its output', async () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('exit 1'), { stderr: 'ERR_PNPM_OUTDATED_LOCKFILE' }));
    const env = new EnvironmentActions(dir, exec as EnvironmentExec, 'darwin');
    const result = await env.run('install_dependencies');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
  });

  it('is unavailable on Windows', async () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const exec = okExec();
    const env = new EnvironmentActions(dir, exec, 'win32');
    expect(env.available()).toEqual([]);
    expect((await env.run('install_dependencies')).ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
