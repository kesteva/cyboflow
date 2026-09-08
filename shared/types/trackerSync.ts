/**
 * trackerSync — wire shapes for the external issue-tracker sync feature
 * (Settings → Integrations: Linear, Plane, Dart). Design: docs/proposals/
 * tracker-sync-integration.md.
 *
 * These types cross the IPC boundary (wizard/connected-view tRPC surface), so
 * they live here per the IPC type-parity rules. The main-only adapter contract
 * (main/src/services/trackerSync/adapterTypes.ts) builds on these.
 *
 * SECRETS NEVER CROSS OUTBOUND: `TrackerCredentialsInput` flows renderer→main
 * exactly once at connect time; no shape in this file ever carries the stored
 * key back to the renderer.
 */
import type { EntityCategory, Priority } from './tasks';

export type TrackerProvider = 'linear' | 'plane' | 'dart' | 'beads';

/**
 * Does this provider need a stored credential at all? False only for beads
 * (docs/proposals/tracker-beads-provider.md "1. Keyless connect"): its
 * transport is a local `bd` CLI probe of the project's own workspace, not an
 * API key, and its `secret_ciphertext` stays NULL for the connection's whole
 * life.
 *
 * THE single definition, and it lives in shared/ rather than beside the other
 * provider tables in main/src/services/trackerSync/providerCapabilities.ts for
 * one reason: the tRPC router validates the credential shape and may not
 * import main/src/services/* (the standalone-typecheck invariant). A second
 * copy there would be a boolean whose two halves can disagree about whether a
 * keyless connect is legal — which is the guard, not a cosmetic fact.
 */
export const PROVIDER_NEEDS_SECRET: Record<TrackerProvider, boolean> = {
  linear: true,
  plane: true,
  dart: true,
  beads: false,
};

/** Convenience wrapper over {@link PROVIDER_NEEDS_SECRET}. */
export function providerNeedsSecret(provider: TrackerProvider): boolean {
  return PROVIDER_NEEDS_SECRET[provider];
}

/** Renderer→main, connect-time only. */
export interface TrackerCredentialsInput {
  provider: TrackerProvider;
  /**
   * Absent ONLY for a provider {@link providerNeedsSecret} answers false for
   * (beads). Every keyed provider still requires it, enforced at the router's
   * zod schema and again in the service — an absent key must never reach an
   * adapter as an empty string that the remote answers with a 401 the user
   * cannot act on.
   */
  apiKey?: string;
  /** Plane self-hosted instance origin; omitted = the provider's cloud default. */
  baseUrl?: string;
  /** Plane only: the workspace slug all API paths are scoped under. */
  workspaceSlug?: string;
  /**
   * beads only: the cyboflow project whose repo path anchors the `bd`
   * workspace to probe. The renderer sends the ID, never a path — main
   * resolves it (TrackerSyncServiceDeps.resolveProjectPath), so no filesystem
   * path a renderer composed can steer where the CLI is spawned.
   */
  projectId?: number;
  /**
   * beads only, and OPTIONAL: an override for where the workspace is, when it
   * is not at the project's repo path (a monorepo subdirectory, a workspace
   * kept outside the repo entirely).
   *
   * A TOKEN, never a path, for exactly the reason `projectId` is an id: main
   * ran the native folder dialog itself and minted this token against the
   * directory the USER chose, holding the mapping in its own memory. The
   * renderer receives the token, echoes it back, and at no point names a
   * filesystem path that main would spawn a CLI in — so the override widens
   * WHICH directory can be picked without widening WHO gets to pick it.
   *
   * Takes precedence over `projectId` when both are present (the wizard always
   * sends the project id; the token says "not that one").
   */
  workspaceDirToken?: string;
}

/**
 * Wizard probe credential source: exactly one of the two keys.
 *
 * `credentials` is the pasted-key path every pre-mapping-management wizard run
 * takes. `connectionId` is the MANAGEMENT path — "add another mapping to this
 * connection" — where the key already lives encrypted beside the connection and
 * asking the user to paste it again would be a worse question than not asking:
 * main resolves it from the named row, so nothing key-shaped crosses IPC at all.
 */
export interface TrackerWizardSourceInput {
  credentials?: TrackerCredentialsInput;
  connectionId?: string;
}

