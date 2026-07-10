/**
 * createProject persists the detected main branch.
 *
 * Regression guard for the bug where ipc/project.ts detected a project's main
 * branch but never threaded it into createProject, leaving projects.main_branch
 * NULL. The column is written at create time from the on-disk repo (runtime
 * still re-detects live via getProjectMainBranch).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

describe('createProject main_branch persistence', () => {
  let tmpDbDir: string;

  afterEach(() => {
    if (tmpDbDir) rmSync(tmpDbDir, { recursive: true, force: true });
  });

  function newService(): DatabaseService {
    tmpDbDir = mkdtempSync(join(tmpdir(), 'cyboflow-mainbranch-'));
    const svc = new DatabaseService(join(tmpDbDir, 'test.db'));
    svc.setMigrationsDirForTesting(join(__dirname, '..', 'migrations'));
    svc.initialize();
    return svc;
  }

  function readMainBranch(svc: DatabaseService, id: number): string | null {
    return (
      svc.getDb().prepare('SELECT main_branch FROM projects WHERE id = ?').get(id) as {
        main_branch: string | null;
      }
    ).main_branch;
  }

  it('persists the mainBranch argument into the main_branch column', () => {
    const svc = newService();
    const project = svc.createProject(
      'Proj',
      join(tmpDbDir, 'repo'),
      undefined, // systemPrompt
      undefined, // runScript
      undefined, // buildScript
      undefined, // defaultPermissionMode
      undefined, // openIdeCommand
      undefined, // commitMode
      undefined, // commitStructuredPromptTemplate
      undefined, // commitCheckpointPrefix
      'develop', // mainBranch
    );
    expect(readMainBranch(svc, project.id)).toBe('develop');
  });

  it('leaves main_branch NULL when no branch is passed', () => {
    const svc = newService();
    const project = svc.createProject('Proj', join(tmpDbDir, 'repo'));
    expect(readMainBranch(svc, project.id)).toBeNull();
  });
});
