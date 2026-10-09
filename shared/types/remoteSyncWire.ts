/**
 * Cross-machine backlog sync — the cyboflow-sync service's wire contract,
 * protocol 1, as the desktop consumes it.
 *
 * The desktop depends on the service CONTRACT, never on the server's code: this
 * is the desktop's own copy of the request/response shapes. Within a protocol
 * version the service only adds fields, so unknown members must be tolerated
 * (and preserved where the engine stores values). Pure types + constants: this
 * module is shared by main and the renderer and must stay Electron-free.
 */

/** Request header every `/v1` call (accounts paths included) carries. */
export const SYNC_PROTOCOL_HEADER = 'Cyboflow-Sync-Protocol';
/** Response header carrying the workspace epoch. */
export const SYNC_EPOCH_HEADER = 'Cyboflow-Epoch';

/** Service limits the client must respect when building requests. */
export const SYNC_LIMITS = {
  maxOpsPerPush: 200,
  maxPushBytes: 1_048_576,
  maxPullLimit: 500,
  maxEntityFieldsBytes: 262_144,
  maxEntityFields: 1_000,
  maxConflictPayloadBytes: 524_288,
  maxResponseBytes: 4_194_304,
  maxTombstonesPerDevicePerHour: 500,
  maxClockSkewMs: 120_000,
  /** Fingerprints are 1..128 chars; longer canonical forms are sent hashed. */
  maxFingerprintLength: 128,
} as const;

/** The only values the server interprets. */
export const SYNC_REFERENCE_FIELDS = ['parent_epic_id', 'originating_idea_id', 'depends_on'] as const;

export type FieldClock = { v: number; hlc: string; seq: number };

export type PushField = {
  value: unknown;
  /** Field version this device last agreed with (0 = never). */
  baseV: number;
  /** When the local edit happened: "<ms13>:<ctr5>:<deviceId>". */
  hlc: string;
};

export type PushOp = {
  entityType: string;
  entityId: string;
  kind: 'upsert' | 'tombstone';
  /** Tombstone only: the entity version this device last saw. */
  baseVersion?: number;
  /** Create only. */
  ref?: string;
  fields?: Record<string, PushField>;
};

export type PushRequest = { batchId: string; ops: PushOp[] };

export type FieldResult = 'accepted' | 'lost' | 'cleared' | 'noop';
export type OpStatus = 'applied' | 'noop' | 'deleted';
export type OpError = 'ref_conflict' | 'wrong_project' | 'type_mismatch' | 'entity_too_large' | (string & {});

export type EntityState = {
  entityType: string;
  ref: string | null;
  version: number;
  deleted: boolean;
  fields: Record<string, unknown>;
  clocks: Record<string, FieldClock>;
};

export type OpResult = {
  entityId: string;
  status: OpStatus;
  error?: OpError;
  fields: Record<string, FieldResult>;
  conflictIds: string[];
  /** Null when the entity does not exist on the server, or when `entityOmitted`. */
  entity: EntityState | null;
  /** Left out to bound the response; the next pull delivers it. Never means "does not exist". */
  entityOmitted?: true;
};

export type PushResponse = {
  now: number;
  maxSeq: number;
  results: OpResult[];
  conflicts: ConflictRecord[];
  truncated?: true;
};

export type FeedItem = {
  entityId: string;
  entityType: string;
  ref: string | null;
  deleted: boolean;
  seq: number;
  version: number;
  /** The FULL clock map ({} for a tombstone). */
  clocks: Record<string, FieldClock>;
  /** Changed fields only (all fields mid paging run; {} for a tombstone). */
  fields: Record<string, unknown>;
};

export type FeedPage = {
  now: number;
  maxSeq: number;
  nextSince: number;
  hasMore: boolean;
  items: FeedItem[];
  conflicts: ConflictRecord[];
};

export type ConflictKind = 'field' | 'delete_vs_edit' | 'dependency_edge' | 'orphaned' | (string & {});

export type ConflictSide = { value: unknown; device: string | null; hlc: string | null };

export type ConflictRecord = {
  id: string;
  projectId: string;
  entityId: string;
  entityRef: string | null;
  entityTitle: unknown;
  kind: ConflictKind;
  field?: string;
  current: ConflictSide;
  other: ConflictSide;
  extra?: unknown;
  createdAt: number;
  resolvedAt?: number;
  resolvedByDevice?: string | null;
  resolution?: string;
  /** Retention stripped the values; the resolution still stands. */
  valuesPruned?: true;
  seq: number;
};

export type FileConflictRequest = {
  id: string;
  kind: ConflictKind;
  entityId: string;
  payload: {
    entityRef?: string | null;
    entityTitle?: unknown;
    field?: string;
    current: ConflictSide;
    other: ConflictSide;
    extra?: unknown;
  };
};

export type RemoteProject = {
  id: string;
  name: string;
  fingerprint: string;
  createdByDevice: string;
  createdAt: number;
};

export type TrackerClaim = { key: string; deviceId: string; label: string; claimedAt: number };

export type TrackerClaimResponse = {
  key: string;
  state: 'free' | 'held_by_you' | 'held_by_other';
  holder: TrackerClaim | null;
};

export type HeadResponse = {
  now: number;
  projects: Record<string, number>;
  claims: TrackerClaim[];
};

export type ChecksumResponse =
  | { status: 'stale'; maxSeq: number }
  | { status: 'match' | 'mismatch'; maxSeq: number; serverHash: string };

/** Every non-2xx response body. */
export type SyncErrorBody = { error: string; message?: string; details?: unknown };