/** Result of a successful credential validation ("Authorized as …" card). */
export interface TrackerWorkspaceIdentity {
  workspaceId: string;
  workspaceName: string;
  /** Display attribution for the authorizing user, e.g. "J. Kesteva". */
  actorLabel: string;
}

/**
 * WHICH recovery a paused KEYLESS connection needs
 * (docs/proposals/tracker-beads-provider.md, "Replacement recovery is an
 * explicit state machine"). Derived by COMPARING a live expectation-free probe
 * against the row's two identity columns — never by reading an error message,
 * because the same pause reaches the user through several wordings and only the
 * ids can say which of these three shapes it actually is.
 *
 *   'healthy'  — both halves still match. The pause was transient (`bd` lock
 *                contention, a spawn that timed out); a plain resume is enough.
 *   'redetect' — the probe itself failed: no workspace resolves at the stored
 *                path any more (the repo moved, `.beads` is gone, `bd` is not
 *                installed). Re-detect re-anchors it.
 *   'renamed'  — same database instance, DIFFERENT issue prefix: `bd
 *                rename-prefix` rewrote every issue id suffix-preserved, so the
 *                links can be remapped deterministically.
 *   'replaced' — a DIFFERENT database instance at the same path (`rm -rf .beads
 *                && bd init`). Every linked issue belongs to a database that no
 *                longer exists; only "adopt the new workspace" can recover, and
 *                it is destructive enough to need an explicit confirmation.
 */
export type TrackerRecoveryClass = 'healthy' | 'redetect' | 'renamed' | 'replaced';

/** {@link TrackerRecoveryClass} plus the ids the UI needs to explain the verdict. */
export interface TrackerRecoveryProbe {
  connectionId: string;
  recovery: TrackerRecoveryClass;
  /** The row's `workspace_id` / `workspace_name` — what the connection is bound to. */
  boundWorkspaceId: string | null;
  boundWorkspaceName: string | null;
  /** What the live probe reported; both null when the probe failed ('redetect'). */
  currentWorkspaceId: string | null;
  currentWorkspaceName: string | null;
  /** The probe's own failure message, verbatim; null unless `recovery` is 'redetect'. */
  probeError: string | null;
}

/** {@link TrackerRecoveryClass} `'renamed'`'s repair — what the remap rewrote. */
export interface TrackerRemapResult {
  /** Links rewritten from `<old>-<suffix>` to `<new>-<suffix>`. */
  remappedLinks: number;
  /** Unresolved outbox rows whose external id (or mirrored parent) was rewritten. */
  remappedOutboxRows: number;
  /** The new prefix, now the connection's `workspace_name`. */
  workspaceName: string;
  /**
   * External ids that did NOT carry the old prefix, left exactly as they are and
   * surfaced as a review finding. Should always be empty — a rename rewrites the
   * whole workspace — so a non-empty list means something this remap cannot
   * explain, and guessing at it would repoint a link at an unrelated issue.
   */
  unmatchedExternalIds: string[];
}

/** {@link TrackerRecoveryClass} `'replaced'`'s repair — what the adoption did. */
export interface TrackerAdoptionResult {
  /** The fresh connection bound to the new database instance. */
  newConnectionId: string;
  /** Links of the retired connection that were orphaned (entities are never archived). */
  orphanedLinks: number;
  /** Unresolved outbox rows settled as cancelled, each one a review finding. */
  cancelledWrites: number;
  /** Orphaned links CONCLUSIVELY re-pointed onto an issue in the new workspace. */
  relinked: number;
  /** Plausible-but-inconclusive matches filed for the user to confirm; nothing was imported for them. */
  ambiguous: number;
}

/**
 * Wizard Step 1 hierarchy. The top level is provider-defined (Linear team,
 * Plane project); the second level narrows it (Linear project/view/cycle,
 * Plane cycle/module). `'all'` is the whole-container narrow.
 */
export interface TrackerSourceContainer {
  id: string;
  name: string;
  /** Short key chip (Linear team key "COR"; Plane project identifier). */
  key: string | null;
  openIssueCount: number | null;
}

/**
 * The second-level scope on a source selection. `'space'` is Dart's and only
 * Dart's: a space is the dartboard-title prefix before the first '/', which no
 * endpoint enumerates, so the adapter resolves the member boards from `/config`
 * at call time and unions the per-board fetches.
 */
