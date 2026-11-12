/**
 * Test fake for the RunWorktreeHost contract (orchestrator/trpc/contracts/runHostAccess.ts): an in-memory remote
 * filesystem plus scripted git / exec, every method a vi.fn so tests can assert what reached "the environment".
 */
import { vi } from 'vitest';
import type { MachineStat } from '../../trpc/contracts/executionHost';
import type {
  RunHostCommandOutput,
  RunHostGitExit,
  RunWorktreeHost,
} from '../../trpc/contracts/runHostAccess';

export interface FakeRunWorktreeHost extends RunWorktreeHost {
  /** path → file content. */
  files: Map<string, string>;
  /** absolute directory paths. */
  dirs: Set<string>;
  exists: ReturnType<typeof vi.fn> & RunWorktreeHost['exists'];
  stat: ReturnType<typeof vi.fn> & RunWorktreeHost['stat'];
  readdir: ReturnType<typeof vi.fn> & RunWorktreeHost['readdir'];
  readFile: ReturnType<typeof vi.fn> & RunWorktreeHost['readFile'];
  mkdirp: ReturnType<typeof vi.fn> & RunWorktreeHost['mkdirp'];
  gitExit: ReturnType<typeof vi.fn> & RunWorktreeHost['gitExit'];
  gitCapture: ReturnType<typeof vi.fn> & RunWorktreeHost['gitCapture'];
  execIn: ReturnType<typeof vi.fn> & RunWorktreeHost['execIn'];
}

function parentsOf(p: string): string[] {
  const out: string[] = [];
  let cur = p;
  for (;;) {
    const i = cur.lastIndexOf('/');
    if (i <= 0) break;
    cur = cur.slice(0, i);
    out.push(cur);
  }
  return out;
}

export function fakeRunWorktreeHost(opts: {
  hostId?: string;
  files?: Record<string, string>;
  dirs?: string[];
  git?: (cwd: string, args: string[]) => RunHostGitExit;
  exec?: (cwd: string, bin: string, args: string[]) => Promise<RunHostCommandOutput>;
} = {}): FakeRunWorktreeHost {
  const files = new Map(Object.entries(opts.files ?? {}));
  const dirs = new Set<string>(opts.dirs ?? []);
  for (const f of files.keys()) for (const d of parentsOf(f)) dirs.add(d);
  const git = opts.git ?? ((): RunHostGitExit => ({ exitCode: 0, stdout: '', stderr: '' }));
  const statOf = (p: string): MachineStat | null => {
    if (files.has(p)) return { isFile: true, isDir: false, size: files.get(p)?.length ?? 0, mode: 0o644 };
    if (dirs.has(p)) return { isFile: false, isDir: true, size: 0, mode: 0o755 };
    return null;
  };
  const host = {
    hostId: opts.hostId ?? 'h1',
    files,
    dirs,
    exists: vi.fn(async (p: string) => statOf(p) !== null),
    stat: vi.fn(async (p: string) => statOf(p)),
    readdir: vi.fn(async (p: string) => {
      if (!dirs.has(p)) throw new Error(`ENOTDIR ${p}`);
      const names = new Set<string>();
      for (const entry of [...files.keys(), ...dirs]) {
        if (entry.startsWith(`${p}/`)) names.add(entry.slice(p.length + 1).split('/')[0]);
      }
      return [...names];
    }),
    readFile: vi.fn(async (p: string) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT ${p}`);
      return content;
    }),
    mkdirp: vi.fn(async (p: string) => {
      dirs.add(p);
      for (const d of parentsOf(p)) dirs.add(d);
    }),
    gitExit: vi.fn(async (cwd: string, args: string[]) => git(cwd, args)),
    gitCapture: vi.fn(async (cwd: string, args: string[]) => {
      const r = git(cwd, args);
      if (r.exitCode !== 0) throw new Error(`Command failed: git ${args.join(' ')}`);
      return r.stdout;
    }),
    execIn: vi.fn(async (cwd: string, bin: string, args: string[]) =>
      opts.exec ? opts.exec(cwd, bin, args) : { stdout: 'ok', stderr: '' },
    ),
  };
  return host as FakeRunWorktreeHost;
}
