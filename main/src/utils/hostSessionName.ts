import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

/**
 * Resolve the human-readable NAME of the cyboflow session that owns a worktree.
 *
 * Dogfooding context: a dev build launched with `pnpm dev` from inside a session
 * worktree can only report that worktree's DIRECTORY name (see
 * `getCurrentWorktreeName`), which is the auto-generated `hidden-comet-20260901`
 * slug even after the human renamed the session to something meaningful. The
 * name lives in the HOSTING instance's database — and that is never the running
 * instance's own: a dev server reads `~/.cyboflow_dev`, while the session was
 * almost always created by the packaged stable app in `~/.cyboflow`. The
 * hosting instance's `CYBOFLOW_SESSION_ID` is not usable either — index.ts
 * strips every per-run cyboflow env var at boot precisely because inherited
 * values are stale.
 *
 * So we look the worktree path up across every sibling cyboflow data directory.
 * Read-only, fail-soft in every arm: any unreadable/locked/foreign-schema
 * database is skipped and the caller falls back to the worktree name.
 */
export interface HostSessionLookupOptions {
  /** Override the home directory scanned for `~/.cyboflow*` data dirs (tests). */
  homeDir?: string;
  /** Override the CYBOFLOW_DIR data-dir pin; pass `undefined` to ignore the env. */
  explicitDir?: string;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Every plausible cyboflow data directory: the explicit CYBOFLOW_DIR pin first,
 * then `~/.cyboflow` and each `~/.cyboflow_*` variant dir (dev, dev_dmg, test,
 * ad-hoc smoke dirs). Deduped, order-preserving.
 */
function candidateDataDirs(homeDir: string, explicitDir?: string): string[] {
  const dirs: string[] = [];
  if (explicitDir) dirs.push(realpathOrSelf(explicitDir));
  try {
    for (const entry of fs.readdirSync(homeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== '.cyboflow' && !entry.name.startsWith('.cyboflow_')) continue;
      dirs.push(path.join(homeDir, entry.name));
    }
  } catch {
    // Unreadable home directory — nothing to scan.
  }
  return Array.from(new Set(dirs));
}

interface SessionNameRow {
  name: string;
  archived: number | null;
}

function lookupInDatabase(dbPath: string, worktreePaths: string[]): SessionNameRow | undefined {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const placeholders = worktreePaths.map(() => '?').join(', ');
    const row = db
      .prepare(
        `SELECT name, archived FROM sessions
          WHERE worktree_path IN (${placeholders})
          ORDER BY COALESCE(archived, 0) ASC, updated_at DESC
          LIMIT 1`
      )
      .get(...worktreePaths) as SessionNameRow | undefined;
    return row;
  } catch {
    // Locked, absent, or a schema this build does not recognise. A cosmetic
    // label is never worth an exception.
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

export function resolveHostSessionName(
  cwd: string,
  options: HostSessionLookupOptions = {}
): string | undefined {
  const homeDir = options.homeDir ?? homedir();
  const explicitDir = 'explicitDir' in options ? options.explicitDir : process.env.CYBOFLOW_DIR;
  const worktreePaths = Array.from(new Set([cwd, realpathOrSelf(cwd)]));

  let archivedFallback: string | undefined;
  for (const dir of candidateDataDirs(homeDir, explicitDir)) {
    const dbPath = path.join(dir, 'sessions.db');
    if (!fs.existsSync(dbPath)) continue;
    const row = lookupInDatabase(dbPath, worktreePaths);
    if (!row || !row.name) continue;
    // A live session outranks an archived row for the same path in another
    // instance's database.
    if (!row.archived) return row.name;
    archivedFallback ??= row.name;
  }
  return archivedFallback;
}