export type TrackerNarrowKind = 'all' | 'project' | 'view' | 'cycle' | 'module' | 'space';

export interface TrackerSourceNarrow {
  id: string;
  kind: TrackerNarrowKind;
  name: string;
  issueCount: number | null;
}

export interface TrackerSourceTree {
  /** UI label for the container level: "Team" (Linear) / "Project" (Plane). */
  containerLabel: string;
  containers: TrackerSourceContainer[];
}

/** The persisted source choice on a connection. */
export interface TrackerSourceSelection {
  containerId: string;
  narrowId: string;
  narrowKind: TrackerNarrowKind;
  /**
   * Where a CREATE lands when the selection itself is not a concrete container
   * — Dart space groups, whose `containerId` is a space name no create can be
   * filed against. Absent everywhere else, since every other selection's
   * container is already the level the provider files an issue at.
   */
  pushContainerId?: string;
}

/**
 * One row of the wizard's Map step: a tracker GROUPING that can be mapped onto
 * a cyboflow project. The grouping unit is provider-defined — Linear projects
 * (each paired with a team) plus whole teams, Plane projects, Dart spaces — and
 * the group carries its READY-MADE `selection`, so nothing downstream has to
 * know which provider produced it.
 */
export interface TrackerGroup {
  /** Stable within one tree; the Map step's row key, never persisted. */
  id: string;
  name: string;
  /** Short key chip (Linear team key, Plane project identifier); null when none. */
  key: string | null;
  /** The `sourceLabel` a connection minted from this group is persisted with. */
  sourceLabel: string;
  selection: TrackerSourceSelection;
  /**
   * Groups sharing this key share a state list, so the States step renders one
   * mapping table per distinct value (Linear states are per-team, Plane's
   * per-project, Dart's workspace-wide).
   */
  stateScopeKey: string;
}

/** A labelled band of groups in the Map step ("Projects", "Whole teams", …). */
export interface TrackerGroupSection {
  label: string;
  groups: TrackerGroup[];
}

/** Everything `listGroups` offers, in the order the Map step renders it. */
export interface TrackerGroupTree {
  sections: TrackerGroupSection[];
}

/**
 * Canonical state grouping used to seed mapping defaults. Plane states carry
 * these natively; Linear workflow-state types map onto them (triage → triage,
 * backlog → backlog, unstarted → unstarted, started → started,
 * completed → completed, canceled → cancelled).
 */
export type TrackerStateGroup =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'cancelled';

export interface TrackerState {
  id: string;
  name: string;
  /** Hex color for the state dot; null when the provider has none. */
  color: string | null;
  group: TrackerStateGroup;
}

/**
 * Mapping target: cyboflow's four writable stages, don't-import, or the
 * OUTBOUND-ONLY `'indev'`.
 *
 * `'indev'` is deliberately asymmetric and the UI says so ("In development
 * (one way)"). Position 7 'In development' is orchestrator-DERIVED — a tracker
 * actor writing it is rejected by TaskChangeRouter as 'forbidden_stage' — so
 * this target can never place an issue there on the way IN, and inbound treats
 * it exactly like `'dont'`. What it DOES do is pin the way OUT: it names which
 * provider state a task entering In development writes back to, replacing the
 * "first state in the `started` group" guess. That guess is fine where the
 * provider declares its own state groups (Linear, Plane) and much weaker where
 * the adapter has to infer them from state NAMES (Dart), which is why the pin
 * exists at all.
 */
export type TrackerMappingTarget = 'dont' | 'idea' | 'ready' | 'done' | 'wontdo' | 'indev';

/** Per-connection state mapping, keyed by tracker state id. */
export type TrackerStateMapping = Record<string, TrackerMappingTarget>;

/**
 * What one provider offers for the two MAPPED fields — the seed source for
 * `priorityMapping` / `categoryMapping` and, from Phase 6, the wizard's value
 * pickers.
 *
 * `null` means "no live list to discover": either the provider's scale is
 * STATIC and hard-coded in the adapter, or it has no such field at all. Both
 * read the same way to a caller — there is nothing to fetch and nothing to
 * re-confirm after a workspace edit — which is why they share one value rather
 * than being distinguished here.
 *
 * Today Linear and Plane return their fixed priority scales (non-null, but
 * constant) with `categories: null`; Dart returns the live `/config.priorities`
 * and `/config.types` lists, which a workspace owner can rename at any time.
 */
