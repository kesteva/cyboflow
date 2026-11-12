/**
 * HostEnvironmentActions — a REMOTE run's environment actions (spec M2 §5 D3): same plan and closed action set as
 * the local EnvironmentActions, every read and the install through the run's host, sync reads from a primed
 * snapshot.
 */
import { describe, expect, it } from 'vitest';
import { HostEnvironmentActions } from '../environmentActions';
import { fakeRunWorktreeHost } from './fakeRunWorktreeHost';

const WT = '/home/k/cf-remote/h1/wt/s1';
const pkg = (deps: Record<string, string>): string => JSON.stringify({ name: 'x', dependencies: deps });

describe('HostEnvironmentActions', () => {
  it('offers nothing until the snapshot is read, then reports from the remote worktree', async () => {
    const host = fakeRunWorktreeHost({
      files: {
        [`${WT}/pnpm-lock.yaml`]: '',
        [`${WT}/package.json`]: pkg({ a: '1' }),
        [`${WT}/frontend/package.json`]: pkg({ react: '1' }),
        [`${WT}/shared/package.json`]: JSON.stringify({ name: 'shared' }),
        [`${WT}/main/package.json`]: pkg({ b: '1' }),
      },
      dirs: [`${WT}/main/node_modules`, `${WT}/docs`],
    });
    const env = new HostEnvironmentActions(WT, host);
    expect(env.available()).toEqual([]);
    expect(env.describe()).toContain('could not be read yet');

    await env.prime();

    expect(env.available()).toEqual(['install_dependencies']);
    expect(env.missingDependencyDirs().sort()).toEqual(['.', 'frontend']);
    const report = env.describe();
    expect(report).toContain('remote environment');
    expect(report).toContain('pnpm install --frozen-lockfile');
    expect(report).toContain('Dependency folders MISSING: ');
    expect(host.exists).toHaveBeenCalledWith(`${WT}/pnpm-lock.yaml`);
  });

  it('runs the frozen install on the host in the remote worktree, once', async () => {
    const host = fakeRunWorktreeHost({
      files: { [`${WT}/package-lock.json`]: '', [`${WT}/package.json`]: pkg({ a: '1' }) },
    });
    const env = new HostEnvironmentActions(WT, host);
    await env.prime();

    const first = await env.run('install_dependencies');
    const second = await env.run('install_dependencies');

    expect(first).toEqual({ ok: true, summary: '`npm ci` succeeded on the environment', detail: 'ok' });
    expect(second).toBe(first);
    expect(host.execIn).toHaveBeenCalledTimes(1);
    expect(host.execIn).toHaveBeenCalledWith(WT, 'npm', ['ci'], { timeoutMs: 15 * 60 * 1000 });
    expect(env.describe()).toContain('already ran in this run');
  });

  it('reports a failed install with the (host-redacted) output tail', async () => {
    const host = fakeRunWorktreeHost({
      files: { [`${WT}/pnpm-lock.yaml`]: '', [`${WT}/package.json`]: pkg({ a: '1' }) },
      exec: async () => {
        throw Object.assign(new Error('Command failed: pnpm install --frozen-lockfile'), {
          code: 1,
          stdout: 'progress',
          stderr: 'ERR_PNPM_OUTDATED_LOCKFILE',
        });
      },
    });
    const env = new HostEnvironmentActions(WT, host);
    const result = await env.run('install_dependencies');
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('`pnpm install --frozen-lockfile` failed on the environment');
    expect(result.detail).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
  });

  it('has no actions without a lockfile and when the host cannot be read', async () => {
    const empty = new HostEnvironmentActions(WT, fakeRunWorktreeHost({ files: { [`${WT}/package.json`]: pkg({ a: '1' }) } }));
    await empty.prime();
    expect(empty.available()).toEqual([]);
    expect(empty.missingDependencyDirs()).toEqual([]);
    expect(empty.describe()).toContain('No JavaScript lockfile');
    expect((await empty.run('install_dependencies')).ok).toBe(false);

    const down = fakeRunWorktreeHost();
    down.exists.mockRejectedValue(new Error('Environments are turned off.'));
    const unreachable = new HostEnvironmentActions(WT, down);
    await unreachable.prime();
    expect(unreachable.available()).toEqual([]);
    expect(unreachable.describe()).toContain('Environments are turned off.');
    const r = await unreachable.run('install_dependencies');
    expect(r).toMatchObject({ ok: false, summary: 'could not read the worktree on the environment' });
    expect(down.execIn).not.toHaveBeenCalled();
  });
});
