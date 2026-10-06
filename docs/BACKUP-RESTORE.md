# Database backup & restore

cyboflow keeps daily snapshots of `sessions.db` so a corrupted live database is
never total loss. This document is the recovery procedure — **read it before
copying a backup over `sessions.db`, because that alone is not a complete
restore.**

## Where things live

Everything sits beside the live database, in the cyboflow data directory
(`~/.cyboflow`, or `~/.cyboflow_dev` for a dev build):

```
sessions.db                                  the live database
backups/
  sessions-2026-08-28.db                     daily snapshot, 7-day retention
  sessions-2026-08-27.db
  ...
  raw-events/
    CURRENT                                  which lineage is being appended to
    lineage-0001/
      raw-events-1-51234.db                  immutable shards of raw_events
      raw-events-51235-93011.db
      ...
```

## Why a backup is two files, not one

`raw_events` is roughly 80% of `sessions.db`. Copying it into all seven retained
dailies is what made the backups directory an order of magnitude larger than the
database it protects. It is also **not** disposable data: `raw_events` is the
source of truth for reconstructed chat history (no separate messages table
exists), the context-usage view, the run inspector, and Insights.

So it is stored **once**. The table is append-only with an `AUTOINCREMENT` id, so
each daily pass appends the rows above the previous high-water mark to a new
immutable shard, and the daily snapshot carries none of them. Fidelity is
unchanged — but a daily backup on its own has an **empty `raw_events` table**.

> **The trap:** copying `sessions-2026-08-28.db` over `sessions.db` produces an
> app that starts perfectly and shows **zero conversation history**. Use the
> restore command below instead.

Stripped backups are self-identifying: they carry a `raw_events_archive` table
naming the lineage and watermark they were cut at. If that table is present, the
backup needs a restore.

## Restoring

With the app **closed**:

```bash
pnpm restore-backup ~/.cyboflow/backups/sessions-2026-08-28.db
```

This never modifies the backup — it writes `sessions-2026-08-28.restored.db`
beside it. Check the summary it prints, then move that file into place as
`sessions.db`.

Options:

- `--deltas <dir>` — the shard store, if it is not the `raw-events` directory
  beside the backup.
- `--out <path>` — where to write the restored database.

It requires a built main process (`pnpm build:main`). If it fails on
`NODE_MODULE_VERSION`, run `node scripts/ensure-sqlite-abi.mjs host` — see
`docs/ARCHITECTURE.md` → "The better-sqlite3 ABI ping-pong".

The restore **validates the archive before it writes anything** and refuses on a
missing, corrupt, or short shard set, leaving no output file. A refusal is
deliberate: a partial restore looks like a recovered database and simply reads as
though history ended early, which is far worse than a clear failure.

## Lineages

A restore rewinds the id space: the recovered database starts issuing ids the
archive already holds rows for, from the timeline that was just discarded. If the
archive kept appending across that boundary, the post-restore events would be
stripped from later backups and the discarded rows replayed in their place.

So the store is partitioned. Every pass checks whether the database it is
archiving is still a continuation of `CURRENT` — primarily via the
`raw_events_archive` marker a recovered database carries with it. When it is not,
a fresh `lineage-NNNN` is minted and archiving restarts from id 1. **Old lineages
are never appended to and never deleted**, because backups taken against them
still need them. Each backup names its own lineage, so a restore can never reach
into a sibling timeline.

Seeing more than one lineage directory is normal after a recovery. Deleting one
permanently destroys the history of every backup that points at it.

## Retention

The seven-day window applies **only** to the `sessions-*.db` dailies, which are
redundant with each other. Shards are exempt — they are the only copy of that
history outside the live database, so pruning them would lose it outright.

The archive therefore grows at the rate `raw_events` grows, in one copy rather
than seven. If it ever needs bounding, that is a retention policy on the live
table (which would shrink the live database too), not a change to the shard
store.

## Failure behaviour

The daily pass fails **closed**. If archiving, integrity validation, or
compaction fails for any reason, the half-processed file is discarded and a plain
**unprocessed full copy** is published in its place, logged as `UNPROCESSED full
daily backup`. An oversized backup is a complete backup; a silently-wrong one is
not. Those backups need no restore step — they carry their own rows, and the
restore command will tell you so and do nothing.