export interface TrackerFieldOptions {
  /** Provider-raw priority tokens, in the provider's own order. */
  priorities: string[] | null;
  /** Provider-raw type/category titles; null where the provider has no such field. */
  categories: string[] | null;
  /**
   * The seeded priority mapping for this provider's `priorities` above,
   * computed main-side (`priorityMapping.ts`'s `seedDefaultPriorityMapping`) so
   * the wizard never re-derives the seed table client-side. The Phase-6
   * mapping picker's initial values, before any edit.
   */
  defaultPriorityMapping: TrackerPriorityMapping;
  /** Same as `defaultPriorityMapping`, for `categories` (`categoryMapping.ts`). */
  defaultCategoryMapping: TrackerCategoryMapping;
}

/**
 * A connection's resolved priority mapping, mirroring the main-side
 * `PriorityMapping` (priorityMapping.ts) across the wizard/connected-view IPC
 * boundary. `toProvider[p] === null` means the level has no provider token to
 * send (see the main-side module header); `toLocal` is keyed by the
 * lowercased provider token.
 */
export interface TrackerPriorityMapping {
  toProvider: Record<Priority, string | null>;
  toLocal: Record<string, Priority>;
}

/** A connection's resolved category mapping, mirroring `CategoryMapping` (categoryMapping.ts). */
export interface TrackerCategoryMapping {
  toProvider: Record<EntityCategory, string | null>;
  toLocal: Record<string, EntityCategory>;
}

/**
 * The wizard's edited priority-mapping OVERLAY (migration 118's
 * `priority_mapping_json`) — `toProvider` only. `toLocal` is deliberately
 * never sent: the wizard's picker edits only which provider token each local
 * level sends, and the resolver (`resolveEffectivePriorityMapping`) falls back
 * to the seed's own `toLocal` when the overlay omits it — which is exactly
 * the canonical inbound table the picker was seeded from, so there is nothing
 * for the wizard to re-derive or re-send.
 */
export interface TrackerPriorityMappingOverlay {
  toProvider: Partial<Record<Priority, string | null>>;
}

/** Same shape as {@link TrackerPriorityMappingOverlay}, for the category mapping. */
export interface TrackerCategoryMappingOverlay {
  toProvider: Partial<Record<EntityCategory, string | null>>;
}

export interface TrackerUserRef {
  id: string;
  name: string;
  /** Two-letter avatar initials, derived when the provider has none. */
  initials: string;
}

