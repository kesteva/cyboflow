/**
 * runDigestReader — what a run actually PRODUCED, for the supervisor's prompts
 * (CR-6 of the adversarial-review-convergence plan).
 *
 * The monitor's history digest answers "what happened": a step timeline, the
 * lanes, the last dozen chat turns. None of that says what the run made. A
 * supervisor asked to recommend a verdict at an approve-design gate was
 * therefore reasoning about a list of step names — it could see that
 * `adversarial-review` ran and not one word of what it said.
 *
 * This module reads the two durable places that content lives:
 *
 *   - ARTIFACTS, restricted to the payload-carrying atypes. The templated
 *     deliverables (`idea-spec`, `decomposed-stories`, `arch-design`,
 *     `approve-ideas`, `approve-designs`) carry NO markdown of their own — they
 *     are re-derived views over the entities — so including them would add rows
 *     of empty payloads. The allow-list is the set whose `payload_json.markdown`
 *     is the artifact.
 *   - ENTITIES the run owns: its ideas (seeded + created — `listRunOwnedIdeaIds`)
 *     and the epics / tasks it created. That IS the content the templated tabs
 *     re-derive, so reading the entities covers them without a second shape.
 *
 * FAIL-SOFT, absolutely: a digest is an enrichment. A missing table, a legacy
 * schema, a corrupt payload or any thrown query yields an EMPTY digest, never a
 * throw — a broken read must degrade the prompt, never a run parked at a gate.
 *
 * Standalone-typecheck invariant: no imports from 'electron' or 'better-sqlite3'
 * — the DB is reached only through the narrow `DatabaseLike` surface.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { RunDigest } from './programmatic/types';
import {
  listRunCreatedEpicIds,
  listRunCreatedTaskIds,
  listRunOwnedIdeaIds,
} from './runEntityOwnership';

/**
 * The artifact types whose `payload_json` carries a `markdown` string.
 *
 * A closed allow-list rather than "anything with a markdown key": a new artifact
 * type should have to be considered before its bytes start riding every
 * supervisor prompt in the app, and an artifact whose payload happens to carry a
 * `markdown` field for some other purpose is not a deliverable.
 */
export const RUN_DIGEST_ARTIFACT_ATYPES: readonly string[] = [
  'adversarial-review',
  'project-brief',
  'verify-runbook',
  'compound-recommendations',
  'eval-report',
];

/** Longest single artifact / entity body folded into a digest, in characters. */
export const RUN_DIGEST_ITEM_MAX_CHARS = 12_000;

/**
 * Longest whole digest, in characters. Sized so a digest can never dominate the
 * prompt it enriches: the step timeline, the lanes and the conversation still
 * have to fit, and a run with a dozen tasks would otherwise crowd them out.
 */
export const RUN_DIGEST_TOTAL_MAX_CHARS = 60_000;

/** The marker a truncated body ends with, so the reader knows text was dropped. */
export const RUN_DIGEST_TRUNCATION_MARKER = '… [truncated]';

/**
 * Trim `text` to `limit`, announcing the cut rather than making it silently.
 *
 * A supervisor that cannot tell a short document from a truncated one would
 * reason about "the review raised three entries" when it was handed the first
 * three of eleven — so the marker is load-bearing, not decoration.
 */
function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // The marker (and the newline before it) counts against the limit: a cut that
  // then appended the marker would hand back MORE than the cap it was asked to
  // enforce, and the total budget below would overrun by one marker per item.
  const room = Math.max(0, limit - RUN_DIGEST_TRUNCATION_MARKER.length - 1);
  return `${text.slice(0, room)}\n${RUN_DIGEST_TRUNCATION_MARKER}`;
}

/** A markdown payload's `markdown` string, or undefined for anything else. */
function payloadMarkdown(payloadJson: unknown): string | undefined {
  if (typeof payloadJson !== 'string' || payloadJson.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const markdown = (parsed as { markdown?: unknown }).markdown;
    return typeof markdown === 'string' && markdown.trim().length > 0 ? markdown.trim() : undefined;
  } catch {
    return undefined;
  }
}

