/**
 * databaseBackupSnapshot — the heavy half of a daily backup, factored out so it
 * can run OFF the Electron main thread (see databaseBackupWorker.ts).
 *
 * WHAT IT DOES. Given a freshly-written full snapshot of `sessions.db`, it:
 *   1. decides whether that database is still a continuation of the archive's
 *      current lineage, minting a fresh lineage when it is not,
 *   2. archives the `raw_events` rows the lineage has not seen yet into a new
 *      immutable shard,
 *   3. stamps the backup with the lineage and watermark a restore will need,
 *   4. empties `raw_events` and VACUUMs the snapshot down to size.
 *
 * WHY A DELTA STORE AND NOT PLAIN EXCLUSION. `raw_events` is ~80% of the
 * database, so copying it into all seven retained daily backups is where the
 * backups directory's bulk comes from. But it is NOT disposable: the `messages`
 * table is empty by design and `raw_events` is the SOURCE OF TRUTH for
 * reconstructed chat history (see orchestrator/runUnifiedMessagesListing.ts),
 * plus the context-usage view, the run inspector, and Insights all read it. Dropping it
 * from backups would mean a restore that keeps your runs and silently loses
 * every conversation in them.
 *
 * The table is append-only with an AUTOINCREMENT id, so the fix is to store it
 * ONCE rather than seven times. See databaseBackupArchive.ts for why that store
 * is partitioned into lineages and validated on every pass, and
 * databaseBackupRestore.ts for the replay.
 *
 * FAILS CLOSED. Every error here propagates: the service responds by discarding
 * the half-processed partial and publishing a plain full copy instead. An
 * oversized backup is a complete backup; a silently-wrong one is not.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  DELTA_ARCHIVED_TABLE,
  listShards,
  mintLineage,
  probeShardWith,
  readArchiveMarker,
  readCurrentLineage,
  shardFileName,
  validateShards,
  writeArchiveMarker,
  writeCurrentLineage,
  type ArchiveMarker,
  type ShardRef,
} from './databaseBackupArchive';

export { DELTA_ARCHIVED_TABLE };

/** Records the restore that caused a lineage to be minted, so it fires once. */
const LINEAGE_ORIGIN_FILE = 'ORIGIN';

export interface ProcessSnapshotOptions {
  /** Path to the full snapshot to process IN PLACE. */
  snapshotPath: string;
  /** Directory holding the lineage-partitioned shard store. Created as needed. */
  deltaDir: string;
}

export interface ProcessSnapshotResult {
  /** Lineage this backup belongs to. */
  lineage: string;
  /** True when a rewound id space forced a fresh lineage on this pass. */
  lineageMinted: boolean;
  /** Absolute path of the shard written, or null when there was nothing new. */
  shardPath: string | null;
  /** How many rows the shard captured. */
  archivedRows: number;
  /** How many rows were then emptied out of the snapshot. */
  strippedRows: number;
  /** The id cut-off stamped into the backup for restore. */
  watermark: number;
  /** Bytes the snapshot shrank by. */
  bytesReclaimed: number;
}

const probeShard = probeShardWith((p) => new Database(p, { readonly: true, fileMustExist: true }));