export interface TrackerIssue {
  /**
   * The stable sync key. ADAPTER-OPAQUE: each adapter owns its format and the
   * core never parses it. Linear uses the bare issue UUID; Plane composites
   * the project scope in ("<projectId>/<issueId>") because its REST paths are
   * project-scoped.
   */
  externalId: string;
  /** Human ref shown in lowercase mono, e.g. "CORE-142" / "WEB-12". */
  identifier: string;
  title: string;
  /** Provider-native rich description, normalized to markdown; null if empty. */
  description: string | null;
  url: string;
  stateId: string;
  assignee: TrackerUserRef | null;
  estimate: number | null;
  parentExternalId: string | null;
  /** ISO-8601; drives the incremental cursor. */
  updatedAt: string;
  /** Remote archive marker (Linear archivedAt); null = live. */
  archivedAt: string | null;
  /**
   * The remote priority as the PROVIDER spells it: Linear `'0'..'4'` (`'0'` is
   * a real "No priority" value, never an absence), Plane
   * `urgent|high|medium|low|none`, Dart the workspace's own priority title
   * (`Critical`/`High`/…). null only where the provider genuinely carries none
   * — Dart OMITS the key entirely for an unprioritized task, which reads back
   * here as null.
   *
   * DELIBERATELY PROVIDER-RAW rather than a local {@link
   * import('./tasks').Priority}: the local scale is 7 levels and every provider
   * offers 4-5, so mapping on the way in and comparing in local space would flap
   * a user's P3 down to P2 on every pass. The mapping (priorityMapping.ts) is
   * applied only at the merge/compose edge; the baseline stores this same raw
   * token so the three-way diff runs entirely in provider space.
   */
  priority: string | null;
  /**
   * The remote issue's TYPE, where the provider models one that can carry
   * cyboflow's entity category (feature/bug/chore) — Dart's task type title.
   *
   * ALWAYS null on Linear and Plane: neither has a native type field, and label
   * emulation is explicitly out of scope, so "unsupported by this provider" and
   * "this issue has no type" are the same value here. The merge reads that as
   * ABSENT rather than as a cleared category — see the category arm's provider
   * gate in inboundSync.ts.
   */
  category: string | null;
  /**
   * The `cyboflow-sync` recovery marker found in the provider-native
   * description, surfaced BEFORE the adapter strips it; null when the issue
   * carries none, or when the provider's creates are natively idempotent and no
   * marker is ever written (Linear).
   *
   * WHY IT CROSSES THIS SEAM. Where creates are NOT idempotent (Plane), a
   * create that commits and then loses its response leaves a live remote child
   * under a PROVIDER-MINTED id that matches neither the outbox row's
   * `external_id` nor its `client_key` — so the inbound pass, which halts on
   * those two columns, would see an unlinked issue and import it as a second
   * idea. This marker is the only thing identifying that child as ours, and it
   * is gone from every `description` an adapter returns.
   */
  recoveryClientKey: string | null;
  /**
   * OPAQUE compare-for-equality content fingerprint, populated only by
   * adapters whose `capabilities.requiresIdReconciliation` is true (beads —
   * docs/proposals/tracker-beads-provider.md, "4. Pull reconciliation"). The
   * same value {@link import('../../main/src/services/trackerSync/adapterTypes').TrackerAdapter.listIssueRevisions}
   * pairs with each id, surfaced here as well so the reconciliation sweep can
   * stamp a link's last-seen fingerprint from ANY issue the adapter returns
   * (a listing row, a point fetch, or a write's post-write echo) rather than
   * only from the sweep projection.
   *
   * NOT the concurrency token: {@link concurrencyToken} identifies one remote
   * WRITE (beads: a Dolt `CommitHash`) and gates a guarded update, whereas
   * this identifies remote CONTENT and answers "has this issue changed since
   * we last looked" for an adapter whose `updatedAt` cannot be trusted to
   * advance. Never parsed, ordered, or compared across adapters.
   */
  revision?: string;
  /**
   * Opaque concurrency token for a GUARDED write (migration 123's
   * `guardedUpdates` capability) — populated only by adapters that support
   * detect-after-write concurrency checking (beads: the newest Dolt
   * `CommitHash` from `bd history`, captured alongside the pre-send read).
   * `undefined` on every adapter that does not declare `guardedUpdates`
   * (Linear, Plane, Dart today); those never populate this field. See
   * `updateIssueState`/`updateIssueContent`'s optional `expectedToken`
   * parameter in adapterTypes.ts and `TrackerRevisionMismatchError` in
   * errors.ts for how the token is consumed.
   */
  concurrencyToken?: string;
}

export type TrackerSelectionMode = 'all' | 'assignee' | 'manual';
export type TrackerConflictMode = 'auto' | 'manual';
export type TrackerConnectionStatus = 'active' | 'paused' | 'disconnected';

/**
 * Per-direction sync cadence. 'auto' runs on the 5-minute tick and live
 * entity-change events; 'manual' defers that direction until an explicit
 * "Sync now" (intents still queue durably in the meantime — manual mode
 * delays work, it never drops it).
 *
 * Three independent directions replace the former single two-way toggle:
 *  - statusSyncMode: status changes on LINKED items, both directions
 *    (stage write-back out, remote state application in)
 *  - pullMode: NEW remote issues importing as ideas
 *  - pushMode: NEW cyboflow ideas creating top-level tracker issues
 */
export type TrackerDirectionMode = 'auto' | 'manual';

