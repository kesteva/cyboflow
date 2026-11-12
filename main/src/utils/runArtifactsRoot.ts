/**
 * This Mac's run artifacts folder (`<runsDir>/<runId>`) as a sandbox writable root (Codex `workspace-write`).
 *
 * The root itself need not exist, but its PARENTS are outside it: on a data dir with no `artifacts/runs` yet the
 * agent's `mkdir -p` would be denied. So the parent is created here (once, never removed) and resolved, so a
 * symlinked data dir still matches the sandbox's real path. Fail-soft: an uncreatable parent yields the plain path.
 *
 * App data-dir housekeeping, always on This Mac — a remote spawn creates its folder through the environment's fs.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export function localRunArtifactsRoot(runsDir: string, runId: string): string {
  try {
    mkdirSync(runsDir, { recursive: true });
    return join(realpathSync(runsDir), runId);
  } catch {
    return join(runsDir, runId);
  }
}
