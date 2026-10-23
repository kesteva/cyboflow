/**
 * Test fixture: an in-memory POSIX MachineFs (an SSH environment's fs without ssh). Records every call in `ops`
 * (`<verb>:<path>`) and every HostPath host id it saw, mirrors the real backends' contracts (readdir / readFile reject
 * on a missing path, unlink of a missing path is fine, writeFile needs the parent dir, readFile truncates at
 * maxBytes), and can fail chosen calls through `failOn`.
 */
import * as path from 'path';
import type { HostPath, MachineFs, MachineStat } from '../../../orchestrator/trpc/contracts/executionHost';

export type FakeFsVerb = 'exists' | 'readFile' | 'writeFile' | 'mkdirp' | 'readdir' | 'unlink' | 'rmrf' | 'stat';

export interface FakeMachineFs extends MachineFs {
  readonly files: Map<string, { data: string; mode: number }>;
  readonly dirs: Set<string>;
  readonly ops: string[];
  readonly hostIds: Set<string>;
  /** Return an Error to make that call reject. */
  failOn: ((verb: FakeFsVerb, p: string) => Error | null) | null;
}

export function createFakeMachineFs(seed: Record<string, string> = {}): FakeMachineFs {
  const files = new Map<string, { data: string; mode: number }>();
  const dirs = new Set<string>(['/']);
  const ops: string[] = [];
  const hostIds = new Set<string>();
  const addDirs = (dir: string): void => {
    for (let d = dir; !dirs.has(d); d = path.posix.dirname(d)) dirs.add(d);
  };
  for (const [p, data] of Object.entries(seed)) {
    addDirs(path.posix.dirname(p));
    files.set(p, { data, mode: 0o644 });
  }
  const fake: FakeMachineFs = {
    files,
    dirs,
    ops,
    hostIds,
    failOn: null,
    exists: async (p) => {
      enter('exists', p);
      return files.has(p.path) || dirs.has(p.path);
    },
    readFile: async (p, maxBytes) => {
      enter('readFile', p);
      const f = files.get(p.path);
      if (f === undefined) throw new Error(`read failed: ${p.path}`);
      return maxBytes === undefined ? f.data : f.data.slice(0, maxBytes);
    },
    writeFile: async (p, data, mode) => {
      enter('writeFile', p);
      if (!dirs.has(path.posix.dirname(p.path))) throw new Error(`write failed (no dir): ${p.path}`);
      files.set(p.path, { data, mode });
    },
    mkdirp: async (p) => {
      enter('mkdirp', p);
      addDirs(p.path);
    },
    readdir: async (p) => {
      enter('readdir', p);
      if (!dirs.has(p.path)) throw new Error(`readdir failed: ${p.path}`);
      const names = new Set<string>();
      for (const f of files.keys()) if (path.posix.dirname(f) === p.path) names.add(path.posix.basename(f));
      for (const d of dirs) if (d !== p.path && path.posix.dirname(d) === p.path) names.add(path.posix.basename(d));
      return [...names].sort();
    },
    unlink: async (p) => {
      enter('unlink', p);
      files.delete(p.path);
    },
    rmrf: async (p) => {
      enter('rmrf', p);
      for (const f of [...files.keys()]) if (f === p.path || f.startsWith(`${p.path}/`)) files.delete(f);
      for (const d of [...dirs]) if (d === p.path || d.startsWith(`${p.path}/`)) dirs.delete(d);
    },
    stat: async (p): Promise<MachineStat | null> => {
      enter('stat', p);
      const f = files.get(p.path);
      if (f !== undefined) return { isFile: true, isDir: false, size: Buffer.byteLength(f.data), mode: f.mode };
      if (dirs.has(p.path)) return { isFile: false, isDir: true, size: 0, mode: 0o755 };
      return null;
    },
  };
  function enter(verb: FakeFsVerb, p: HostPath): void {
    ops.push(`${verb}:${p.path}`);
    hostIds.add(p.hostId);
    const err = fake.failOn?.(verb, p.path) ?? null;
    if (err !== null) throw err;
  }
  return fake;
}

/** The cyboflow-* files under `root` as `{ relPath: content }`. */
export function cyboflowFilesUnder(fake: Pick<FakeMachineFs, 'files'>, root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, f] of fake.files) {
    if (p.startsWith(`${root}/`) && path.posix.basename(p).startsWith('cyboflow-')) out[p.slice(root.length + 1)] = f.data;
  }
  return out;
}