/**
 * The THREE-STATE cadence: `'auto'` runs a direction on every pass, `'manual'`
 * holds it until the user asks, `'off'` declines it altogether.
 *
 * `'off'` is categorically different from the other two, and the difference is
 * WHERE it gates: auto/manual only disagree about WHEN a direction runs, so
 * they gate the DRAIN and an intent is always recorded; `'off'` disagrees about
 * WHETHER it ever runs, so it gates the ENQUEUE (docs/proposals/
 * tracker-field-writeback.md invariant 5). A row queued under an off direction
 * would be undrainable even by "Sync now", and the kind-agnostic inbound
 * blocker would then halt the pass at that issue forever.
 *
 * The corollary — the one that cost a user their edits — is that an off
 * direction DISCARDS intents rather than banking them, so turning a direction
 * back ON has to reconcile what it declined. See writeBack's
 * `backfillContentWrites`.
 */
export type TrackerGatedSyncMode = 'auto' | 'manual' | 'off';

/**
 * Per-connection cadence for status on LINKED items — stage write-back OUT and
 * remote state application IN, the one direction that moves in both.
 *
 * Three-state since migration 130. It began as a {@link TrackerDirectionMode}
 * (094) on the theory that status only ever answers "when", never "whether" —
 * which held right up until someone turned every visible control off and found
 * cyboflow still writing their stage moves into the tracker. It defaults to
 * 'auto' on every connection the wizard creates and it WRITES, so it needs the
 * same off switch content and archive have.
 *
 * `pullMode` and `pushMode` stay two-state deliberately: pull only imports, and
 * push already has `pushTarget` as its per-connection off switch, so neither
 * carries the hazard this fixed.
 */
export type TrackerStatusSyncMode = TrackerGatedSyncMode;

/**
 * Per-connection cadence for field write-back ("Sync task fields") and remote
 * archive/trash (migration 118). A SEPARATE type from {@link
 * TrackerDirectionMode} rather than a widening of it — deliberately: the
 * existing three directions (status/pull/push) answer "auto or manual", never
 * "never", and coupling a third value onto that pair would let an unrelated
 * direction accidentally compile against 'off'. `'off'` is the default for
 * both new modes: an existing connection never consented to writing derived
 * field values, or archiving issues, into someone else's tracker workspace.
 *
 *  - `contentSyncMode`: title/description/priority/category, LINKED items,
 *    OUTBOUND only.
 *  - `archiveSyncMode`: a local archive/delete becomes a remote trash/archive
 *    (never a hard delete).
 *
 * Unlike `TrackerDirectionMode`, `'off'` gates at the ENQUEUE rather than the
 * drain (docs/proposals/tracker-field-writeback.md invariant 5) — a queued row
 * under an 'off' direction would be undrainable even by "Sync now", which
 * would permanently stall the inbound cursor.
 */
export type TrackerContentSyncMode = TrackerGatedSyncMode;

/** The three entity tables a tracker link can point at (mirrors EntityExternalLinkRow). */
export type TrackerEntityType = 'idea' | 'epic' | 'task';

// ---------------------------------------------------------------------------
// Read models — the connected view + wizard tRPC surface
//
// EVERY shape below is renderer-visible. None of them carries key material, and
// none ever will: the API key flows renderer->main once inside
// TrackerCredentialsInput and is encrypted before it reaches sqlite.
// ---------------------------------------------------------------------------

/**
 * One line of a connection's sync log, persisted as a JSON array in
 * `tracker_connections.last_sync_log_json`. `marker` is the leading glyph the
 * connected view's log column renders in its own color; `line` is the text.
 */
export interface TrackerSyncLogEntry {
  marker: string;
  line: string;
}

/**
 * What one sync pass did — the "Sync now" mutation's result. The main-side
 * `TrackerSyncPassResult` (trackerSyncService.ts) is an alias of this type, so
 * the wire shape and the engine's own result cannot drift apart.
 */
export interface TrackerSyncPassSummary {
  connectionId: string;
  /** False when the connection id is unknown (nothing ran, nothing persisted). */
  ran: boolean;
  /** The deletion sweep ran this pass. */
  swept: boolean;
  /** The connection was left `paused` (bad/absent credentials). */
  paused: boolean;
  /** The composed log, exactly as persisted. */
  entries: TrackerSyncLogEntry[];
  /** Non-null when the pass failed; the message is also in `entries`. */
  error: string | null;
}

/**
 * One connected-view card. `workspaceName` / `actorLabel` are nullable columns
 * normalized to '' here — the card always renders a string, and "unknown
 * workspace" is not a state worth branching on in the renderer.
 */
