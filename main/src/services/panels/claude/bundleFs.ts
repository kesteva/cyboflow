/**
 * bundleFs — the async filesystem port the workflow bundle + agent overlay writers place files through, so the
 * same install/teardown logic can target This Mac or an SSH environment (spec M2 §5 Phase D item 1).
 *
 * Paths are plain strings in the TARGET machine's syntax; `path` carries the matching join/resolve flavour
 * (`node:path` for This Mac, `path.posix` for an environment — remote worktrees are always POSIX).
 *
 *  - The LOCAL implementation (`localBundleFs`, in workflowBundleWriter.ts beside the sync writer it mirrors) wraps
 *    today's sync node:fs calls one-for-one.
 *  - The HOST implementation (`hostBundleFs`, below) runs every call through ExecutionHost.fs (MachineFs) with a
 *    fixed HostPath host id. It imports no fs of its own (no fs-ratchet entry).
 *
 * The production This Mac spawn keeps calling the SYNC writer API (WorkflowBundleWriter.write/remove,
 * installWorkflowBundle) so its behaviour stays byte-identical; the port API is what a remote spawn uses.
 */
import * as path from 'path';
import type { MachineFs } from '../../../orchestrator/trpc/contracts/executionHost';

/** The path operations the writers need, in the target machine's syntax. */
export type BundlePathApi = Pick<typeof path, 'join' | 'resolve' | 'dirname' | 'extname'>;

export interface BundleFs {
  readonly path: BundlePathApi;
  exists(p: string): Promise<boolean>;
  /** A bounded read where the backend supports one (MachineFs truncates at `maxBytes`). */
  readFile(p: string, maxBytes?: number): Promise<string>;
  /** `mode` omitted = the backend default (local: node's default; host: {@link BUNDLE_FILE_MODE}). */
  writeFile(p: string, data: string, mode?: number): Promise<void>;
  mkdirp(p: string): Promise<void>;
  /** Entry names (not paths). Rejects when the directory is missing. */
  readdir(p: string): Promise<string[]>;
  unlink(p: string): Promise<void>;
}

/** What a generated bundle file gets on an environment: what node's default (0o666) yields under umask 022. */
export const BUNDLE_FILE_MODE = 0o644;

/** BundleFs over one ExecutionHost's MachineFs (every call stamped with `hostId`). */
export function hostBundleFs(fs: MachineFs, hostId: string): BundleFs {
  const hp = (p: string): { hostId: string; path: string } => ({ hostId, path: p });
  return {
    path: path.posix,
    exists: (p) => fs.exists(hp(p)),
    readFile: (p, maxBytes) => fs.readFile(hp(p), maxBytes),
    writeFile: (p, data, mode) => fs.writeFile(hp(p), data, mode ?? BUNDLE_FILE_MODE),
    mkdirp: (p) => fs.mkdirp(hp(p)),
    readdir: (p) => fs.readdir(hp(p)),
    unlink: (p) => fs.unlink(hp(p)),
  };
}
