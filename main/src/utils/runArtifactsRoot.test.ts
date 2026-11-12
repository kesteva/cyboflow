import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { localRunArtifactsRoot } from './runArtifactsRoot';

describe('localRunArtifactsRoot', () => {
  it('creates the parent of the local run artifacts root and resolves it through symlinks', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cf-artifacts-')));
    try {
      const dataDir = path.join(tmp, 'data');
      fs.mkdirSync(dataDir);
      fs.symlinkSync(dataDir, path.join(tmp, 'link'));
      const root = localRunArtifactsRoot(path.join(tmp, 'link', 'artifacts', 'runs'), 'run-1');
      // The parent exists (the agent's `mkdir -p` only has to create the root itself), under its REAL path.
      expect(root).toBe(path.join(dataDir, 'artifacts', 'runs', 'run-1'));
      expect(fs.statSync(path.join(dataDir, 'artifacts', 'runs')).isDirectory()).toBe(true);
      expect(fs.existsSync(root)).toBe(false);
      // Fail-soft: a parent that cannot be created yields the plain path.
      fs.writeFileSync(path.join(tmp, 'file'), '');
      expect(localRunArtifactsRoot(path.join(tmp, 'file', 'runs'), 'run-2')).toBe(path.join(tmp, 'file', 'runs', 'run-2'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