export interface TrackerConnectionSummary {
  id: string;
  projectId: number;
  provider: TrackerProvider;
  status: TrackerConnectionStatus;
  workspaceName: string;
  actorLabel: string;
  /** Plane self-hosted origin; null on cloud/Linear connections. */
  baseUrl: string | null;
  /** Human label for the wizard's Step-1 choice, e.g. "Core · Cycle 12". */
  sourceLabel: string;
  /** The mapping's source scope (parsed from source_json); null on legacy rows with no recorded scope. */
  sourceScope: { containerId: string; narrowId: string; narrowKind: TrackerNarrowKind } | null;
  selectionMode: TrackerSelectionMode;
  statusSyncMode: TrackerStatusSyncMode;
  pullMode: TrackerDirectionMode;
  pushMode: TrackerDirectionMode;
  /** Field write-back cadence (migration 118); 'off' on every pre-Phase-3 connection. */
  contentSyncMode: TrackerContentSyncMode;
  /** Remote archive/trash cadence (migration 118); 'off' on every pre-Phase-3 connection. */
  archiveSyncMode: TrackerContentSyncMode;
  mirrorSubissues: boolean;
  conflictMode: TrackerConflictMode;
  /** This mapping is the one its provider pushes new ideas through. */
  pushTarget: boolean;
  stateMapping: TrackerStateMapping;
  /** The connection's RESOLVED priority mapping (seed + stored overlay) — the mappings card's read-only count. */
  priorityMapping: TrackerPriorityMapping;
  /** Same, for category; `toProvider` is all-null on a provider `providerSupportsCategorySync` refuses. */
  categoryMapping: TrackerCategoryMapping;
  lastSyncAt: string | null;
  lastSyncLog: TrackerSyncLogEntry[];
  /** Active (non-orphaned) entity links on this connection. */
  linkedCount: number;
  openConflictCount: number;
}

/** `tracker_conflicts.kind` (mirrors TrackerConflictRow). */
export type TrackerConflictKind = 'field_conflict' | 'remote_deleted';

/** The user's per-conflict decision in the connected view's conflict list. */
export type TrackerConflictChoice = 'local' | 'remote';

/**
 * One row of the Manual-mode conflict list. `entityRef` / `entityTitle` come
 * from the linked entity and are null when the conflict has no link (or the
 * entity is gone) — a `remote_deleted` conflict on a hard-deleted entity, say.
 */
export interface TrackerConflictSummary {
  id: number;
  connectionId: string;
  kind: TrackerConflictKind;
  /**
   * 'title' | 'description' | 'stage' | 'priority' | 'category' on a field
   * conflict; null on remote_deleted.
   */
  field: string | null;
  /**
   * The two sides' values as the conflict recorded them. Content fields carry
   * the literal text; a STAGE row's `remoteValue` is the MAPPED board stage id;
   * a PRIORITY or CATEGORY row carries BOTH sides as PROVIDER-RAW tokens (the
   * local side run through the effective mapping), because that is the space the
   * comparison happened in — see TrackerIssue.priority.
   */
  localValue: string | null;
  remoteValue: string | null;
  entityRef: string | null;
  entityTitle: string | null;
  createdAt: string;
}

/** One row of the wizard's Reconcile step (a pre-existing backlog item). */
export interface TrackerReconcileItem {
  entityType: 'idea' | 'task';
  entityId: string;
  ref: string;
  title: string;
  /** Best title match among the fetched issues, or null when nothing matched. */
  suggestedExternalId: string | null;
}

/** The user's Keep / Link / Discard ruling for one Reconcile row. */
export interface TrackerReconcileDecision {
  entityType: 'idea' | 'task';
  entityId: string;
  action: 'keep' | 'link' | 'discard';
  /** The issue to link to — required for action 'link', ignored otherwise. */
  linkExternalId?: string;
  /**
   * The linked issue's display ref ("CORE-142") and web URL, carried alongside
   * the id so the link row lands with its ref chip populated — the wizard
   * already holds the issue list, and nothing else back-fills these later.
   */
  linkIdentifier?: string;
  linkUrl?: string;
}

