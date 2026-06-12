/**
 * Demo-mode environment (config.demoMode).
 *
 * Demo mode is a BOOT PROFILE, not a runtime overlay: when `config.demoMode`
 * is true, initializeServices() points the app at a throwaway demo database
 * and this module materializes a sandbox git repository the user "adds" as a
 * project during the tour. Everything downstream (sessions, worktrees, diffs,
 * merge, push) runs the REAL code paths against the sandbox — the only faked
 * piece is the agent substrate (DemoCliManager). Nothing here ever touches the
 * user's real database or repositories.
 *
 * Layout under ~/.cyboflow/demo/ (wiped on every demo boot so each tour is
 * fresh):
 *   demo.db        — the demo SQLite database (same schema/migrations)
 *   demo-project/  — the sandbox repo the user adds as a project
 *   remote.git     — a local bare repo standing in for GitHub
 *
 * The sandbox's `origin` fetch URL is a github.com-looking URL (so the
 * Create-PR dialog builds a believable compare link) while its PUSH url points
 * at the local bare repo (so `git push` genuinely succeeds offline). The
 * openExternal handler suppresses opening the fake URL in demo mode.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getCyboflowSubdirectory } from '../../utils/cyboflowDirectory';

/** Fetch URL stamped on the sandbox's origin — recognizably fake, never pushed to. */
export const DEMO_REMOTE_URL = 'https://github.com/cyboflow/demo-project.git';

/** Project name prefilled in the Create Project dialog during the tour. */
export const DEMO_PROJECT_NAME = 'Acme Habits';

export function getDemoRootDir(): string {
  return getCyboflowSubdirectory('demo');
}

export function getDemoDatabasePath(): string {
  return path.join(getDemoRootDir(), 'demo.db');
}

export function getDemoSandboxPath(): string {
  return path.join(getDemoRootDir(), 'demo-project');
}

export function getDemoBareRemotePath(): string {
  return path.join(getDemoRootDir(), 'remote.git');
}

/** Run a git command in `cwd`, surfacing stderr in the thrown Error. */
function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}

/**
 * Seed source files for the sandbox repo — a tiny TypeScript service so the
 * scripted runs have believable files to read, edit, and diff.
 */
const SEED_FILES: Record<string, string> = {
  'README.md': `# Acme Habits

A tiny habit-tracking service used to demo Cyboflow.

## Structure

- \`src/server.ts\` — HTTP entry point
- \`src/habits.ts\` — in-memory habit store + check-ins
- \`src/format.ts\` — display helpers
`,
  'package.json': `{
  "name": "acme-habits",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "echo \\"ok\\""
  }
}
`,
  'src/server.ts': `import { listHabits, addHabit, checkIn } from './habits';
import { formatHabit } from './format';

export function handleRequest(method: string, path: string, body?: string): string {
  if (method === 'GET') {
    return listHabits().map(formatHabit).join('\\n');
  }
  if (method === 'POST' && path === '/habits' && body) {
    const habit = addHabit(body);
    return formatHabit(habit);
  }
  if (method === 'POST' && path.startsWith('/habits/') && path.endsWith('/check-in')) {
    const id = Number(path.split('/')[2]);
    const habit = checkIn(id);
    return habit ? formatHabit(habit) : 'not found';
  }
  return 'unsupported';
}
`,
  'src/habits.ts': `export interface Habit {
  id: number;
  name: string;
  createdAt: string;
  /** ISO timestamps of completed check-ins, newest last. */
  completions: string[];
}

const habits: Habit[] = [];

export function addHabit(name: string): Habit {
  const habit: Habit = {
    id: habits.length + 1,
    name,
    createdAt: new Date().toISOString(),
    completions: [],
  };
  habits.push(habit);
  return habit;
}

export function checkIn(id: number): Habit | undefined {
  const habit = habits.find((h) => h.id === id);
  habit?.completions.push(new Date().toISOString());
  return habit;
}

export function listHabits(): Habit[] {
  return habits;
}
`,
  'src/format.ts': `import type { Habit } from './habits';

export function formatHabit(habit: Habit): string {
  return '#' + habit.id + ' ' + habit.name;
}
`,
};

export interface DemoEnvironment {
  databasePath: string;
  sandboxPath: string;
  bareRemotePath: string;
}

/**
 * Wipe and re-create the demo environment. Called once per demo boot, BEFORE
 * the DatabaseService is constructed, so every demo session starts from the
 * same clean state (the "no persistence" contract of demo mode).
 *
 * Throws on failure (e.g. git unavailable) — the caller decides the fallback.
 *
 * @param rootOverride test seam — builds the environment under this directory
 *   instead of ~/.cyboflow/demo (which requires a live Electron `app`).
 */
export function resetDemoEnvironment(rootOverride?: string): DemoEnvironment {
  const root = rootOverride ?? getDemoRootDir();
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  // Local bare repo standing in for GitHub — push genuinely succeeds offline.
  const bareRemotePath = path.join(root, 'remote.git');
  fs.mkdirSync(bareRemotePath, { recursive: true });
  git(bareRemotePath, 'init --bare --initial-branch=main');

  // Sandbox repo with seed files + initial commit on main.
  const sandboxPath = path.join(root, 'demo-project');
  fs.mkdirSync(sandboxPath, { recursive: true });
  git(sandboxPath, 'init --initial-branch=main');
  // Repo-local identity so commits never depend on (or pollute) global config.
  git(sandboxPath, 'config user.name "Cyboflow Demo"');
  git(sandboxPath, 'config user.email "demo@cyboflow.dev"');
  git(sandboxPath, 'config commit.gpgsign false');

  for (const [relPath, content] of Object.entries(SEED_FILES)) {
    const abs = path.join(sandboxPath, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(sandboxPath, 'add -A');
  git(sandboxPath, 'commit -m "Initial commit"');

  // origin: github-looking fetch URL, local-bare PUSH url (see module header).
  git(sandboxPath, `remote add origin ${DEMO_REMOTE_URL}`);
  git(sandboxPath, `remote set-url --push origin ${JSON.stringify(bareRemotePath)}`);
  git(sandboxPath, 'push origin main');

  return {
    databasePath: path.join(root, 'demo.db'),
    sandboxPath,
    bareRemotePath,
  };
}