/** The marker whose restore a lineage was minted for, if it was minted for one. */
function readLineageOrigin(deltaDir: string, lineage: string): ArchiveMarker | null {
  try {
    const raw = fs.readFileSync(path.join(deltaDir, lineage, LINEAGE_ORIGIN_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { lineage: from, watermark } = parsed as Partial<ArchiveMarker>;
    return typeof from === 'string' && typeof watermark === 'number' ? { lineage: from, watermark } : null;
  } catch {
    return null;
  }
}

function writeLineageOrigin(deltaDir: string, lineage: string, origin: ArchiveMarker): void {
  fs.writeFileSync(path.join(deltaDir, lineage, LINEAGE_ORIGIN_FILE), JSON.stringify(origin), 'utf8');
}

/**
 * Has the database being archived stopped being a continuation of `lineage`?
 *
 * The DEFINITIVE signal is the archive marker. A stripped backup carries one,
 * so any database recovered from a backup — whether through restoreRawEvents or
 * a bare file copy — arrives holding the lineage and watermark it was cut at.
 * If that disagrees with where the archive has since got to, the id space has
 * rewound. `ORIGIN` records the marker a lineage was minted for so the same
 * restore cannot mint a second, third, fourth lineage on later ticks: the live
 * database keeps its marker forever (nothing here ever writes to it), so
 * without that record the signal would re-fire every day.
 *
 * With no marker (a database that has never been restored) it falls back to
 * evidence: an id space that moved BACKWARDS, or a row the archive and the
 * database disagree about. Where neither can be evaluated it answers "diverged"
 * — a needless lineage costs one re-archive, while a missed one loses history.
 */
function hasDiverged(
  db: Database.Database,
  deltaDir: string,
  lineage: string,
  shards: ShardRef[],
  liveMax: number,
  archiveMax: number,
): { diverged: boolean; cause: ArchiveMarker | null; reason: string } {
  if (archiveMax === 0) return { diverged: false, cause: null, reason: 'empty archive' };

  const marker = readArchiveMarker(db);
  if (marker !== null) {
    const origin = readLineageOrigin(deltaDir, lineage);
    const alreadyAccountedFor =
      origin !== null && origin.lineage === marker.lineage && origin.watermark === marker.watermark;
    if (!alreadyAccountedFor && (marker.lineage !== lineage || marker.watermark < archiveMax)) {
      return {
        diverged: true,
        cause: marker,
        reason: `restored from ${marker.lineage}@${marker.watermark} while ${lineage} covers ${archiveMax}`,
      };
    }
    return { diverged: false, cause: null, reason: 'marker agrees with the archive' };
  }

  if (liveMax < archiveMax) {
    return { diverged: true, cause: null, reason: `id space rewound: live max ${liveMax} < archived ${archiveMax}` };
  }

  const row = db
    .prepare(`SELECT id, run_id, event_type, payload_json FROM ${DELTA_ARCHIVED_TABLE} WHERE id <= ? ORDER BY id DESC LIMIT 1`)
    .get(archiveMax) as { id: number; run_id: string; event_type: string; payload_json: string } | undefined;
  if (row === undefined) {
    return { diverged: true, cause: null, reason: `no live row at or below ${archiveMax} to corroborate the archive` };
  }

  const shard = shards.find((s) => row.id >= s.lo && row.id <= s.hi);
  if (shard === undefined) {
    return { diverged: true, cause: null, reason: `no shard covers id ${row.id}` };
  }

  const shardDb = new Database(shard.path, { readonly: true, fileMustExist: true });
  try {
    const archived = shardDb
      .prepare(`SELECT run_id, event_type, payload_json FROM ${DELTA_ARCHIVED_TABLE} WHERE id = ?`)
      .get(row.id) as { run_id: string; event_type: string; payload_json: string } | undefined;
    if (archived === undefined) {
      return { diverged: true, cause: null, reason: `id ${row.id} is missing from ${shard.file}` };
    }
    if (
      archived.run_id !== row.run_id ||
      archived.event_type !== row.event_type ||
      archived.payload_json !== row.payload_json
    ) {
      return { diverged: true, cause: null, reason: `id ${row.id} differs between the database and ${shard.file}` };
    }
  } finally {
    shardDb.close();
  }

  return { diverged: false, cause: null, reason: 'archive corroborated' };
}

/** Column list of `table` as `"name" type` pairs, straight from the snapshot. */
function columnDefinitions(db: Database.Database, table: string): string {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];
  // Types are carried over but constraints deliberately are NOT: a shard is an
  // archive fragment, so its rows must not be rejected by a foreign key to a
  // workflow_runs table the shard does not contain.
  return columns.map((c) => `"${c.name}" ${c.type === '' ? 'BLOB' : c.type}`).join(', ');
}

/**
 * Archive-then-strip one snapshot. Throws on any failure — the caller decides
 * what to publish, because a half-processed snapshot must never be passed off
 * as a complete backup.
 */
export function processSnapshot(options: ProcessSnapshotOptions): ProcessSnapshotResult {
  const { snapshotPath, deltaDir } = options;
  const sizeBefore = fs.statSync(snapshotPath).size;
  const db = new Database(snapshotPath);

  try {
    const present = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(DELTA_ARCHIVED_TABLE);
    // A snapshot without the table (a much older schema) is left exactly as it
    // is: there is nothing to archive and nothing to reclaim.
    if (present === undefined) {
      return {
        lineage: '',
        lineageMinted: false,
        shardPath: null,
        archivedRows: 0,
        strippedRows: 0,
        watermark: 0,
        bytesReclaimed: 0,
      };
    }

    const maxRow = db.prepare(`SELECT MAX(id) AS maxId FROM ${DELTA_ARCHIVED_TABLE}`).get() as {
      maxId: number | null;
    };
    const liveMax = maxRow.maxId ?? 0;

    fs.mkdirSync(deltaDir, { recursive: true });
    let lineage = readCurrentLineage(deltaDir);
    let lineageMinted = false;
    if (lineage === null) {
      lineage = mintLineage(deltaDir);
      lineageMinted = true;
    } else {
      // The directory may name a lineage whose folder was removed by hand.
      writeCurrentLineage(deltaDir, lineage);
    }

    let shards = listShards(deltaDir, lineage);
    const integrity = validateShards(shards, probeShard);
    if (!integrity.ok) {
      // Fail closed. Continuing would extend a cover that has a hole in it,
      // permanently stripping the missing ids from every future backup while
      // archiving them nowhere.
      throw new Error(`raw_events archive ${lineage} failed integrity check: ${integrity.reason}`);
    }
    let archiveMax = integrity.coveredThrough;

    const divergence = hasDiverged(db, deltaDir, lineage, shards, liveMax, archiveMax);
    if (divergence.diverged) {
      const previous = lineage;
      lineage = mintLineage(deltaDir);
      lineageMinted = true;
      if (divergence.cause !== null) writeLineageOrigin(deltaDir, lineage, divergence.cause);
      shards = [];
      archiveMax = 0;
      // Not an error: this is the archive correctly refusing to blend two
      // timelines. `previous` is retained untouched — backups still point at it.
      void previous;
    }

    let shardPath: string | null = null;
    let archivedRows = 0;
    if (liveMax > archiveMax) {
      const lo = archiveMax + 1;
      const finalPath = path.join(deltaDir, lineage, shardFileName(lo, liveMax));
      const partialPath = `${finalPath}.partial`;
      // A leftover from a crashed run is dead by definition — only one tick
      // runs at a time and the app holds a single-instance lock.
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);

      db.exec(`ATTACH DATABASE '${partialPath.replace(/'/g, "''")}' AS shard`);
      try {
        db.exec(`CREATE TABLE shard.${DELTA_ARCHIVED_TABLE} (${columnDefinitions(db, DELTA_ARCHIVED_TABLE)})`);
        const copied = db
          .prepare(
            `INSERT INTO shard.${DELTA_ARCHIVED_TABLE} SELECT * FROM main.${DELTA_ARCHIVED_TABLE} WHERE id > ?`,
          )
          .run(archiveMax);
        archivedRows = copied.changes;
      } finally {
        db.exec('DETACH DATABASE shard');
      }

      // Publish the shard BEFORE touching the snapshot. Until this rename
      // lands nothing has been promised and a crash simply redoes the work;
      // after it, the rows are safe on disk and stripping them is sound.
      fs.renameSync(partialPath, finalPath);
      shardPath = finalPath;
    }

    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM ${DELTA_ARCHIVED_TABLE}`).get() as { n: number };
    const strippedRows = remaining.n;

    // The watermark is the highest id ACTUALLY ARCHIVED, not sqlite_sequence's
    // high-water mark. They differ when the top rows were deleted before this
    // pass, and cutting a restore at the larger number would let it pull rows
    // from a LATER shard — events that did not exist when this backup was
    // taken, grafted onto it.
    writeArchiveMarker(db, { lineage, watermark: liveMax });

    // sqlite_sequence still has to be preserved for its own reason: a restored
    // database must not re-issue ids the live one already handed out. It is an
    // internal table with NO unique index on `name`, so INSERT OR REPLACE
    // cannot replace anything — it just appends a second row and makes the
    // value ambiguous. Delete-then-insert leaves exactly one.
    const hasSequence =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get() !==
      undefined;
    const sequence = hasSequence
      ? (db.prepare('SELECT MAX(seq) AS seq FROM sqlite_sequence WHERE name = ?').get(DELTA_ARCHIVED_TABLE) as
          | { seq: number | null }
          | undefined)
      : undefined;

    db.exec(`DELETE FROM ${DELTA_ARCHIVED_TABLE}`);
    if (sequence?.seq != null) {
      db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(DELTA_ARCHIVED_TABLE);
      db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(DELTA_ARCHIVED_TABLE, sequence.seq);
    }

    // Deleting rows only moves their pages onto the freelist; the file stays
    // full size until VACUUM rewrites it, and shrinking it is the entire point.
    db.exec('VACUUM');

    return {
      lineage,
      lineageMinted,
      shardPath,
      archivedRows,
      strippedRows,
      watermark: liveMax,
      bytesReclaimed: sizeBefore - fs.statSync(snapshotPath).size,
    };
  } finally {
    db.close();
  }
}