/**
 * `tracker_connections.selection_json` — the wizard's Step-2 choice. Mirrors
 * the main-side `TrackerSelectionPayload` (inboundSync.ts), which reads the
 * same blob back for inbound filtering.
 */
export interface TrackerSelectionJson {
  /** selection_mode 'assignee': only issues assigned to one of these import. */
  assigneeIds?: string[];
  /** selection_mode 'manual': only these external ids import. */
  issueIds?: string[];
}

/** Everything the wizard's final Review step hands to `connect`. */
export interface TrackerConnectPayload {
  projectId: number;
  credentials?: TrackerCredentialsInput;
  /**
   * Reuse an existing live connection's stored key + identity instead of pasting
   * one. Exactly one of credentials / sourceConnectionId must be set.
   */
  sourceConnectionId?: string;
  source: TrackerSourceSelection;
  sourceLabel: string;
  selectionMode: TrackerSelectionMode;
  selectionJson: TrackerSelectionJson | null;
  stateMapping: TrackerStateMapping;
  statusSyncMode: TrackerStatusSyncMode;
  pullMode: TrackerDirectionMode;
  pushMode: TrackerDirectionMode;
  /**
   * Omitted = 'off', matching the column default — no wizard step offers this
   * control yet (docs/proposals/tracker-field-writeback.md Phase 6), so every
   * connect() call in this build takes the safe default rather than silently
   * requiring a field the renderer does not send.
   */
  contentSyncMode?: TrackerContentSyncMode;
  /** Omitted = 'off'; see contentSyncMode. */
  archiveSyncMode?: TrackerContentSyncMode;
  /**
   * Omitted = the seed only, no user override (every pre-Phase-6 connect()
   * call). The wizard's Phase-6 mapping table sends the edited `toProvider`
   * table verbatim; see {@link TrackerPriorityMappingOverlay}.
   */
  priorityMapping?: TrackerPriorityMappingOverlay;
  /**
   * Omitted = the seed only; also omitted by the wizard for a provider
   * `providerSupportsCategorySync` refuses (no editor renders for it).
   */
  categoryMapping?: TrackerCategoryMappingOverlay;
  mirrorSubissues: boolean;
  conflictMode: TrackerConflictMode;
  reconcile: TrackerReconcileDecision[];
  /**
   * May this mapping create new tracker issues? Omitted = true, which is the
   * single-mapping shape every pre-rev-4 connection has. The Map step sets it
   * false on every sibling but one where N groups target the same cyboflow
   * project, so a locally filed idea is pushed once rather than N times.
   */
  pushTarget?: boolean;
}

/**
 * The connected view's editable settings. Every field optional — an omitted key
 * leaves the stored value untouched (mirrors the store's ConnectionSettingsPatch).
 */
export interface TrackerSettingsPatch {
  statusSyncMode?: TrackerStatusSyncMode;
  pullMode?: TrackerDirectionMode;
  pushMode?: TrackerDirectionMode;
  contentSyncMode?: TrackerContentSyncMode;
  archiveSyncMode?: TrackerContentSyncMode;
  /** See {@link TrackerConnectPayload.priorityMapping}; no v1 UI patches this yet (mirrors stateMapping below). */
  priorityMapping?: TrackerPriorityMappingOverlay;
  /** See {@link TrackerConnectPayload.categoryMapping}. */
  categoryMapping?: TrackerCategoryMappingOverlay;
  mirrorSubissues?: boolean;
  conflictMode?: TrackerConflictMode;
  stateMapping?: TrackerStateMapping;
  selectionMode?: TrackerSelectionMode;
  /** null clears the stored selection (back to "everything in the source"). */
  selectionJson?: TrackerSelectionJson | null;
}

/** An entity's live tracker link — the "open in Linear/Plane" affordance's data. */
export interface TrackerEntityLinkRef {
  provider: TrackerProvider;
  externalUrl: string | null;
  externalIdentifier: string | null;
  /**
   * What a removal ruling's "cancel it in the tracker" would ACTUALLY do to
   * this issue: the provider's trash/archive, or the cancelled-state fallback
   * (provider has no archive, OR the connection's archive sync is 'off' — an
   * archive row would be undrainable there, so the fallback is forced). The
   * removal dialog's copy is built from this so it promises exactly the action
   * the service enqueues.
   */
  removalAction: 'archive' | 'cancel';
}