interface ArtifactRow {
  atype?: unknown;
  label?: unknown;
  payloadJson?: unknown;
}

interface EntityRow {
  ref?: unknown;
  title?: unknown;
  body?: unknown;
}

/** A string column that is actually a non-empty string, else ''. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * The run's payload-carrying artifacts, oldest-first (the order they were
 * produced, which is the order the supervisor should read them in).
 *
 * Generalizes `adversarialReviewGateBody.readAdversarialReviewMarkdown` from one
 * atype to the allow-list, with the same fail-soft posture.
 */
function readArtifacts(db: DatabaseLike, runId: string): RunDigest['artifacts'] {
  try {
    const placeholders = RUN_DIGEST_ARTIFACT_ATYPES.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT atype, label, payload_json AS payloadJson
           FROM artifacts
          WHERE run_id = ? AND atype IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
      )
      .all(runId, ...RUN_DIGEST_ARTIFACT_ATYPES) as ArtifactRow[];
    const out: RunDigest['artifacts'] = [];
    for (const row of rows) {
      const markdown = payloadMarkdown(row.payloadJson);
      if (markdown === undefined) continue;
      const atype = str(row.atype);
      out.push({ atype, label: str(row.label) || atype, markdown });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Read ref / title / body for a set of entity ids from ONE backlog table.
 *
 * `table` is never caller-controlled text — it comes from the three literals
 * below — and the ids are bound parameters, so the interpolation is structural
 * only. Fail-soft: a legacy schema missing the table yields [].
 */
function readEntities(
  db: DatabaseLike,
  kind: 'idea' | 'epic' | 'task',
  ids: string[],
): RunDigest['entities'] {
  if (ids.length === 0) return [];
  const table = kind === 'idea' ? 'ideas' : kind === 'epic' ? 'epics' : 'tasks';
  try {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT ref, title, body FROM ${table}
          WHERE id IN (${placeholders})
          ORDER BY created_at ASC, ref ASC`,
      )
      .all(...ids) as EntityRow[];
    return rows.map((row) => ({
      kind,
      ref: str(row.ref),
      title: str(row.title),
      body: str(row.body),
    }));
  } catch {
    return [];
  }
}

/**
 * Read this run's deliverables + owned entities, capped.
 *
 * The caps are applied in READ order — artifacts first, then ideas, epics and
 * tasks — so what survives a budget squeeze is the run's own output rather than
 * whichever rows happen to sort last. Once the total budget is spent the
 * remaining items are dropped entirely rather than folded in as empty shells,
 * because an entity whose body is gone reads like an entity with no body.
 *
 * Never throws: every read below is individually fail-soft, and the whole thing
 * is wrapped so an unexpected shape yields an empty digest.
 */
export function readRunDigest(db: DatabaseLike, runId: string, logger?: LoggerLike): RunDigest {
  try {
    const digest: RunDigest = { artifacts: [], entities: [] };
    let budget = RUN_DIGEST_TOTAL_MAX_CHARS;

    for (const artifact of readArtifacts(db, runId)) {
      if (budget <= 0) break;
      const markdown = cap(artifact.markdown, Math.min(RUN_DIGEST_ITEM_MAX_CHARS, budget));
      budget -= markdown.length;
      digest.artifacts.push({ ...artifact, markdown });
    }

    const entities = [
      ...readEntities(db, 'idea', listRunOwnedIdeaIds(db, runId)),
      ...readEntities(db, 'epic', listRunCreatedEpicIds(db, runId)),
      ...readEntities(db, 'task', listRunCreatedTaskIds(db, runId)),
    ];
    for (const entity of entities) {
      if (budget <= 0) break;
      const body = cap(entity.body, Math.min(RUN_DIGEST_ITEM_MAX_CHARS, budget));
      budget -= body.length;
      digest.entities.push({ ...entity, body });
    }

    return digest;
  } catch (err) {
    logger?.warn('[runDigestReader] run digest read failed (fail-soft)', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { artifacts: [], entities: [] };
  }
}
