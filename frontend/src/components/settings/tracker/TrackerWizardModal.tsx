/**
 * TrackerWizardModal — the six-step connect wizard for a Linear/Plane/Dart
 * tracker connection (Connect · Map · Tasks · States · Reconcile · Review).
 *
 * Rendered as a `size="full"` Modal nested inside the Settings modal (the
 * WorkflowEditorModal pattern); Modal's cross-portal guards make the nesting
 * safe. State is flat local `useState` — this is a self-contained flow whose
 * values are handed to `cyboflow.tracker.connect` and then forgotten, so a
 * store would only add ceremony.
 *
 * ONE PASS MINTS N CONNECTIONS. The Map step maps tracker groups (Linear
 * projects + whole teams, Plane projects, Dart spaces) N:1 onto cyboflow
 * projects, and each mapping becomes its own `tracker_connections` row — so
 * everything downstream of Map is keyed by group: issues per group, one state
 * table per distinct `stateScopeKey`, one reconcile preview per distinct target
 * project, and one sequential `connect` call per mapping.
 *
 * Data flow, one probe per forward step (each is a MUTATION: every call carries
 * the API key and hits the provider live, so nothing here may be cached):
 *
 *   Step 0  wizardValidate   -> the "Authorized as …" identity card
 *   Step 1  wizardGroups     -> the mappable groups (+ a local project list)
 *   Step 2  wizardIssues ×N  -> the issue set the three modes filter, per group
 *   Step 3  wizardStates ×N  -> one mapping table per distinct state scope
 *   Step 4  reconcilePreview ×N -> pre-existing backlog rows, per target project
 *   Step 5  connect ×N       -> persists each mapping, then the parent refreshes
 *
 * Moving BACK never re-fetches; changing the mappings (or the Step-2 selection)
 * invalidates exactly the downstream steps that depend on it.
 *
 * The API key lives in this component's state and leaves only inside the
 * `credentials` field of the calls above — nothing ever reads it back.
 *
 * ADD-MAPPING MODE (`sourceConnection` set). Re-entered from the connected
 * view to manage an authorization that already exists, so Step 0 is not merely
 * pre-answered — it is GONE: the wizard opens on Map, the rail carries five
 * steps, Back from Map has nowhere to go, and nothing ever asks for the key
 * again. Every probe names the connection (`{ connectionId }`) instead of
 * carrying credentials, `connect` passes `sourceConnectionId`, and main
 * resolves the stored key on its side — so in this mode nothing key-shaped
 * crosses IPC at all.
 *
 * Its Map step is a MAPPING EDITOR in two halves. The connection's live
 * siblings are listed first, each with an Unlink that STAGES a disconnect
 * locally; below them, only the groups no kept sibling covers are offered a
 * project select — so a scope is either linked or mappable, never both, and
 * moving one is unlink-then-map rather than a second row on the same scope.
 *
 * Everything sibling-derived reads PAST a staged unlink (the push target it
 * holds, the container it covers), because Submit disconnects before it
 * connects; and a run that only unlinks skips Tasks/States/Reconcile entirely,
 * since those steps describe mapped groups it does not have.
 *
 * WORKSPACE-ROW MODE (`meta.workspaceBound` on a FRESH connect — beads today).
 * A workspace-bound provider has no account to authorize into: it has one
 * workspace per repository, found by probing that repository. So there is
 * nothing for Step 0 to ask and the wizard opens on Map, exactly as add-mapping
 * mode does — but its Map step is a PER-PROJECT SURFACE rather than a list of
 * one account's groups: one row per cyboflow project, each row probing its OWN
 * repository and carrying its OWN credentials `{ projectId, workspaceDirToken? }`
 * from that probe through to its `connect`.
 *
 * Which makes the group tree something this mode SYNTHESIZES rather than
 * fetches — no single credential could stand for N repositories — so group ids
 * are namespaced by project (every row's probe answers with the same
 * adapter-side id) and `mappings` points each group at its own row's project,
 * never at another. Everything downstream reads that tree unchanged.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { trpc } from '../../../trpc/client';
import { Modal } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { cn } from '../../../utils/cn';
import { API } from '../../../utils/api';
import type { Project } from '../../../types/project';
import type {
  TrackerConflictMode,
  TrackerConnectionSummary,
  TrackerContentSyncMode,
  TrackerCredentialsInput,
  TrackerDirectionMode,
  TrackerFieldOptions,
  TrackerGroup,
  TrackerGroupTree,
  TrackerIssue,
  TrackerProvider,
  TrackerReconcileDecision,
  TrackerReconcileItem,
  TrackerSelectionJson,
  TrackerSelectionMode,
  TrackerState,
  TrackerStatusSyncMode,
  TrackerStateMapping,
  TrackerUserRef,
  TrackerWizardSourceInput,
  TrackerWorkspaceIdentity,
} from '../../../../../shared/types/trackerSync';
import type { EntityCategory, Priority } from '../../../../../shared/types/tasks';
import { Eyebrow, PillToggle, ProviderTile, Segmented } from './trackerShared';
import {
  BEADS_INIT_DISCLOSURE,
  GATED_MODE_OPTIONS,
  gatedModeLabel,
  ENTITY_CATEGORIES,
  MAPPING_TARGETS,
  PRIORITY_LEVELS,
  classifyKeylessDetectFailure,
  mappingTargetNote,
  providerMeta,
  seedCategoryMapping,
  seedPriorityMapping,
  seedStateMapping,
  trackerInputClass,
  trackerSelectClass,
} from './trackerVocabulary';

// ---------------------------------------------------------------------------
// Step vocabulary
// ---------------------------------------------------------------------------

const STEP_LABELS = ['Connect', 'Map', 'Tasks', 'States', 'Reconcile', 'Review'] as const;
const STEP_EYEBROWS = [
  'Step 01 · Authorize',
  'Step 02 · Map projects',
  'Step 03 · Selection',
  'Step 04 · Mapping',
  'Step 05 · Reconcile',
  'Step 06 · Confirm',
] as const;
const LAST_STEP = STEP_LABELS.length - 1;
/** The step every mapping change clamps the rail back to. */
const MAP_STEP = 1;

type ReconcileAction = TrackerReconcileDecision['action'];

/** Per-mapping submit state on the Review step; an absent entry is "pending". */
interface MappingProgress {
  status: 'connecting' | 'ok' | 'error';
  error: string | null;
}

/**
 * WORKSPACE-ROW MODE — what one project row's probe of its own repository found.
 *
 * The three failures are kept apart because they need three different offers:
 * 'missing' is the one `bd init` fixes, 'missing-cli' is a fact about the
 * MACHINE (so the list states it once, and those rows get no controls at all),
 * and 'error' is the honest remainder that only re-probing can move.
 */
type WorkspaceRowState =
  | { status: 'probing' }
  | { status: 'detected'; group: TrackerGroup }
  | { status: 'missing'; error: string }
  | { status: 'missing-cli'; error: string }
  | { status: 'error'; error: string };

/**
 * A row action in flight. The probe is not one of these — it has its own
 * 'probing' status above — so a row can be initializing while still showing the
 * answer the last probe gave it.
 */
type WorkspaceRowAction = 'initializing' | 'picking';

const MODE_OPTIONS: readonly { value: TrackerSelectionMode; label: string }[] = [
  { value: 'all', label: 'All tasks' },
  { value: 'assignee', label: 'By assignee' },
  { value: 'manual', label: 'Manual' },
];

const DIRECTION_OPTIONS: readonly { value: TrackerDirectionMode; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'manual', label: 'Manual' },
];

function directionLabel(mode: TrackerDirectionMode): string {
  return mode === 'auto' ? 'Auto' : 'Manual';
}

const RECONCILE_OPTIONS: readonly { value: ReconcileAction; label: string; selectedClass: string }[] = [
  { value: 'keep', label: 'Keep', selectedClass: 'bg-status-success text-text-on-status-success' },
  { value: 'link', label: 'Link', selectedClass: 'bg-interactive text-text-on-interactive' },
  { value: 'discard', label: 'Discard', selectedClass: 'bg-surface-tertiary text-text-secondary' },
];

const CONFLICT_OPTIONS: readonly { value: TrackerConflictMode; label: string }[] = [
  { value: 'auto', label: 'Auto-resolve' },
  { value: 'manual', label: 'Manual review' },
];

/** Card chrome shared by every panel in the body — square corners, hairline border. */
const CARD = 'rounded-none border border-border-primary bg-surface-primary';

/**
 * Reconcile decisions are keyed by (target project, entity) — the same entity id
 * can only appear under one project, but two mappings sharing a project share
 * its rows, so the project has to be part of the key for the routing below.
 */
function decisionKey(projectId: number, item: TrackerReconcileItem): string {
  return `${projectId}:${item.entityType}:${item.entityId}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Default for the `connectedProjectIds` prop. A module constant rather than a
 * `= []` default, so the identity is stable across renders and the row-probe
 * effect that lists it does not re-fire on every one.
 */
const NO_CONNECTED_PROJECTS: readonly number[] = [];

/**
 * Whether a live connection's recorded scope names the exact slice a mappable
 * group covers. The whole triple is the identity — two rows under the same
 * container are different mappings unless the narrow matches too.
 */
function sameScope(
  scope: NonNullable<TrackerConnectionSummary['sourceScope']>,
  selection: TrackerGroup['selection'],
): boolean {
  return (
    scope.containerId === selection.containerId &&
    scope.narrowId === selection.narrowId &&
    scope.narrowKind === selection.narrowKind
  );
}

export interface TrackerWizardModalProps {
  isOpen: boolean;
  provider: TrackerProvider;
  projectId: number;
  /**
   * Projects this provider ALREADY has a live connection for. Display only, and
   * only in workspace-row mode: such a project's row is inert ("Connected") and,
   * the half that matters, is never probed — one saved CLI spawn per row, for an
   * answer the catalog already holds. Defaults to none.
   */
  connectedProjectIds?: readonly number[];
  onClose: () => void;
  /** Fired after every mapping's `connect` resolves so the catalog can re-read its rows. */
  onConnected: () => void;
  /**
   * ADD-MAPPING MODE. Set to a live connection to hang further mappings off its
   * existing authorization: Step 0 is dropped entirely, the probes and `connect`
   * name this connection instead of carrying a key, and the Map step chips the
   * groups its siblings already cover. Undefined = the ordinary paste-a-key run.
   */
  sourceConnection?: TrackerConnectionSummary;
}

export function TrackerWizardModal({
  isOpen,
  provider,
  projectId,
  connectedProjectIds = NO_CONNECTED_PROJECTS,
  onClose,
  onConnected,
  sourceConnection,
}: TrackerWizardModalProps): React.JSX.Element {
  const meta = providerMeta(provider);

  /**
   * WORKSPACE-ROW MODE: a fresh connect for a provider whose workspaces are
   * bound to repositories rather than to an account (see the header). The Map
   * step becomes a per-project surface and every credential in the run is a
   * ROW's, so this is the flag the whole file branches on — never the provider
   * name. Add-mapping mode is deliberately excluded: it extends ONE existing
   * connection's workspace, which is a different question entirely.
   */
  const workspaceRowMode = meta.workspaceBound && sourceConnection === undefined;

  /**
   * The first step this run owns. Add-mapping mode starts on Map because its
   * authorization already happened, and workspace-row mode because there is no
   * account to authorize against at all — Step 0 is not skipped-but-present in
   * either, it is absent, so every index-based guard below reads this rather
   * than 0.
   */
  const firstStep = sourceConnection !== undefined || meta.workspaceBound ? MAP_STEP : 0;

  // ── Navigation ────────────────────────────────────────────────────────────
  const [step, setStep] = useState(firstStep);
  /** Furthest step reached — the rail only navigates to steps already unlocked. */
  const [maxStep, setMaxStep] = useState(firstStep);
  /**
   * Add-mapping mode mounts already fetching (the group tree its Map step opens
   * on), so it starts loading rather than rendering one frame of "nothing came
   * back" before the mount probe has even fired.
   */
  const [loading, setLoading] = useState(sourceConnection !== undefined);
  const [stepError, setStepError] = useState<string | null>(null);

  // ── Step 0 · credentials + identity ───────────────────────────────────────
  const [apiKey, setApiKey] = useState('');
  const [workspaceSlug, setWorkspaceSlug] = useState('');
  const [baseUrl, setBaseUrl] = useState(meta.defaultBaseUrl ?? '');
  const [validating, setValidating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<TrackerWorkspaceIdentity | null>(null);

  // ── Step 1 · map ──────────────────────────────────────────────────────────
  const [projects, setProjects] = useState<Project[]>([]);
  const [groupTree, setGroupTree] = useState<TrackerGroupTree | null>(null);
  /** groupId → cyboflow project id; an absent key is "don't import". */
  const [mappings, setMappings] = useState<Record<string, number>>({});
  /** cyboflow project id → the groupId that may push new ideas out. */
  const [pushChoice, setPushChoice] = useState<Record<number, string>>({});
  /**
   * Add-mapping mode only: the connection's live siblings, read once on mount.
   * They are the Map step's LINKED section — what this authorization already
   * covers — and the reason its group list only offers what is not covered yet.
   * Empty in the ordinary run (a fresh authorization has no siblings).
   */
  const [existingMappings, setExistingMappings] = useState<TrackerConnectionSummary[]>([]);
  /**
   * Connection ids STAGED for unlink. Staging is local and free: nothing is
   * disconnected until Submit runs, and closing the wizard forgets it. Every
   * sibling-derived answer below reads past these, because by the time a
   * `connect` in this run executes they will already be retired.
   */
  const [unlinkIds, setUnlinkIds] = useState<Set<string>>(() => new Set());

  // ── Step 1 · map · workspace rows (workspace-row mode only) ───────────────
  /** cyboflow project id → what that project's repository probe found. */
  const [rowStates, setRowStates] = useState<Record<number, WorkspaceRowState>>({});
  /**
   * Per-row folder override, as main handed it back: an opaque `token` to send
   * and a `path` to show. Absent is the ordinary case, "probe the project's
   * repo". The token is the ONLY half that goes back over the wire.
   */
  const [rowDirs, setRowDirs] = useState<Record<number, { token: string; path: string }>>({});
  const [rowActions, setRowActions] = useState<Record<number, WorkspaceRowAction>>({});
  /**
   * What a row's last ACTION failed with — a refused init, a picker that threw.
   * Kept apart from `rowStates` so an action failure never rewrites the answer
   * the probe gave: a row whose init was refused is still a row with no
   * workspace, and must keep offering the fix.
   */
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  /**
   * Version stamp for the row probes, PER ROW — a row's answer supersedes only
   * its own earlier ones, so a slow probe for one repository cannot discard a
   * fresh answer for another (Detect clicked twice in a row is the case this
   * catches: without it the earlier request can land last and install a stale
   * answer). Deliberately not `probeVersionRef`, which every mapping edit bumps
   * — and a landing row probe seeds a mapping.
   */
  const rowProbeVersionsRef = useRef<Record<number, number>>({});
  /**
   * Rows the mount sweep has already fired at. The sweep re-runs whenever its
   * inputs change identity (a prop array the catalog composes inline), and a
   * re-run must not spawn a second CLI probe per project.
   */
  const probedPidsRef = useRef<Set<number>>(new Set());

  // ── Step 2 · selection ────────────────────────────────────────────────────
  const [issuesByGroup, setIssuesByGroup] = useState<Record<string, TrackerIssue[]>>({});
  const [issuesLoaded, setIssuesLoaded] = useState(false);
  const [mode, setMode] = useState<TrackerSelectionMode>('all');
  const [assignees, setAssignees] = useState<Record<string, boolean>>({});
  const [manual, setManual] = useState<Record<string, boolean>>({});

  // ── Step 3 · mapping + direction ──────────────────────────────────────────
  const [statesByScope, setStatesByScope] = useState<Record<string, TrackerState[]>>({});
  const [statesLoaded, setStatesLoaded] = useState(false);
  const [mappingByScope, setMappingByScope] = useState<Record<string, TrackerStateMapping>>({});
  const [statusSyncMode, setStatusSyncMode] = useState<TrackerStatusSyncMode>('auto');
  const [pullMode, setPullMode] = useState<TrackerDirectionMode>('auto');
  const [pushMode, setPushMode] = useState<TrackerDirectionMode>('auto');
  const [mirrorSubissues, setMirrorSubissues] = useState(true);
  const [conflictMode, setConflictMode] = useState<TrackerConflictMode>('auto');
  /**
   * The priority/category mapping tables' vocabulary — fetched ONCE per
   * credential source (like `groupTree`, and unlike `statesByScope`: none of
   * the three providers scopes these lists to a container, so a mapping
   * change never invalidates this cache — see the credential-edit effect
   * below, not the mapping-change one).
   */
  const [fieldOptions, setFieldOptions] = useState<TrackerFieldOptions | null>(null);
  const [fieldOptionsLoaded, setFieldOptionsLoaded] = useState(false);
  /** The edited `toProvider` half only — `toLocal` is never sent (see trackerVocabulary.ts). */
  const [priorityMapping, setPriorityMapping] = useState<Record<Priority, string | null> | null>(
    null,
  );
  const [categoryMapping, setCategoryMapping] = useState<Record<
    EntityCategory,
    string | null
  > | null>(null);
  const [contentSyncMode, setContentSyncMode] = useState<TrackerContentSyncMode>('off');
  const [archiveSyncMode, setArchiveSyncMode] = useState<TrackerContentSyncMode>('off');

  // ── Step 4 · reconcile ────────────────────────────────────────────────────
  const [reconcileByProject, setReconcileByProject] = useState<
    Record<number, TrackerReconcileItem[]>
  >({});
  const [reconcileLoaded, setReconcileLoaded] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, ReconcileAction>>({});
  const [linkTargets, setLinkTargets] = useState<Record<string, string>>({});
  /**
   * Monotonic version for the reconcile probe. Bumped whenever an in-flight
   * request is superseded (a new ensureReconcile call, or any invalidation
   * below that drops `reconcileLoaded`) so a response that arrives after its
   * request was superseded is discarded instead of installed for the wrong
   * mappings/selection.
   */
  const reconcileRequestIdRef = useRef(0);
  /**
   * Version stamp for the group/issues/states probes, bumped by every
   * credential or mapping edit: a probe claimed under an older version abandons
   * its install, so a response landing AFTER the invalidation effect cleared
   * the caches cannot re-install data computed for the previous mapping set.
   */
  const probeVersionRef = useRef(0);

  // ── Step 5 · submit ───────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<Record<string, MappingProgress>>({});
  /**
   * Per-staged-unlink submit state, keyed by connection id (see `progress`).
   * Deliberately NOT cleared when the mappings change: a disconnect that already
   * landed cannot be undone by editing the map, and re-sending it would only
   * fail on a row that no longer exists.
   */
  const [unlinkProgress, setUnlinkProgress] = useState<Record<string, MappingProgress>>({});

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const credentials = useMemo<TrackerCredentialsInput>(() => {
    const trimmedBase = baseUrl.trim();
    // Plane workspace slugs are lowercase URL slugs; users naturally type the
    // display name ("BahiaVentures"), and the API 404s on a case mismatch.
    const trimmedSlug = workspaceSlug.trim().toLowerCase();
    return {
      provider,
      // A KEYLESS provider sends no key at all — not an empty string, which
      // the router's schema would read as a keyed provider missing its key.
      // It sends the ACTIVE PROJECT instead: main resolves that project's repo
      // path and probes the workspace there, so nothing path-shaped that this
      // renderer composed decides where the CLI runs. Workspace-row mode never
      // reads this memo — its credentials are per row (`rowCredentials`), one
      // project each; this is the run-wide shape the other paths use.
      ...(meta.needsApiKey ? { apiKey: apiKey.trim() } : { projectId }),
      ...(meta.defaultBaseUrl !== null && trimmedBase.length > 0 ? { baseUrl: trimmedBase } : {}),
      ...(meta.needsWorkspaceSlug && trimmedSlug.length > 0 ? { workspaceSlug: trimmedSlug } : {}),
    };
  }, [
    provider,
    projectId,
    apiKey,
    baseUrl,
    workspaceSlug,
    meta.needsApiKey,
    meta.defaultBaseUrl,
    meta.needsWorkspaceSlug,
  ]);

  /**
   * What every probe sends as its credential source — EXACTLY one key, which is
   * what the router's refinement enforces. Add-mapping mode names the
   * connection and sends nothing key-shaped; the paste path sends the key it
   * validated.
   */
  const probeSource = useMemo<TrackerWizardSourceInput>(
    () =>
      sourceConnection !== undefined ? { connectionId: sourceConnection.id } : { credentials },
    [sourceConnection, credentials],
  );

  /**
   * The identity the header and Review card attribute this run to, and the gate
   * `goToStep` reads: non-null means "authorized". Add-mapping mode inherits it
   * from the connection it extends — that authorization was already probed, and
   * re-probing it would ask the provider a question the row already answers.
   *
   * Only the two DISPLAYED fields, deliberately: a connection summary carries no
   * `workspaceId`, and inventing one to satisfy `TrackerWorkspaceIdentity` would
   * put a connection id behind a workspace-shaped name.
   */
  const shownIdentity = useMemo<Pick<
    TrackerWorkspaceIdentity,
    'workspaceName' | 'actorLabel'
  > | null>(
    () =>
      sourceConnection === undefined
        ? identity
        : {
            workspaceName: sourceConnection.workspaceName,
            actorLabel: sourceConnection.actorLabel,
          },
    [sourceConnection, identity],
  );

  /**
   * The projects the Map step lists, ACTIVE FIRST and then the list's own order.
   * The active project is the one the user opened the wizard from, so it leads;
   * this is also the order the synthesized tree — and therefore every downstream
   * probe, connect and Review row — follows.
   */
  const orderedProjects = useMemo<Project[]>(
    () =>
      workspaceRowMode
        ? [
            ...projects.filter((p) => p.id === projectId),
            ...projects.filter((p) => p.id !== projectId),
          ]
        : projects,
    [workspaceRowMode, projects, projectId],
  );

  /**
   * The group tree workspace-row mode SYNTHESIZES instead of fetching. No single
   * `wizardGroups` call could stand for N repositories, so the tree is assembled
   * from the rows that came back detected — one section, in `orderedProjects`
   * order — and everything downstream reads it exactly as it reads a fetched one.
   */
  const workspaceGroupTree = useMemo<TrackerGroupTree | null>(() => {
    if (!workspaceRowMode) return null;
    const groups: TrackerGroup[] = [];
    for (const project of orderedProjects) {
      const row = rowStates[project.id];
      if (row !== undefined && row.status === 'detected') groups.push(row.group);
    }
    return { sections: [{ label: 'Workspaces', groups }] };
  }, [workspaceRowMode, orderedProjects, rowStates]);

  /** The tree this run actually maps from — synthesized here, fetched everywhere else. */
  const effectiveGroupTree = workspaceRowMode ? workspaceGroupTree : groupTree;

  /** Every group in tree order — the order mappings, probes and connects follow. */
  const allGroups = useMemo<TrackerGroup[]>(
    () => (effectiveGroupTree?.sections ?? []).flatMap((s) => s.groups),
    [effectiveGroupTree],
  );

  const mappedGroups = useMemo(
    () => allGroups.filter((g) => mappings[g.id] !== undefined),
    [allGroups, mappings],
  );

  const projectName = (id: number): string =>
    projects.find((p) => p.id === id)?.name ?? `Project ${id}`;

  /**
   * The siblings this run is KEEPING — the Map step's linked rows, and the only
   * ones every sibling-derived answer below may consider. A staged unlink is
   * already gone as far as this run is concerned: its disconnect runs before any
   * connect does, so the push target it holds and the scope it covers are the
   * run's to take.
   */
  const liveMappings = useMemo(
    () => existingMappings.filter((m) => !unlinkIds.has(m.id)),
    [existingMappings, unlinkIds],
  );

  /** Siblings staged for unlink, in the order the connection reports them. */
  const stagedUnlinks = useMemo(
    () => existingMappings.filter((m) => unlinkIds.has(m.id)),
    [existingMappings, unlinkIds],
  );

  /**
   * The connection whose stored key this run's `connect` calls ride on. Nothing
   * key-shaped exists in add-mapping mode: main resolves one from the row the
   * payload names, and `disconnect` CLEARS that row's key — so the carrier has
   * to be a row the run is keeping. Any of them will do; they are all the same
   * authorization.
   */
  const credentialCarrierId: string | undefined =
    sourceConnection === undefined
      ? undefined
      : !unlinkIds.has(sourceConnection.id)
        ? sourceConnection.id
        : (liveMappings[0]?.id ?? sourceConnection.id);

  /**
   * The one staged unlink that must run AFTER the connects instead of before
   * them: the run retires every sibling, so the key the connects need belongs
   * to a row that is itself on the way out. Ordering it last keeps the run
   * working; the cost is that a new mapping re-using its exact scope imports on
   * the next sync pass rather than immediately, because the old row still owns
   * those links while the connect runs.
   */
  const deferredUnlinkId: string | null =
    credentialCarrierId !== undefined &&
    unlinkIds.has(credentialCarrierId) &&
    mappedGroups.length > 0
      ? credentialCarrierId
      : null;

  /**
   * The kept siblings covering a group's exact scope triple. A group with any
   * of them is LINKED: it is shown as a linked row and offers no select at all,
   * which is what keeps one scope from being mapped into two projects at once.
   *
   * A legacy row with no recorded `sourceScope` matches nothing rather than
   * everything: an unknown scope is not evidence of coverage.
   */
  const mappedSiblingsFor = (group: TrackerGroup): TrackerConnectionSummary[] =>
    liveMappings.filter((m) => m.sourceScope !== null && sameScope(m.sourceScope, group.selection));

  /** Groups still free to map — everything no kept sibling already covers. */
  const availableGroups = (groups: TrackerGroup[]): TrackerGroup[] =>
    groups.filter((g) => mappedSiblingsFor(g).length === 0);

  /**
   * What to call a sibling's scope. The tree's own name where the scope is still
   * offered as a group; the stored label otherwise — a scope the provider no
   * longer lists (a deleted team, a legacy row) still has to be nameable, and
   * inventing one from the id would read as a group that exists.
   */
  const siblingLabel = (m: TrackerConnectionSummary): string => {
    const scope = m.sourceScope;
    const group = scope === null ? undefined : allGroups.find((g) => sameScope(scope, g.selection));
    return group?.name ?? m.sourceLabel;
  };

  /** Distinct target projects, first-mapped first. */
  const targetProjectIds = useMemo(() => {
    const seen: number[] = [];
    for (const g of mappedGroups) {
      const pid = mappings[g.id];
      if (!seen.includes(pid)) seen.push(pid);
    }
    return seen;
  }, [mappedGroups, mappings]);

  const groupsForProject = (pid: number): TrackerGroup[] =>
    mappedGroups.filter((g) => mappings[g.id] === pid);

  /**
   * Target projects whose pusher is a LIVE SIBLING this run is not re-connecting
   * — the push-target question those projects answered in an earlier run.
   *
   * It matters because `connect` claims the push target across wizard runs: main
   * demotes every other armed row of the (project, provider) pair unless the
   * payload says `pushTarget: false`. This run's cluster is run-local, so
   * without this the FIRST group mapped into such a project would silently take
   * the incumbent's place — a choice the user was never shown. So the run
   * declines instead: no radio, `pushGroupIdFor` → null, `pushTarget: false` on
   * every mapping into the project, and the incumbent keeps filing.
   *
   * Reads KEPT siblings only: unlink the pusher and the project is left with
   * none, so the run claims it normally — the disconnect runs first, and main
   * hands the flag on from there.
   *
   * The same-scope exclusion is belt and braces. The Map step no longer offers a
   * select for a scope a kept sibling covers, so a run cannot contain the
   * incumbent's own scope today; the term keeps the rule true of the payload
   * rather than of the current step layout, because `pushTarget: false` on the
   * incumbent's own row takes main's existing-row branch and DISARMS the project
   * outright. Empty outside add-mapping mode, so the paste-a-key run is
   * unchanged.
   */
  const pushIncumbents = useMemo<{ projectId: number; sibling: TrackerConnectionSummary }[]>(() => {
    const out: { projectId: number; sibling: TrackerConnectionSummary }[] = [];
    for (const pid of targetProjectIds) {
      const runScopes = mappedGroups.filter((g) => mappings[g.id] === pid).map((g) => g.selection);
      const sibling = liveMappings.find((m) => {
        const scope = m.sourceScope;
        // A legacy row with no recorded scope is not evidence of anything, same
        // rule the linked rows follow — an unknown scope claims no coverage.
        if (m.projectId !== pid || !m.pushTarget || scope === null) return false;
        return !runScopes.some((selection) => sameScope(scope, selection));
      });
      if (sibling !== undefined) out.push({ projectId: pid, sibling });
    }
    return out;
  }, [targetProjectIds, mappedGroups, mappings, liveMappings]);

  const pushIncumbentFor = (pid: number): TrackerConnectionSummary | undefined =>
    pushIncumbents.find((i) => i.projectId === pid)?.sibling;

  const pushIncumbentIds = useMemo(
    () => new Set(pushIncumbents.map((i) => i.projectId)),
    [pushIncumbents],
  );

  /**
   * Projects several groups feed AND this run decides for — the only ones
   * needing a push-target choice. A project with an incumbent is excluded even
   * at N groups: the payload sends `pushTarget: false` for all of them, so a
   * radio would offer a choice nothing acts on.
   */
  const pushClusters = useMemo(() => {
    const byProject = new Map<number, TrackerGroup[]>();
    for (const g of mappedGroups) {
      const pid = mappings[g.id];
      const list = byProject.get(pid);
      if (list) list.push(g);
      else byProject.set(pid, [g]);
    }
    return [...byProject.entries()]
      .filter(([pid, groups]) => groups.length > 1 && !pushIncumbentIds.has(pid))
      .map(([pid, groups]) => ({ projectId: pid, groups }));
  }, [mappedGroups, mappings, pushIncumbentIds]);

  /**
   * Which mapping pushes new ideas for a project, or null when this run claims
   * nothing there. A stale choice (its group was remapped elsewhere) falls back
   * to the first mapping rather than leaving the project with no pusher.
   */
  const pushGroupIdFor = (pid: number): string | null => {
    // An incumbent outside this run answers for the project already; claiming
    // over it would demote a mapping the user never chose to replace.
    if (pushIncumbentFor(pid) !== undefined) return null;
    const groups = groupsForProject(pid);
    const chosen = pushChoice[pid];
    if (groups.some((g) => g.id === chosen)) return chosen;
    return groups[0]?.id ?? null;
  };

  /**
   * A whole-team mapping and a project mapping under the same team both import
   * the project's issues; the engine's cross-row guard skips the second. Say so
   * here rather than letting the user discover it after the first sync.
   *
   * The overlap is with every KEPT mapping, not just this run's: in add-mapping
   * mode the run owns only part of the connection's set, and a sibling covers
   * exactly as much as an in-run row would. Both directions are checked, because
   * the subsuming half can sit on either side — and a sibling staged for unlink
   * covers nothing, since it is retired before the first sync.
   */
  const overlapWarnings = useMemo<string[]>(() => {
    // Honest about the engine's guarantee: the cross-scope guard imports each
    // issue ONCE, under whichever mapping fetches it first — not
    // deterministically under either row.
    const overlapText = (name: string): string =>
      `Issues in ${name} are covered by both mappings — each imports once, under whichever mapping syncs it first.`;

    // Containers some whole-container mapping already covers — this run's plus
    // the connection's kept siblings. A legacy row with no recorded scope
    // covers nothing, same rule the linked rows follow.
    const covered = new Set<string>();
    for (const g of mappedGroups) {
      if (g.selection.narrowKind === 'all') covered.add(g.selection.containerId);
    }
    for (const m of liveMappings) {
      if (m.sourceScope !== null && m.sourceScope.narrowKind === 'all') {
        covered.add(m.sourceScope.containerId);
      }
    }

    const out: string[] = [];
    for (const g of mappedGroups) {
      if (g.selection.narrowKind !== 'all') {
        // Narrowed here, subsumed by a whole-container mapping on either side.
        if (covered.has(g.selection.containerId)) out.push(overlapText(g.name));
      } else if (
        // Whole-container here, subsuming a sibling narrowed under it — the
        // direction a this-run-only scan can never see.
        liveMappings.some(
          (m) =>
            m.sourceScope !== null &&
            m.sourceScope.narrowKind !== 'all' &&
            m.sourceScope.containerId === g.selection.containerId,
        )
      ) {
        out.push(overlapText(g.name));
      }
    }
    return out;
  }, [mappedGroups, liveMappings]);

  /** Every fetched issue across the mapped groups, in mapping order. */
  const allIssues = useMemo(
    () => mappedGroups.flatMap((g) => issuesByGroup[g.id] ?? []),
    [mappedGroups, issuesByGroup],
  );

  /** Distinct assignees across every mapping, with their issue counts. */
  const assigneeOptions = useMemo(() => {
    const byId = new Map<string, { user: TrackerUserRef; count: number }>();
    for (const issue of allIssues) {
      if (issue.assignee === null) continue;
      const entry = byId.get(issue.assignee.id);
      if (entry) entry.count += 1;
      else byId.set(issue.assignee.id, { user: issue.assignee, count: 1 });
    }
    return [...byId.values()];
  }, [allIssues]);

  const includedByGroup = useMemo<Record<string, TrackerIssue[]>>(() => {
    const out: Record<string, TrackerIssue[]> = {};
    for (const g of mappedGroups) {
      const rows = issuesByGroup[g.id] ?? [];
      out[g.id] =
        mode === 'assignee'
          ? rows.filter((i) => i.assignee !== null && assignees[i.assignee.id] === true)
          : mode === 'manual'
            ? rows.filter((i) => manual[i.externalId] === true)
            : rows;
    }
    return out;
  }, [mappedGroups, issuesByGroup, mode, assignees, manual]);

  const includedIssues = useMemo(
    () => mappedGroups.flatMap((g) => includedByGroup[g.id] ?? []),
    [mappedGroups, includedByGroup],
  );

  const selectedAssigneeIds = useMemo(
    () => Object.keys(assignees).filter((id) => assignees[id]),
    [assignees],
  );

  /** Membership set for the Tasks list, so the row render stays linear. */
  const includedIds = useMemo(
    () => new Set(includedIssues.map((i) => i.externalId)),
    [includedIssues],
  );

  const includedForProject = (pid: number): TrackerIssue[] =>
    groupsForProject(pid).flatMap((g) => includedByGroup[g.id] ?? []);

  /**
   * One state table per distinct scope key: Linear states are per-team, Plane's
   * per-project, so two groups sharing a scope share a table (and its mapping).
   */
  const stateScopes = useMemo(() => {
    const byKey = new Map<string, TrackerGroup[]>();
    for (const g of mappedGroups) {
      const list = byKey.get(g.stateScopeKey);
      if (list) list.push(g);
      else byKey.set(g.stateScopeKey, [g]);
    }
    return [...byKey.entries()].map(([key, groups]) => ({
      key,
      groups,
      label: groups.map((g) => g.name).join(', '),
    }));
  }, [mappedGroups]);

  const mappedStates = useMemo(
    () => stateScopes.flatMap((scope) => statesByScope[scope.key] ?? []),
    [stateScopes, statesByScope],
  );

  const skippedStates = useMemo(
    () =>
      stateScopes.flatMap((scope) =>
        (statesByScope[scope.key] ?? []).filter(
          (s) => (mappingByScope[scope.key] ?? {})[s.id] === 'dont',
        ),
      ),
    [stateScopes, statesByScope, mappingByScope],
  );

  /** Every reconcile row with its ruling, flattened across the target projects. */
  const decidedRows = useMemo(
    () =>
      targetProjectIds.flatMap((pid) =>
        (reconcileByProject[pid] ?? []).map((item) => {
          const key = decisionKey(pid, item);
          return {
            projectId: pid,
            item,
            action: decisions[key] ?? ('keep' as ReconcileAction),
            target: linkTargets[key],
          };
        }),
      ),
    [targetProjectIds, reconcileByProject, decisions, linkTargets],
  );

  const tally = useMemo(() => {
    let keep = 0;
    let link = 0;
    let discard = 0;
    for (const row of decidedRows) {
      if (row.action === 'keep') keep += 1;
      else if (row.action === 'link') link += 1;
      else discard += 1;
    }
    return { keep, link, discard };
  }, [decidedRows]);

  const failedCount = useMemo(
    () =>
      mappedGroups.filter((g) => progress[g.id]?.status === 'error').length +
      stagedUnlinks.filter((m) => unlinkProgress[m.id]?.status === 'error').length,
    [mappedGroups, progress, stagedUnlinks, unlinkProgress],
  );

  /**
   * A run that only unlinks. Tasks, States and Reconcile all describe MAPPED
   * groups — with none there is no issue set to filter, no state table to build
   * and no backlog to reconcile against — so those three steps have nothing to
   * say and the run's one forward move is Review.
   */
  const unlinkOnly = mappedGroups.length === 0 && stagedUnlinks.length > 0;

  /** Where Continue goes from `from`, honouring the unlink-only jump. */
  const nextStepFrom = (from: number): number =>
    from === MAP_STEP && unlinkOnly ? LAST_STEP : from + 1;

  /** Where Back goes from `from` — the mirror of the jump above. */
  const prevStepFrom = (from: number): number =>
    from === LAST_STEP && mappedGroups.length === 0 ? MAP_STEP : from - 1;

  /**
   * Footer guards. Map cannot advance with nothing staged either way (no group
   * to probe, no unlink to run), and the two selection modes cannot advance
   * while they resolve to an empty set.
   */
  const nextBlocked =
    (step === MAP_STEP && mappedGroups.length === 0 && stagedUnlinks.length === 0) ||
    (step === 2 && mode === 'assignee' && selectedAssigneeIds.length === 0) ||
    (step === 2 && mode === 'manual' && includedIssues.length === 0);

  // -------------------------------------------------------------------------
  // Workspace rows — one project, one repository, one set of credentials
  // -------------------------------------------------------------------------

  /**
   * ONE row's credential source. Every probe, init and connect a row fires
   * carries this — its own project id, plus the folder token when that row was
   * pointed somewhere else — so a row can never answer for another row's
   * repository. Nothing path-shaped is composed here: main resolves the
   * directory from the id, or from the token it minted for the picked folder.
   */
  const rowCredentials = (
    pid: number,
    dir: { token: string; path: string } | null = rowDirs[pid] ?? null,
  ): TrackerCredentialsInput => ({
    provider,
    projectId: pid,
    ...(dir !== null ? { workspaceDirToken: dir.token } : {}),
  });

  /**
   * The id a row's group is stored under. Every row's probe answers with the
   * SAME adapter-side group id (one workspace, one group), and that id keys
   * `mappings`, `issuesByGroup` and `progress` — so without the row's project in
   * it, N rows would collide on one entry.
   */
  const workspaceGroupId = (pid: number, rawId: string): string => `${provider}:${pid}:${rawId}`;

  /** The inverse of {@link workspaceGroupId}: namespaced id → the row that produced it. */
  const workspaceRowPid = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const [key, state] of Object.entries(rowStates)) {
      if (state.status === 'detected') out[state.group.id] = Number(key);
    }
    return out;
  }, [rowStates]);

  /**
   * The credential source ONE group's probes ride on. Ordinarily every group in
   * a run shares `probeSource`; in workspace-row mode each group is a different
   * repository, so each answers with its own row's credentials.
   */
  const probeSourceForGroup = (group: TrackerGroup): TrackerWizardSourceInput =>
    workspaceRowMode
      ? { credentials: rowCredentials(workspaceRowPid[group.id] ?? projectId) }
      : probeSource;

  const clearRowError = (pid: number): void =>
    setRowErrors((prev) => {
      if (prev[pid] === undefined) return prev;
      const next = { ...prev };
      delete next[pid];
      return next;
    });

  const setRowAction = (pid: number, action: WorkspaceRowAction | null): void =>
    setRowActions((prev) => {
      if (action !== null) return { ...prev, [pid]: action };
      if (prev[pid] === undefined) return prev;
      const next = { ...prev };
      delete next[pid];
      return next;
    });

  /**
   * Ask ONE row's repository whether it holds a workspace.
   *
   * `dir` is passed explicitly by the folder picker and the reset beside it,
   * which both re-probe in the same tick they change the row's folder — before
   * the re-render that would fold it into `rowDirs`; every other caller lets it
   * default to what the row already holds.
   */
  const probeRow = async (
    pid: number,
    dir: { token: string; path: string } | null = rowDirs[pid] ?? null,
  ): Promise<void> => {
    // Claim this row's next version before the await, so a later probe for the
    // same row supersedes this one rather than racing it.
    const version = (rowProbeVersionsRef.current[pid] ?? 0) + 1;
    rowProbeVersionsRef.current[pid] = version;
    clearRowError(pid);
    setRowStates((prev) => ({ ...prev, [pid]: { status: 'probing' } }));
    try {
      const tree = await trpc.cyboflow.tracker.wizardGroups.mutate({
        credentials: rowCredentials(pid, dir),
      });
      if (rowProbeVersionsRef.current[pid] !== version) return;
      // A workspace-bound provider's tree is degenerate by construction: one
      // section holding the one workspace that repository resolves to.
      const group = tree.sections[0]?.groups[0];
      if (group === undefined) {
        setRowStates((prev) => ({
          ...prev,
          [pid]: {
            status: 'error',
            error: `${meta.name} returned no workspace for this project.`,
          },
        }));
        return;
      }
      const scoped: TrackerGroup = { ...group, id: workspaceGroupId(pid, group.id) };
      setRowStates((prev) => ({ ...prev, [pid]: { status: 'detected', group: scoped } }));
      // Seed Sync for the ACTIVE project's row alone, and only where the user
      // has not answered yet: it is the project the wizard was opened from, so
      // syncing it is the near-certain intent, while every other row defaulting
      // to Sync would connect repositories nobody asked about. Never overwrites
      // a "Don't sync" the user chose.
      if (pid === projectId) {
        setMappings((prev) =>
          prev[scoped.id] === undefined ? { ...prev, [scoped.id]: pid } : prev,
        );
      }
    } catch (err) {
      if (rowProbeVersionsRef.current[pid] !== version) return;
      const message = errorMessage(err);
      const failure = classifyKeylessDetectFailure(message);
      setRowStates((prev) => ({
        ...prev,
        [pid]:
          failure === 'missing-workspace'
            ? { status: 'missing', error: message }
            : failure === 'missing-cli'
              ? { status: 'missing-cli', error: message }
              : { status: 'error', error: message },
      }));
    }
  };

  /**
   * Create the workspace a row's probe failed to find, then re-probe that row.
   *
   * Runs with the ROW's own credentials, so the init lands exactly where that
   * row's probe looked — this renderer never learns which directory that was.
   * A REFUSED init does not re-probe: there is nothing new to find, and the
   * message belongs beside the offer that failed.
   */
  const handleRowInit = async (pid: number): Promise<void> => {
    setRowAction(pid, 'initializing');
    clearRowError(pid);
    try {
      await trpc.cyboflow.tracker.wizardInitWorkspace.mutate({ credentials: rowCredentials(pid) });
      await probeRow(pid);
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [pid]: errorMessage(err) }));
    } finally {
      setRowAction(pid, null);
    }
  };

  /**
   * Point ONE row at a folder of the user's choosing, then re-probe it there.
   * A cancelled dialog comes back as null and must change nothing at all — the
   * user declining a dialog is not a reason to retire the row's answer.
   */
  const handleRowPick = async (pid: number): Promise<void> => {
    setRowAction(pid, 'picking');
    clearRowError(pid);
    try {
      const picked = await trpc.cyboflow.tracker.wizardPickWorkspace.mutate({ provider });
      if (picked === null) return;
      setRowDirs((prev) => ({ ...prev, [pid]: picked }));
      await probeRow(pid, picked);
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [pid]: errorMessage(err) }));
    } finally {
      setRowAction(pid, null);
    }
  };

  /** Drop a row's picked folder and go back to probing its repository. */
  const handleRowUseRepo = (pid: number): void => {
    setRowDirs((prev) => {
      const next = { ...prev };
      delete next[pid];
      return next;
    });
    void probeRow(pid, null);
  };

  // -------------------------------------------------------------------------
  // Invalidation — a changed upstream answer drops exactly what depended on it
  // -------------------------------------------------------------------------

  /**
   * Retire the validated identity AND the group tree: the wizard past Step 0 is
   * only meaningful for the credential that was actually probed, and a
   * different one can name a different workspace.
   *
   * A function rather than only an effect because the FOLDER PICKER changes the
   * probed workspace too, and it must invalidate and re-detect in one ordered
   * go — an effect firing on the same commit would race the re-detect it is
   * supposed to precede.
   */
  const retireProbedCredential = (): void => {
    probeVersionRef.current += 1;
    setIdentity(null);
    setAuthError(null);
    setGroupTree(null);
    setMappings({});
    // The field-options cache is credential-scoped, same as groupTree — a
    // different key can name a different workspace with a different
    // priority/type vocabulary.
    setFieldOptions(null);
    setFieldOptionsLoaded(false);
    setPriorityMapping(null);
    setCategoryMapping(null);
    setMaxStep(0);
  };

  /**
   * ADD-MAPPING MODE for a workspace-bound provider: pre-select "Sync into
   * <project>" for every group the connection's tree hands back, since its Map
   * row is sync/don't-sync against the wizard's OWN project rather than a
   * project picker (see `workspaceBound` in trackerVocabulary.ts) — without this
   * Next would stay disabled until the user touched a control that only has one
   * real choice.
   *
   * A FRESH workspace-bound connect never reaches here: it seeds per row, in
   * `probeRow`, and only for the active project's row.
   * Only fills a group with no mapping yet, so it never overwrites a user's
   * "Don't sync"; called right where the tree lands (both `ensureGroups` and
   * the add-mapping mount probe), never from render.
   *
   * `workspaceBound`/`boundProjectId` are passed in rather than closed over:
   * this keeps the function's own closure limited to the stable `setMappings`
   * setter, which is what lets it be omitted from an effect's dependency array
   * without re-firing the effect on every render.
   */
  const seedWorkspaceBoundMappings = (
    tree: TrackerGroupTree,
    workspaceBound: boolean,
    boundProjectId: number,
  ): void => {
    if (!workspaceBound) return;
    const groups = tree.sections.flatMap((s) => s.groups);
    if (groups.length === 0) return;
    setMappings((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const g of groups) {
        if (next[g.id] === undefined) {
          next[g.id] = boundProjectId;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  };

  // Editing a credential FIELD is the other way that happens.
  //
  // Inert in add-mapping AND workspace-row mode: neither renders a credential
  // input, so the only time this could fire is the mount pass — where it would
  // clamp the rail behind a Step 0 that does not exist in either.
  useEffect(() => {
    if (sourceConnection !== undefined || workspaceRowMode) return;
    retireProbedCredential();
    // The credential FIELDS are the trigger, and only they: retireProbedCredential
    // is re-created every render, so listing it would fire this on every one.
  }, [apiKey, baseUrl, workspaceSlug, sourceConnection, workspaceRowMode]);

  // The Map step's project list is a local read, loaded once per open. A failed
  // load leaves the list empty and the step unable to map anything.
  useEffect(() => {
    if (!isOpen) return;
    void API.projects
      .getAll()
      .then((res) => {
        if (res.success && Array.isArray(res.data)) setProjects(res.data);
      })
      .catch(() => setProjects([]));
  }, [isOpen]);

  // Different mappings mean different issues, state scopes, target projects and
  // reconcile matches — and supersede any reconcile request already in flight,
  // so its late response cannot install itself under the new mappings.
  useEffect(() => {
    reconcileRequestIdRef.current += 1;
    probeVersionRef.current += 1;
    setIssuesByGroup({});
    setIssuesLoaded(false);
    setAssignees({});
    setManual({});
    setStatesByScope({});
    setStatesLoaded(false);
    setMappingByScope({});
    setReconcileByProject({});
    setReconcileLoaded(false);
    setDecisions({});
    setLinkTargets({});
    setProgress({});
    setMaxStep((m) => Math.min(m, MAP_STEP));
  }, [mappings, pushChoice]);

  // The reconcile suggestions are computed against the INCLUDED issue set, so a
  // changed Tasks answer invalidates Reconcile (but nothing else).
  useEffect(() => {
    reconcileRequestIdRef.current += 1;
    setReconcileLoaded(false);
    setMaxStep((m) => Math.min(m, 3));
  }, [mode, assignees, manual]);

  // `probeRow` closes over the row state it reads and is re-created every
  // render, so the sweep below cannot list it as a dependency without re-firing
  // on every one. It reaches it through this ref instead, refreshed after each
  // render — declared BEFORE the sweep so the refresh runs first.
  const probeRowRef = useRef(probeRow);
  useEffect(() => {
    probeRowRef.current = probeRow;
  });

  // WORKSPACE-ROW MODE's mount sweep: probe every project's repository at once,
  // as soon as the project list lands. Concurrent rather than sequential — each
  // is an independent CLI spawn against a different directory, and serialising
  // them would make an eight-project list feel broken.
  //
  // `probedPidsRef` is what makes re-running this harmless: `connectedProjectIds`
  // is composed by the catalog and `projects` is re-set on every load, so the
  // effect can fire more than once and must not spawn a second probe per row. A
  // row the user re-detects by hand is not re-fired either, by the same rule.
  useEffect(() => {
    if (!isOpen || !workspaceRowMode) return;
    for (const project of projects) {
      // An already-connected project's answer is on its row as a chip; probing
      // it would spend a spawn to learn what the catalog already knows.
      if (connectedProjectIds.includes(project.id)) continue;
      if (probedPidsRef.current.has(project.id)) continue;
      probedPidsRef.current.add(project.id);
      void probeRowRef.current(project.id);
    }
  }, [isOpen, workspaceRowMode, projects, connectedProjectIds]);

  // -------------------------------------------------------------------------
  // Add-mapping mount probes
  //
  // DECLARED AFTER the invalidation effects on purpose: those bump
  // `probeVersionRef` on the mount pass too, and an effect that claimed its
  // version before that bump would discard its own response as superseded.
  // -------------------------------------------------------------------------

  // The wizard opens ON Map here, so the group tree that Step 0's Continue would
  // have fetched is fetched on mount instead. A failure surfaces as the step
  // error and leaves `groupTree` null — and Continue CANNOT retry it, because
  // an empty tree means nothing is mapped and the footer guard blocks the only
  // other call site of `ensureGroups`. The Map step's Retry card is what
  // re-drives it (see `retryGroups`).
  useEffect(() => {
    if (!isOpen || sourceConnection === undefined) return;
    const version = probeVersionRef.current;
    setLoading(true);
    void trpc.cyboflow.tracker.wizardGroups
      .mutate({ connectionId: sourceConnection.id })
      .then((tree) => {
        if (probeVersionRef.current === version) {
          setGroupTree(tree);
          seedWorkspaceBoundMappings(tree, meta.workspaceBound, projectId);
        }
      })
      .catch((err: unknown) => setStepError(errorMessage(err)))
      .finally(() => setLoading(false));
    // meta.workspaceBound and projectId feed seedWorkspaceBoundMappings; both
    // are invariant for the life of one mounted wizard, so listing them here
    // never causes a spurious re-fetch.
  }, [isOpen, sourceConnection, meta.workspaceBound, projectId]);

  // The connection's live siblings, for the Map step's "already mapped" chips.
  // A local read of rows the catalog already owns — a failure costs a hint, not
  // the step, so it degrades to no chips rather than blocking the wizard.
  useEffect(() => {
    if (!isOpen || sourceConnection === undefined) return;
    let cancelled = false;
    void trpc.cyboflow.tracker.mappings
      .query({ connectionId: sourceConnection.id })
      .then((rows) => {
        if (!cancelled) setExistingMappings(rows);
      })
      .catch(() => {
        if (!cancelled) setExistingMappings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, sourceConnection]);

  // -------------------------------------------------------------------------
  // Probes
  // -------------------------------------------------------------------------

  const ensureGroups = async (): Promise<void> => {
    // Workspace-row mode fetches nothing here: its tree is synthesized from the
    // per-row probes, and one credential-carrying call would ask a single
    // repository to answer for all of them.
    if (workspaceRowMode || groupTree !== null) return;
    const version = probeVersionRef.current;
    const tree = await trpc.cyboflow.tracker.wizardGroups.mutate({ ...probeSource });
    if (probeVersionRef.current !== version) return;
    setGroupTree(tree);
    seedWorkspaceBoundMappings(tree, meta.workspaceBound, projectId);
  };

  // Issues are fetched one mapping at a time: each call is a live provider
  // request carrying the key, and a mapped workspace can hold dozens of groups.
  const ensureIssues = async (): Promise<void> => {
    if (issuesLoaded) return;
    const version = probeVersionRef.current;
    const next: Record<string, TrackerIssue[]> = {};
    for (const group of mappedGroups) {
      next[group.id] = await trpc.cyboflow.tracker.wizardIssues.mutate({
        ...probeSourceForGroup(group),
        selection: group.selection,
      });
    }
    if (probeVersionRef.current !== version) return;
    setIssuesByGroup(next);
    setIssuesLoaded(true);
  };

  const ensureStates = async (): Promise<void> => {
    if (statesLoaded) return;
    const version = probeVersionRef.current;
    const nextStates: Record<string, TrackerState[]> = {};
    const nextMapping: Record<string, TrackerStateMapping> = {};
    for (const scope of stateScopes) {
      // Any group in the scope answers for all of them — that is what sharing a
      // scope key means, so only one probe per table is fired. That holds across
      // REPOSITORIES too in workspace-row mode: bd's state vocabulary is fixed
      // by the tool, not by the workspace, so every row reports the same
      // `stateScopeKey` and one table (probed through the first row's
      // credentials) genuinely describes them all.
      const rows = await trpc.cyboflow.tracker.wizardStates.mutate({
        ...probeSourceForGroup(scope.groups[0]),
        selection: scope.groups[0].selection,
      });
      nextStates[scope.key] = rows;
      nextMapping[scope.key] = seedStateMapping(rows, mappingByScope[scope.key]);
    }
    if (probeVersionRef.current !== version) return;
    setStatesByScope(nextStates);
    setMappingByScope(nextMapping);
    setStatesLoaded(true);
  };

  /**
   * The priority/category mapping tables' vocabulary + seeded defaults. Fired
   * alongside `ensureStates` (both belong to Step 3) but cached independently
   * of `mappedGroups`: no selection argument, since none of the three
   * providers scopes these lists to a container.
   */
  const ensureFieldOptions = async (): Promise<void> => {
    if (fieldOptionsLoaded) return;
    const version = probeVersionRef.current;
    // Workspace-row mode has no run-wide credential to send, and no need for
    // one: the priority/type vocabulary is the provider's, identical in every
    // workspace, so the first mapped row answers for the whole run.
    const source =
      workspaceRowMode && mappedGroups.length > 0
        ? probeSourceForGroup(mappedGroups[0])
        : probeSource;
    const options = await trpc.cyboflow.tracker.wizardFieldOptions.mutate({ ...source });
    if (probeVersionRef.current !== version) return;
    setFieldOptions(options);
    setPriorityMapping(seedPriorityMapping(options.defaultPriorityMapping.toProvider, priorityMapping ?? undefined));
    setCategoryMapping(seedCategoryMapping(options.defaultCategoryMapping.toProvider, categoryMapping ?? undefined));
    setFieldOptionsLoaded(true);
  };

  const ensureReconcile = async (): Promise<void> => {
    if (reconcileLoaded) return;
    // Claim this request's version before the awaits so a later call (a fresh
    // ensureReconcile, or an invalidation effect above) can supersede it.
    const requestId = (reconcileRequestIdRef.current += 1);
    const rowsByProject: Record<number, TrackerReconcileItem[]> = {};
    for (const pid of targetProjectIds) {
      rowsByProject[pid] = await trpc.cyboflow.tracker.reconcilePreview.mutate({
        projectId: pid,
        issues: includedForProject(pid),
      });
    }
    // The mappings or the selection changed while this was in flight — the
    // response no longer describes current state, so drop it. Whatever
    // superseded us already reset `reconcileLoaded`, and the next visit to this
    // step will re-fetch for the current state.
    if (reconcileRequestIdRef.current !== requestId) return;
    setReconcileByProject(rowsByProject);
    // A row with a suggested match defaults to Link (pre-filled with that
    // suggestion); everything else defaults to Keep.
    const nextDecisions: Record<string, ReconcileAction> = {};
    const nextTargets: Record<string, string> = {};
    for (const pid of targetProjectIds) {
      for (const row of rowsByProject[pid] ?? []) {
        const key = decisionKey(pid, row);
        if (row.suggestedExternalId !== null) {
          nextDecisions[key] = 'link';
          nextTargets[key] = row.suggestedExternalId;
        } else {
          nextDecisions[key] = 'keep';
        }
      }
    }
    setDecisions(nextDecisions);
    setLinkTargets(nextTargets);
    setReconcileLoaded(true);
  };

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Re-drive the group probe from the Map step itself. The only other caller of
   * `ensureGroups` is a forward `goToStep`, which add-mapping mode cannot reach
   * with an empty tree (nothing is mapped, so Continue is disabled) — without
   * this the step is a dead end whose only live control is Close.
   */
  const retryGroups = async (): Promise<void> => {
    setStepError(null);
    setLoading(true);
    try {
      await ensureGroups();
    } catch (err) {
      setStepError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleAuthorize = async (): Promise<void> => {
    setValidating(true);
    setAuthError(null);
    try {
      const result = await trpc.cyboflow.tracker.wizardValidate.mutate({ credentials });
      setIdentity(result);
    } catch (err) {
      setIdentity(null);
      setAuthError(errorMessage(err));
    } finally {
      setValidating(false);
    }
  };

  const goToStep = async (target: number): Promise<void> => {
    if (target < firstStep || target > LAST_STEP) return;
    // Step 0 is the gate: nothing downstream exists without a validated key.
    // Add-mapping mode enters already past it, carrying the connection's
    // identity — and a workspace-bound run has no single identity to gate on at
    // all: its rows are N workspaces, each vouched for by its own probe.
    if (!meta.workspaceBound && target > firstStep && shownIdentity === null) return;
    // The three middle steps describe mapped groups; with none they are not
    // enterable in EITHER direction, which is also what makes Back from Review
    // land on Map rather than on an empty Reconcile (see `prevStepFrom`).
    if (mappedGroups.length === 0 && target > MAP_STEP && target < LAST_STEP) return;
    setStepError(null);

    // Backwards navigation is pure — it never re-probes the provider.
    if (target <= step) {
      setStep(target);
      return;
    }

    setLoading(true);
    try {
      if (target >= 1) await ensureGroups();
      if (mappedGroups.length > 0) {
        if (target >= 2) await ensureIssues();
        if (target >= 3) {
          await ensureStates();
          await ensureFieldOptions();
        }
        if (target >= 4) await ensureReconcile();
      } else if (target > MAP_STEP && stagedUnlinks.length === 0) {
        // Past Map with nothing mapped and nothing staged — Review would have no
        // run to show. (Map itself is always enterable; that is where the run is
        // assembled.)
        throw new Error('Map a group or unlink one before continuing.');
      }
      setStep(target);
      setMaxStep((m) => Math.max(m, target));
    } catch (err) {
      setStepError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Stage a live mapping for unlink. Local only — the disconnect runs at Submit,
   * so nothing is destroyed by a wizard the user closes, and the group it covers
   * drops straight into the mappable list below.
   */
  const stageUnlink = (connectionId: string): void => {
    setUnlinkIds((prev) => {
      if (prev.has(connectionId)) return prev;
      const next = new Set(prev);
      next.add(connectionId);
      return next;
    });
  };

  const handleMap = (groupId: string, value: string): void => {
    setMappings((prev) => {
      const next = { ...prev };
      if (value === '') delete next[groupId];
      else next[groupId] = Number(value);
      return next;
    });
  };

  /**
   * The reconcile decisions this mapping carries. A `link` rules on ONE issue,
   * so it rides the mapping whose included set holds it; every other ruling is
   * about the cyboflow entity alone and rides the project's first mapping. No
   * decision is ever sent twice — the service would apply it twice.
   */
  const reconcileForGroup = (group: TrackerGroup): TrackerReconcileDecision[] => {
    const pid = mappings[group.id];
    const siblings = groupsForProject(pid);
    const out: TrackerReconcileDecision[] = [];
    for (const item of reconcileByProject[pid] ?? []) {
      const key = decisionKey(pid, item);
      const action = decisions[key] ?? 'keep';
      const target = linkTargets[key];
      const owner =
        action === 'link' && target !== undefined
          ? (siblings.find((g) =>
              (includedByGroup[g.id] ?? []).some((i) => i.externalId === target),
            ) ?? siblings[0])
          : siblings[0];
      if (owner.id !== group.id) continue;
      if (action !== 'link' || target === undefined) {
        out.push({ entityType: item.entityType, entityId: item.entityId, action });
        continue;
      }
      // Carry the ref chip along with the id — the service persists these on
      // the link row and nothing back-fills them after connect.
      const issue = allIssues.find((i) => i.externalId === target);
      out.push({
        entityType: item.entityType,
        entityId: item.entityId,
        action,
        linkExternalId: target,
        linkIdentifier: issue?.identifier,
        linkUrl: issue?.url,
      });
    }
    return out;
  };

  /**
   * Apply the run: staged UNLINKS first, then the connects, each one at a time.
   *
   * The order is load-bearing. A disconnect retires the old row's claim on its
   * issues — `findSiblingLinkForExternal` ignores disconnected connections — so
   * unlinking before connecting is what lets the same scope land in a new
   * project with a full fresh import instead of a silent cross-scope skip. It
   * is also how main hands the push target on: `disconnect` promotes a
   * surviving sibling, and the connect that follows claims from a clean slate.
   *
   * A failed disconnect therefore STOPS the connects: the row it should have
   * retired is still live, and connecting over it would import nothing. Retry
   * re-runs the failure first, then everything still pending — `connect` is
   * idempotent, but re-sending a mapping that already succeeded would re-run
   * its reconcile decisions, so those are filtered out.
   */
  const handleSubmit = async (): Promise<void> => {
    const pendingUnlinks = stagedUnlinks.filter((m) => unlinkProgress[m.id]?.status !== 'ok');
    const pendingConnects = mappedGroups.filter((g) => progress[g.id]?.status !== 'ok');
    if (pendingUnlinks.length === 0 && pendingConnects.length === 0) return;

    setSubmitting(true);
    setStepError(null);
    let allOk = true;

    const runUnlink = async (m: TrackerConnectionSummary): Promise<boolean> => {
      setUnlinkProgress((prev) => ({ ...prev, [m.id]: { status: 'connecting', error: null } }));
      try {
        await trpc.cyboflow.tracker.disconnect.mutate({ connectionId: m.id });
        setUnlinkProgress((prev) => ({ ...prev, [m.id]: { status: 'ok', error: null } }));
        return true;
      } catch (err) {
        setUnlinkProgress((prev) => ({
          ...prev,
          [m.id]: { status: 'error', error: errorMessage(err) },
        }));
        return false;
      }
    };

    for (const m of pendingUnlinks) {
      // The carrier's own unlink is the one exception to the order — see
      // `deferredUnlinkId`; it runs after the connects that need its key.
      if (m.id === deferredUnlinkId) continue;
      if (!(await runUnlink(m))) allOk = false;
    }

    if (allOk) {
      for (const group of pendingConnects) {
        const pid = mappings[group.id];
        let selectionJson: TrackerSelectionJson | null = null;
        if (mode === 'assignee') selectionJson = { assigneeIds: selectedAssigneeIds };
        if (mode === 'manual') {
          selectionJson = { issueIds: (includedByGroup[group.id] ?? []).map((i) => i.externalId) };
        }
        setProgress((prev) => ({ ...prev, [group.id]: { status: 'connecting', error: null } }));
        try {
          await trpc.cyboflow.tracker.connect.mutate({
            projectId: pid,
            // Exactly one credential source, same rule as the probes: the pasted
            // key, the connection whose stored key main resolves on its side,
            // or — in workspace-row mode — the row's own credentials. `pid` IS
            // that row's project there, since a row can only map to itself.
            ...(credentialCarrierId !== undefined
              ? { sourceConnectionId: credentialCarrierId }
              : { credentials: workspaceRowMode ? rowCredentials(pid) : credentials }),
            source: group.selection,
            sourceLabel: group.sourceLabel,
            selectionMode: mode,
            selectionJson,
            stateMapping: mappingByScope[group.stateScopeKey] ?? {},
            statusSyncMode,
            pullMode,
            pushMode,
            contentSyncMode,
            archiveSyncMode,
            // Always sent once fetched (Step 3 gates every forward path
            // through ensureFieldOptions, so this is non-null by Review) —
            // the seed's own table when the user never touched a picker.
            ...(priorityMapping !== null ? { priorityMapping: { toProvider: priorityMapping } } : {}),
            // Omitted entirely for a provider with no category concept: no
            // table rendered, and an overlay would be silently dropped
            // server-side anyway (categoryMapping.ts's provider gate).
            ...(meta.supportsCategorySync && categoryMapping !== null
              ? { categoryMapping: { toProvider: categoryMapping } }
              : {}),
            mirrorSubissues,
            conflictMode,
            reconcile: reconcileForGroup(group),
            pushTarget: pushGroupIdFor(pid) === group.id,
          });
          setProgress((prev) => ({ ...prev, [group.id]: { status: 'ok', error: null } }));
        } catch (err) {
          allOk = false;
          setProgress((prev) => ({
            ...prev,
            [group.id]: { status: 'error', error: errorMessage(err) },
          }));
        }
      }
    }

    if (allOk && deferredUnlinkId !== null) {
      const deferred = pendingUnlinks.find((m) => m.id === deferredUnlinkId);
      if (deferred !== undefined && !(await runUnlink(deferred))) allOk = false;
    }

    setSubmitting(false);
    if (allOk) {
      onConnected();
      onClose();
    }
  };

  // -------------------------------------------------------------------------
  // Step bodies
  // -------------------------------------------------------------------------

  /**
   * Step 0, and it is a KEYED step by construction: the only provider with
   * nothing to paste is workspace-bound, and `firstStep` drops this step
   * entirely for those — a workspace-bound run authorizes per row on the Map
   * step instead. So nothing here branches on `needsApiKey`.
   */
  const renderConnect = (): React.JSX.Element => (
    <div className="flex flex-col items-center gap-4 text-center">
      <ProviderTile mark={meta.mark} size="lg" />
      <Eyebrow>{STEP_EYEBROWS[0]}</Eyebrow>
      <h3 className="text-lg font-bold text-text-primary">Connect {meta.name}</h3>
      <p className="max-w-[430px] text-xs leading-relaxed text-text-secondary">
        Paste a {meta.apiKeyLabel.toLowerCase()}. Cyboflow validates it against {meta.name} before
        anything is stored, and the key never leaves this machine.
      </p>

      <div className={cn(CARD, 'w-full max-w-[440px] space-y-3 p-4 text-left')}>
        {meta.needsApiKey && (
          <label className="block">
            <Eyebrow className="mb-1.5">{meta.apiKeyLabel}</Eyebrow>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="paste your key"
              aria-label={meta.apiKeyLabel}
              className={trackerInputClass}
            />
            <p className="mt-1 text-[11px] text-text-tertiary">{meta.apiKeyHint}</p>
          </label>
        )}

        {meta.needsWorkspaceSlug && (
          <label className="block">
            <Eyebrow className="mb-1.5">Workspace slug</Eyebrow>
            <input
              type="text"
              value={workspaceSlug}
              onChange={(e) => setWorkspaceSlug(e.target.value)}
              placeholder="acme"
              aria-label="Workspace slug"
              className={trackerInputClass}
            />
          </label>
        )}

        {meta.defaultBaseUrl !== null && (
          <label className="block">
            <Eyebrow className="mb-1.5">Instance URL</Eyebrow>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={meta.defaultBaseUrl}
              aria-label="Instance URL"
              className={trackerInputClass}
            />
            <p className="mt-1 text-[11px] text-text-tertiary">
              Leave the default unless you self-host {meta.name}.
            </p>
          </label>
        )}
      </div>

      <div className={cn(CARD, 'w-full max-w-[440px] p-4 text-left')}>
        <Eyebrow className="mb-2 border-b border-dashed border-border-primary pb-2">
          What cyboflow uses
        </Eyebrow>
        <ul className="space-y-1.5">
          {meta.scopes.map((scope) => (
            <li key={scope.label} className="flex items-center gap-2 text-xs text-text-primary">
              <Check className="h-3.5 w-3.5 flex-shrink-0 text-status-success" />
              <span className="lowercase">{scope.label}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-text-tertiary">{meta.scopeFootnote}</p>
      </div>

      {identity === null ? (
        <div className="flex flex-col items-center gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="rounded-none"
            disabled={apiKey.trim().length === 0 || validating}
            loading={validating}
            loadingText={`Checking with ${meta.name}…`}
            onClick={() => void handleAuthorize()}
          >
            Authorize
          </Button>
          {authError !== null && (
            <div className="max-w-[440px] space-y-1.5 text-left" role="alert">
              <p className="text-xs text-status-error">{authError}</p>
            </div>
          )}
        </div>
      ) : (
        <div
          className="w-full max-w-[440px] rounded-none border border-status-success bg-surface-primary p-4 text-left"
          data-testid="tracker-authorized-card"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-status-success">
              <Check className="h-3.5 w-3.5 text-text-on-status-success" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">
                Authorized as {identity.actorLabel}
              </p>
              <p className="mt-0.5 text-xs text-text-secondary">
                workspace {identity.workspaceName}
              </p>
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="rounded-none"
              loading={loading}
              onClick={() => void goToStep(1)}
            >
              Continue
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  /**
   * The right-hand controls of ONE workspace row — everything that depends on
   * what that project's repository answered.
   */
  const renderWorkspaceRowControls = (project: Project): React.JSX.Element | null => {
    const pid = project.id;
    const row = rowStates[pid];
    const action = rowActions[pid];
    const busy = action !== undefined;

    // The catalog already knows this one; it was never probed.
    if (connectedProjectIds.includes(pid)) {
      return (
        <span
          className="rounded-none bg-surface-secondary px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em] text-text-tertiary"
          data-testid={`tracker-row-connected-${pid}`}
        >
          Connected
        </span>
      );
    }

    if (row === undefined || row.status === 'probing') {
      return <span className="text-[11px] text-text-tertiary">Checking…</span>;
    }

    // The binary is machine-wide: the one banner above the list says so, and a
    // per-row control would offer a fix this row cannot apply.
    if (row.status === 'missing-cli') return null;

    const detect = (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="rounded-none"
        data-testid={`tracker-row-detect-${pid}`}
        disabled={busy}
        onClick={() => void probeRow(pid)}
      >
        Detect
      </Button>
    );

    if (row.status === 'detected') {
      return (
        <>
          {row.group.key !== null && (
            <span className="rounded-none bg-surface-secondary px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em] text-text-tertiary">
              {row.group.key}
            </span>
          )}
          {/* The target is FIXED to this row's own project — a workspace bound
              to one repository has no business feeding another. */}
          <select
            aria-label={`Sync the ${meta.name.toLowerCase()} workspace in ${project.name}`}
            data-testid={`tracker-row-sync-${pid}`}
            value={mappings[row.group.id] === undefined ? '' : String(mappings[row.group.id])}
            onChange={(e) => handleMap(row.group.id, e.target.value)}
            className={cn(trackerSelectClass, 'max-w-[220px]')}
          >
            <option value={String(pid)}>Sync into {project.name}</option>
            <option value="">Don&apos;t sync</option>
          </select>
        </>
      );
    }

    // 'error' — a lock timeout, an unreadable metadata file, a version below the
    // floor. The message is on the row already; only re-probing can move it.
    if (row.status === 'error') return detect;

    // 'missing' — the one failure `bd init` fixes. Initialize leads, Detect is
    // the re-check after fixing it by hand, and the picker is the exception:
    // the workspace is real but not at the project's root.
    return (
      <>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="rounded-none"
          data-testid={`tracker-row-init-${pid}`}
          disabled={busy}
          loading={action === 'initializing'}
          loadingText="Initializing…"
          onClick={() => void handleRowInit(pid)}
        >
          Initialize
        </Button>
        {detect}
        <button
          type="button"
          className="text-[11px] text-text-tertiary underline hover:text-text-secondary disabled:no-underline"
          data-testid={`tracker-row-pick-${pid}`}
          disabled={busy}
          onClick={() => void handleRowPick(pid)}
        >
          {action === 'picking' ? 'Choosing a folder…' : 'Point at a folder…'}
        </button>
      </>
    );
  };

  /** One project's row: what is being checked on the left, what it found on the right. */
  const renderWorkspaceRow = (project: Project): React.JSX.Element => {
    const pid = project.id;
    const row = rowStates[pid];
    const dir = rowDirs[pid];
    const rowError = rowErrors[pid];

    return (
      <div
        key={pid}
        className={cn(CARD, 'flex items-start gap-3 px-3 py-2')}
        data-testid={`tracker-workspace-row-${pid}`}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-bold text-text-primary">{project.name}</p>
          {/* WHICH FOLDER, said out loud — the commonest failure is a repository
              the user was not thinking about. Display text only: main resolves
              the directory it actually spawns in from the id or the token. */}
          <p className="truncate text-[11px] text-text-tertiary">
            {dir === undefined ? project.path : dir.path}
            {dir !== undefined && (
              <>
                {' · '}
                <button
                  type="button"
                  className="underline hover:text-text-secondary"
                  data-testid={`tracker-row-use-repo-${pid}`}
                  onClick={() => handleRowUseRepo(pid)}
                >
                  use the repo folder
                </button>
              </>
            )}
          </p>
          {row !== undefined && row.status === 'error' && (
            <p className="mt-1 text-[11px] text-status-error">{row.error}</p>
          )}
          {rowError !== undefined && (
            <p role="alert" className="mt-1 text-[11px] text-status-error">
              {rowError}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {renderWorkspaceRowControls(project)}
        </div>
      </div>
    );
  };

  /**
   * The workspace-bound Map step: one row per cyboflow project, each answering
   * for its own repository, in place of a single account's group list.
   */
  const renderWorkspaceRows = (): React.JSX.Element => {
    let missingCliMessage: string | null = null;
    let anyMissing = false;
    for (const project of orderedProjects) {
      const row = rowStates[project.id];
      if (row === undefined) continue;
      if (row.status === 'missing-cli' && missingCliMessage === null) missingCliMessage = row.error;
      if (row.status === 'missing') anyMissing = true;
    }

    return (
      <div className="space-y-3">
        {/* One fact about the MACHINE, not N facts about N repositories. */}
        {missingCliMessage !== null && (
          <p
            role="alert"
            className={cn(CARD, 'px-3 py-2 text-xs text-status-error')}
            data-testid="tracker-missing-cli"
          >
            {missingCliMessage}
          </p>
        )}

        <div className="space-y-1.5">{orderedProjects.map(renderWorkspaceRow)}</div>

        {/* The caption for every Initialize button above: what the offer does to
            a repository the user may be sharing, said once. */}
        {anyMissing &&
          BEADS_INIT_DISCLOSURE.map((line) => (
            <p key={line} className="text-[11px] leading-relaxed text-text-tertiary">
              {line}
            </p>
          ))}
      </div>
    );
  };

  const renderMap = (): React.JSX.Element => (
    <div className="space-y-5">
      <div>
        <Eyebrow>{STEP_EYEBROWS[1]}</Eyebrow>
        <h3 className="mt-1.5 text-lg font-bold text-text-primary">
          Map {meta.name} onto cyboflow projects
        </h3>
        <p className="mt-1.5 max-w-[560px] text-xs leading-relaxed text-text-secondary">
          {workspaceRowMode ? (
            <>
              Each project&rsquo;s repository is checked for a {meta.name.toLowerCase()} workspace.
              Choose which ones to sync — or initialize one where none exists.
            </>
          ) : meta.workspaceBound ? (
            <>
              This workspace is bound to the folder it was detected in. Choose whether to sync it
              into this project.
            </>
          ) : (
            <>
              Every mapped group becomes its own connection. Several groups can feed the same
              cyboflow project; anything left on “Don&apos;t import” is ignored entirely.
            </>
          )}
        </p>
        {sourceConnection !== undefined && (
          <p className="mt-1.5 max-w-[560px] text-xs leading-relaxed text-text-tertiary">
            What this connection already covers is listed first. Unlink one to stop syncing it —
            that runs when this wizard finishes, and the group drops into the list below, free to
            map somewhere else.
          </p>
        )}
      </div>

      {overlapWarnings.map((warning) => (
        <p key={warning} className="text-xs text-status-warning">
          {warning}
        </p>
      ))}

      {sourceConnection !== undefined && liveMappings.length > 0 && (
        <div data-testid="tracker-linked-section">
          <Eyebrow className="mb-2">Linked</Eyebrow>
          <div className="space-y-1.5">
            {liveMappings.map((sibling) => (
              <div
                key={sibling.id}
                className={cn(CARD, 'flex items-center gap-3 px-3 py-2')}
                data-testid={`tracker-linked-${sibling.id}`}
              >
                <span className="min-w-0 truncate text-xs font-bold text-text-primary">
                  {siblingLabel(sibling)} → {projectName(sibling.projectId)}
                </span>
                {sibling.pushTarget && (
                  <span className="flex-shrink-0 rounded-none bg-surface-secondary px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em] text-text-tertiary">
                    Pushes
                  </span>
                )}
                {sibling.status === 'paused' && (
                  <span className="flex-shrink-0 rounded-none border border-border-primary px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em] text-text-tertiary">
                    Paused
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto rounded-none"
                  data-testid={`tracker-unlink-${sibling.id}`}
                  onClick={() => stageUnlink(sibling.id)}
                >
                  Unlink
                </Button>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-text-tertiary">
            Nothing is disconnected yet — unlinking is applied when this run finishes, and closing
            the wizard forgets it.
          </p>
        </div>
      )}

      {sourceConnection !== undefined && availableGroups(allGroups).length > 0 && (
        <Eyebrow>Available to map</Eyebrow>
      )}

      {workspaceRowMode && renderWorkspaceRows()}

      {/* Empty in workspace-row mode by construction — `groupTree` is the
          FETCHED tree, and that mode never fetches one. */}
      {(groupTree?.sections ?? []).map((section) => {
        // Add-mapping mode lists only what is still free: a covered scope has a
        // linked row above instead, so one group cannot be pointed at two
        // projects from here.
        const rows = availableGroups(section.groups);
        if (section.groups.length > 0 && rows.length === 0) return null;
        return (
          <div key={section.label}>
            <Eyebrow className="mb-2">{section.label}</Eyebrow>
            <div className="space-y-1.5">
              {rows.map((group) => (
                <div
                  key={group.id}
                  className={cn(CARD, 'flex items-center gap-3 px-3 py-2')}
                  data-testid={`tracker-group-${group.id}`}
                >
                  {group.key !== null && (
                    <span className="rounded-none bg-surface-secondary px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em] text-text-tertiary">
                      {group.key}
                    </span>
                  )}
                  <span className="min-w-0 truncate text-xs font-bold text-text-primary">
                    {group.name}
                  </span>
                  {meta.workspaceBound ? (
                    // One workspace, anchored to the probed folder — the only
                    // real choice is whether it feeds the wizard's own project.
                    <select
                      aria-label={`Sync ${group.name} into this project`}
                      value={mappings[group.id] === undefined ? '' : String(mappings[group.id])}
                      onChange={(e) => handleMap(group.id, e.target.value)}
                      className={cn(trackerSelectClass, 'ml-auto max-w-[240px]')}
                    >
                      <option value={String(projectId)}>Sync into {projectName(projectId)}</option>
                      <option value="">Don&apos;t sync</option>
                    </select>
                  ) : (
                    <select
                      aria-label={`Cyboflow project for ${group.name}`}
                      value={mappings[group.id] === undefined ? '' : String(mappings[group.id])}
                      onChange={(e) => handleMap(group.id, e.target.value)}
                      className={cn(trackerSelectClass, 'ml-auto max-w-[240px]')}
                    >
                      <option value="">— Don&apos;t import</option>
                      {projects.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.id === projectId ? `${p.name} (Active)` : p.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
              {section.groups.length === 0 && (
                <p className={cn(CARD, 'px-3 py-4 text-xs text-text-tertiary')}>
                  {meta.name} returned nothing in this section.
                </p>
              )}
            </div>
          </div>
        );
      })}

      {sourceConnection !== undefined &&
        groupTree !== null &&
        allGroups.length > 0 &&
        availableGroups(allGroups).length === 0 && (
          <p className={cn(CARD, 'px-3 py-4 text-xs text-text-tertiary')}>
            Every group this authorization offers is already linked. Unlink one above to map it
            somewhere else.
          </p>
        )}

      {projects.length === 0 && (
        <p className={cn(CARD, 'px-3 py-4 text-xs text-text-tertiary')}>
          Project list unavailable — nothing can be mapped until it loads.
        </p>
      )}

      {/* No tree and no fetch in flight: the probe failed and nothing else can
          re-run it from here. Keyed off the missing tree rather than the step
          error, which a rail click clears while the step stays empty. Never in
          workspace-row mode: a null `groupTree` is that mode's steady state, and
          each row carries its own Detect. */}
      {!workspaceRowMode && groupTree === null && !loading && (
        <div
          className={cn(CARD, 'flex items-center justify-between gap-3 px-3 py-4')}
          data-testid="tracker-groups-retry"
        >
          <p className="text-xs text-text-tertiary">{meta.name} did not return its groups.</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-none"
            onClick={() => void retryGroups()}
          >
            Retry
          </Button>
        </div>
      )}

      {/* A project whose pusher is a live mapping outside this run: no radio is
          offered, so say who keeps filing instead of implying the run decides. */}
      {pushIncumbents.map(({ projectId: pid, sibling }) => (
        <p
          key={pid}
          className={cn(CARD, 'px-3 py-2 text-xs text-text-tertiary')}
          data-testid={`tracker-push-incumbent-${pid}`}
        >
          New cyboflow ideas in {projectName(pid)} keep pushing through {sibling.sourceLabel}.
          Change that under Project mappings.
        </p>
      ))}

      {pushClusters.map((cluster) => (
        <fieldset key={cluster.projectId} className={cn(CARD, 'p-3')}>
          <legend className="px-1 text-[10px] font-bold uppercase tracking-[0.18em] text-text-tertiary">
            New cyboflow ideas in {projectName(cluster.projectId)} push to:
          </legend>
          <div className="mt-1.5 space-y-1.5">
            {cluster.groups.map((group) => (
              <label
                key={group.id}
                className="flex items-center gap-2 text-xs text-text-primary"
              >
                <input
                  type="radio"
                  name={`push-target-${cluster.projectId}`}
                  checked={pushGroupIdFor(cluster.projectId) === group.id}
                  onChange={() =>
                    setPushChoice((prev) => ({ ...prev, [cluster.projectId]: group.id }))
                  }
                />
                {group.name}
              </label>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-text-tertiary">
            Only one mapping per project creates {meta.name} issues — otherwise a new idea would be
            filed once per mapping.
          </p>
        </fieldset>
      ))}
    </div>
  );

  const renderTasks = (): React.JSX.Element => {
    const hint =
      mode === 'all'
        ? 'Every issue in each mapped group imports, and new ones keep arriving on each sync.'
        : mode === 'assignee'
          ? 'Only issues assigned to the people you pick import.'
          : 'Only the issues you tick import. New issues will not be added automatically.';

    return (
      <div className="space-y-4">
        <div>
          <Eyebrow>{STEP_EYEBROWS[2]}</Eyebrow>
          <h3 className="mt-1.5 text-lg font-bold text-text-primary">Which issues come in?</h3>
          <p className="mt-1.5 text-xs text-text-secondary">
            One rule applies to every mapping.
          </p>
        </div>

        <Segmented
          options={MODE_OPTIONS}
          value={mode}
          onChange={setMode}
          ariaLabel="Issue selection mode"
        />
        <p className="text-xs text-text-secondary">{hint}</p>

        {mode === 'assignee' && (
          <div className="flex flex-wrap gap-2">
            {assigneeOptions.map(({ user, count }) => {
              const on = assignees[user.id] === true;
              return (
                <button
                  key={user.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setAssignees((prev) => ({ ...prev, [user.id]: !on }))}
                  className={cn(
                    'flex items-center gap-2 rounded-none border px-2 py-1 text-[11px] transition-colors duration-[120ms]',
                    on
                      ? 'border-border-emphasized bg-surface-primary text-text-primary'
                      : 'border-border-primary bg-surface-primary text-text-secondary',
                  )}
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-surface-secondary text-[8px] font-bold text-text-secondary">
                    {user.initials}
                  </span>
                  {user.name}
                  <span className="text-text-tertiary">{count}</span>
                  {on && <Check className="h-3 w-3 text-status-success" />}
                </button>
              );
            })}
            {assigneeOptions.length === 0 && (
              <p className="text-xs text-text-tertiary">
                No assignees on the issues in these groups.
              </p>
            )}
          </div>
        )}

        <div className={CARD}>
          <div className="flex items-center justify-between gap-3 border-b border-border-primary bg-surface-secondary px-3 py-2">
            <Eyebrow>{includedIssues.length} issues will sync</Eyebrow>
            {mode === 'manual' && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    setManual(Object.fromEntries(allIssues.map((i) => [i.externalId, true])))
                  }
                  className="text-[10px] font-bold uppercase tracking-[0.12em] text-interactive"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setManual({})}
                  className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-tertiary"
                >
                  Clear
                </button>
              </div>
            )}
          </div>
          {mappedGroups.map((group) => {
            const rows = issuesByGroup[group.id] ?? [];
            return (
              <div key={group.id} data-testid={`tracker-issues-${group.id}`}>
                <div className="border-b border-border-primary bg-surface-secondary px-3 py-1.5">
                  <Eyebrow>
                    {group.name} → {projectName(mappings[group.id])}
                  </Eyebrow>
                </div>
                <ul className="divide-y divide-border-primary">
                  {rows.map((issue) => {
                    const included = includedIds.has(issue.externalId);
                    return (
                      <li key={issue.externalId}>
                        <button
                          type="button"
                          disabled={mode !== 'manual'}
                          aria-pressed={mode === 'manual' ? included : undefined}
                          onClick={() =>
                            setManual((prev) => ({ ...prev, [issue.externalId]: !included }))
                          }
                          className={cn(
                            'flex w-full items-center gap-3 px-3 py-2 text-left',
                            mode === 'manual' && !included && 'opacity-50',
                            mode === 'manual' && 'hover:bg-bg-hover',
                          )}
                        >
                          {mode === 'manual' && (
                            <span
                              className={cn(
                                'flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-none border',
                                included
                                  ? 'border-interactive bg-interactive'
                                  : 'border-border-primary',
                              )}
                            >
                              {included && (
                                <Check className="h-2.5 w-2.5 text-text-on-interactive" />
                              )}
                            </span>
                          )}
                          <span className="w-16 flex-shrink-0 truncate text-[10px] lowercase text-text-tertiary">
                            {issue.identifier}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
                            {issue.title}
                          </span>
                          {issue.estimate !== null && (
                            <span className="w-8 flex-shrink-0 text-right text-[10px] text-text-tertiary">
                              {issue.estimate} pt
                            </span>
                          )}
                          {issue.assignee !== null && (
                            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-surface-secondary text-[8px] font-bold text-text-secondary">
                              {issue.assignee.initials}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                  {rows.length === 0 && (
                    <li className="px-3 py-4 text-xs text-text-tertiary">
                      This group has no open issues.
                    </li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderStates = (): React.JSX.Element => (
    <div className="space-y-4">
      <div>
        <Eyebrow>{STEP_EYEBROWS[3]}</Eyebrow>
        <h3 className="mt-1.5 text-lg font-bold text-text-primary">
          Map {meta.name} states to cyboflow
        </h3>
        <p className="mt-1.5 text-xs text-text-secondary">
          Cyboflow has four states. Anything mapped to “Don’t import” is skipped entirely.
        </p>
      </div>

      {stateScopes.map((scope) => {
        const rows = statesByScope[scope.key] ?? [];
        const scopeMapping = mappingByScope[scope.key] ?? {};
        // Counts come from the issues of the groups sharing this table only.
        const counts: Record<string, number> = {};
        for (const group of scope.groups) {
          for (const issue of issuesByGroup[group.id] ?? []) {
            counts[issue.stateId] = (counts[issue.stateId] ?? 0) + 1;
          }
        }
        return (
          <div key={scope.key} className={CARD} data-testid={`tracker-state-scope-${scope.key}`}>
            {stateScopes.length > 1 && (
              <div className="border-b border-border-primary bg-surface-secondary px-3 py-1.5">
                <Eyebrow>{scope.label}</Eyebrow>
              </div>
            )}
            <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-3 border-b border-border-primary bg-surface-secondary px-3 py-2">
              <Eyebrow>{meta.name} state</Eyebrow>
              <Eyebrow>Cyboflow state</Eyebrow>
            </div>
            <div className="divide-y divide-border-primary">
              {rows.map((state) => {
                // Two scopes can publish states of the same NAME, so the label
                // carries the scope as soon as more than one table is rendered.
                const label =
                  stateScopes.length > 1
                    ? `Cyboflow state for ${state.name} in ${scope.label}`
                    : `Cyboflow state for ${state.name}`;
                return (
                  <div
                    key={state.id}
                    className="grid grid-cols-[minmax(0,1fr)_240px] items-center gap-3 px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 flex-shrink-0 rounded-none bg-text-tertiary"
                        style={state.color !== null ? { backgroundColor: state.color } : undefined}
                      />
                      <span className="truncate text-xs text-text-primary">{state.name}</span>
                      <span className="text-[10px] text-text-tertiary">
                        {counts[state.id] ?? 0}
                      </span>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1">
                      <select
                        aria-label={label}
                        value={scopeMapping[state.id] ?? 'dont'}
                        onChange={(e) =>
                          setMappingByScope((prev) => ({
                            ...prev,
                            [scope.key]: {
                              ...(prev[scope.key] ?? {}),
                              // The <select> value is always one of MAPPING_TARGETS,
                              // so the cast stays inside the TrackerMappingTarget union.
                              [state.id]: e.target.value as TrackerStateMapping[string],
                            },
                          }))
                        }
                        className={cn(trackerSelectClass, 'w-full')}
                      >
                        {MAPPING_TARGETS.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                      {(() => {
                        const note = mappingTargetNote(scopeMapping[state.id] ?? 'dont', meta.name);
                        return note === null ? null : (
                          <span className="text-[10px] leading-tight text-text-tertiary">
                            {note}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}
              {rows.length === 0 && (
                <p className="px-3 py-4 text-xs text-text-tertiary">
                  {meta.name} returned no workflow states for this scope.
                </p>
              )}
            </div>
          </div>
        );
      })}

      <div className={CARD} data-testid="tracker-priority-mapping">
        <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-3 border-b border-border-primary bg-surface-secondary px-3 py-2">
          <Eyebrow>Cyboflow priority</Eyebrow>
          <Eyebrow>{meta.name} priority</Eyebrow>
        </div>
        <div className="divide-y divide-border-primary">
          {PRIORITY_LEVELS.map((level) => (
            <div
              key={level}
              className="grid grid-cols-[minmax(0,1fr)_240px] items-center gap-3 px-3 py-2"
            >
              <span className="text-xs text-text-primary">{level}</span>
              <select
                aria-label={`${meta.name} priority for ${level}`}
                value={priorityMapping?.[level] ?? ''}
                onChange={(e) => {
                  const next = e.target.value === '' ? null : e.target.value;
                  setPriorityMapping((prev) => ({
                    ...(prev ?? ({} as Record<Priority, string | null>)),
                    [level]: next,
                  }));
                }}
                className={cn(trackerSelectClass, 'w-full')}
              >
                <option value="">— Not sent</option>
                {(fieldOptions?.priorities ?? []).map((token) => (
                  <option key={token} value={token}>
                    {token}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      {meta.supportsCategorySync ? (
        <div className={CARD} data-testid="tracker-category-mapping">
          <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-3 border-b border-border-primary bg-surface-secondary px-3 py-2">
            <Eyebrow>Cyboflow category</Eyebrow>
            <Eyebrow>{meta.name} type</Eyebrow>
          </div>
          <div className="divide-y divide-border-primary">
            {ENTITY_CATEGORIES.map((category) => (
              <div
                key={category}
                className="grid grid-cols-[minmax(0,1fr)_240px] items-center gap-3 px-3 py-2"
              >
                <span className="text-xs capitalize text-text-primary">{category}</span>
                <select
                  aria-label={`${meta.name} type for ${category}`}
                  value={categoryMapping?.[category] ?? ''}
                  onChange={(e) => {
                    const next = e.target.value === '' ? null : e.target.value;
                    setCategoryMapping((prev) => ({
                      ...(prev ?? ({} as Record<EntityCategory, string | null>)),
                      [category]: next,
                    }));
                  }}
                  className={cn(trackerSelectClass, 'w-full')}
                >
                  <option value="">— Not sent</option>
                  {(fieldOptions?.categories ?? []).map((token) => (
                    <option key={token} value={token}>
                      {token}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-text-tertiary" data-testid="tracker-category-unsupported">
          {meta.name} has no issue type — category stays local.
        </p>
      )}

      <div className={cn(CARD, 'p-3')}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary">Sync task status</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              Status changes on linked items flow both ways.
            </p>
          </div>
          <Segmented
            options={GATED_MODE_OPTIONS}
            value={statusSyncMode}
            onChange={setStatusSyncMode}
            ariaLabel="Sync task status"
          />
        </div>

        <ul className="mt-3 space-y-1 border border-border-primary bg-surface-secondary p-3 text-[11px] text-text-secondary">
          <li>Ready for development → nothing (readiness is not started)</li>
          <li>In development → the {meta.name} started state</li>
          <li>Done → the {meta.name} done state</li>
          <li>Won’t do → the {meta.name} cancelled state</li>
        </ul>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-primary pt-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary">Pull from {meta.name}</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              New {meta.name} issues import as cyboflow ideas.
            </p>
          </div>
          <Segmented
            options={DIRECTION_OPTIONS}
            value={pullMode}
            onChange={setPullMode}
            ariaLabel={`Pull from ${meta.name}`}
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-primary pt-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary">Push to {meta.name}</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              New cyboflow ideas are created as {meta.name} issues.
            </p>
          </div>
          <Segmented
            options={DIRECTION_OPTIONS}
            value={pushMode}
            onChange={setPushMode}
            ariaLabel={`Push to ${meta.name}`}
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-primary pt-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary">Sync task fields</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              Title, description, priority{meta.supportsCategorySync ? ', and category' : ''} push
              out to {meta.name}.
            </p>
          </div>
          <Segmented
            options={GATED_MODE_OPTIONS}
            value={contentSyncMode}
            onChange={setContentSyncMode}
            ariaLabel="Sync task fields"
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-primary pt-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary">Archive in {meta.name}</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              A local archive or delete trashes the linked issue — never a hard delete.
            </p>
          </div>
          <Segmented
            options={GATED_MODE_OPTIONS}
            value={archiveSyncMode}
            onChange={setArchiveSyncMode}
            ariaLabel={`Archive in ${meta.name}`}
          />
        </div>

        <div className="mt-3 flex items-start gap-3 border-t border-border-primary pt-3">
          <PillToggle
            checked={mirrorSubissues}
            onChange={setMirrorSubissues}
            label="Mirror task breakdowns as sub-issues"
          />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary">
              Mirror task breakdowns as sub-issues
            </p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              When the planner decomposes an imported idea, each task is created as a sub-issue
              and reports its own status back.
            </p>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-primary pt-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-text-primary">When both sides changed</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              Auto-resolve merges field by field; Manual review queues each conflict for you.
            </p>
          </div>
          <Segmented
            options={CONFLICT_OPTIONS}
            value={conflictMode}
            onChange={setConflictMode}
            ariaLabel="Conflict mode"
          />
        </div>

        <p className="mt-3 border-t border-dashed border-border-primary pt-3 text-[11px] text-text-tertiary">
          Manual directions wait for you to press “Sync now”.
        </p>
      </div>
    </div>
  );

  const renderReconcile = (): React.JSX.Element => {
    const setAll = (action: ReconcileAction): void => {
      setDecisions(
        Object.fromEntries(decidedRows.map((row) => [decisionKey(row.projectId, row.item), action])),
      );
    };

    return (
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Eyebrow>{STEP_EYEBROWS[4]}</Eyebrow>
            <h3 className="mt-1.5 text-lg font-bold text-text-primary">
              Your existing cyboflow backlog
            </h3>
          </div>
          <div className="flex flex-shrink-0 rounded-none border border-border-primary">
            <button
              type="button"
              onClick={() => setAll('keep')}
              className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary hover:text-text-primary"
            >
              Keep all
            </button>
            <button
              type="button"
              onClick={() => setAll('discard')}
              className="border-l border-border-primary px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary hover:text-text-primary"
            >
              Discard all
            </button>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-text-secondary">
          You have {decidedRows.length} items in cyboflow&apos;s backlog from before this
          connection. Decide what happens to each. <strong>Link</strong> merges an item into a
          matching {meta.name} issue so it is not tracked twice.
        </p>

        {targetProjectIds.map((pid) => {
          const rows = reconcileByProject[pid] ?? [];
          const choices = includedForProject(pid);
          return (
            <div key={pid} className={CARD} data-testid={`tracker-reconcile-${pid}`}>
              <div className="border-b border-border-primary bg-surface-secondary px-3 py-1.5">
                <Eyebrow>{projectName(pid)}</Eyebrow>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_260px] gap-3 border-b border-border-primary bg-surface-secondary px-3 py-2">
                <Eyebrow>Cyboflow backlog item</Eyebrow>
                <Eyebrow>Action</Eyebrow>
              </div>
              <div className="divide-y divide-border-primary">
                {rows.map((item) => {
                  const key = decisionKey(pid, item);
                  const action = decisions[key] ?? 'keep';
                  const suggestion =
                    item.suggestedExternalId === null
                      ? null
                      : (choices.find((i) => i.externalId === item.suggestedExternalId) ?? null);
                  return (
                    <div
                      key={key}
                      className={cn(
                        'grid grid-cols-[minmax(0,1fr)_260px] items-center gap-3 px-3 py-2',
                        action === 'discard' && 'bg-surface-secondary opacity-60',
                      )}
                    >
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[10px] lowercase text-text-tertiary">
                            {item.ref}
                          </span>
                          <span className="truncate text-xs font-semibold text-text-primary">
                            {item.title}
                          </span>
                        </div>
                        {action === 'link' ? (
                          <div className="mt-1.5 flex items-center gap-2">
                            <Eyebrow className="flex-shrink-0">Merge into</Eyebrow>
                            <select
                              aria-label={`Merge ${item.ref} into`}
                              value={linkTargets[key] ?? ''}
                              onChange={(e) =>
                                setLinkTargets((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              className={cn(trackerSelectClass, 'min-w-0 flex-1')}
                            >
                              {choices.map((issue) => (
                                <option key={issue.externalId} value={issue.externalId}>
                                  {issue.identifier} · {issue.title}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          suggestion !== null && (
                            <p className="mt-1 truncate text-[11px] text-interactive">
                              likely match · {suggestion.identifier} · {suggestion.title}
                            </p>
                          )
                        )}
                      </div>
                      <Segmented
                        options={RECONCILE_OPTIONS}
                        value={action}
                        ariaLabel={`Action for ${item.ref}`}
                        onChange={(next) => {
                          setDecisions((prev) => ({ ...prev, [key]: next }));
                          if (next === 'link') {
                            setLinkTargets((prev) =>
                              prev[key] !== undefined
                                ? prev
                                : {
                                    ...prev,
                                    [key]:
                                      item.suggestedExternalId ?? choices[0]?.externalId ?? '',
                                  },
                            );
                          }
                        }}
                      />
                    </div>
                  );
                })}
                {rows.length === 0 && (
                  <p className="px-3 py-4 text-xs text-text-tertiary">
                    Nothing was in this project&apos;s backlog before the connection.
                  </p>
                )}
              </div>
            </div>
          );
        })}

        <p className="text-[11px] text-text-tertiary">
          <span className="text-status-success">{tally.keep} kept</span> ·{' '}
          <span className="text-interactive">{tally.link} linked</span> · {tally.discard} discarded
        </p>
      </div>
    );
  };

  const renderReview = (): React.JSX.Element => {
    const selectionDetail =
      mode === 'all'
        ? 'Every issue in each mapped group'
        : mode === 'assignee'
          ? `${selectedAssigneeIds.length} assignees`
          : `${includedIssues.length} hand-picked issues`;

    const cards: { label: string; value: string; detail: string }[] = [];

    if (stagedUnlinks.length > 0) {
      cards.push({
        label: 'Unlinking',
        value: `${stagedUnlinks.length} mapping${stagedUnlinks.length === 1 ? '' : 's'}`,
        detail: 'Disconnected first, before anything else runs',
      });
    }

    // An unlink-only run never visited Tasks, States or Reconcile, so the cards
    // describing those answers would be reporting on nothing.
    if (mappedGroups.length > 0) {
      cards.push(
        {
          label: 'Mappings',
          value: `${mappedGroups.length} → ${targetProjectIds.length} cyboflow projects`,
          detail: 'Each mapping is its own connection',
        },
        {
          label: 'Selection',
          value: MODE_OPTIONS.find((m) => m.value === mode)?.label ?? mode,
          detail: selectionDetail,
        },
        {
          label: 'Direction',
          value: `Status ${gatedModeLabel(statusSyncMode)} · Pull ${directionLabel(pullMode)} · Push ${directionLabel(pushMode)}`,
          detail: `${mirrorSubissues ? 'Sub-issue mirroring on' : 'Sub-issue mirroring off'} · conflicts ${
            conflictMode === 'auto' ? 'auto-resolve' : 'queue for review'
          }`,
        },
        {
          label: 'Mapping',
          value: `${mappedStates.length - skippedStates.length} of ${mappedStates.length} states mapped`,
          detail:
            skippedStates.length === 0
              ? 'Nothing skipped'
              : `Skipped: ${skippedStates.map((s) => s.name).join(', ')}`,
        },
      );
    }

    // Add-mapping mode never showed an "Authorized as …" card, so the identity
    // these connections inherit is stated here instead of left implicit.
    if (sourceConnection !== undefined && shownIdentity !== null) {
      cards.push({
        label: 'Authorization',
        value: shownIdentity.workspaceName,
        detail: `Reusing the key authorized as ${shownIdentity.actorLabel}`,
      });
    }

    return (
      <div className="space-y-4">
        <div>
          <Eyebrow>{STEP_EYEBROWS[5]}</Eyebrow>
          <h3 className="mt-1.5 text-lg font-bold text-text-primary">
            {unlinkOnly ? 'Review the unlinks' : 'Review the connections'}
          </h3>
          <p className="mt-1.5 text-xs text-text-secondary">
            {unlinkOnly ? (
              <>
                Nothing new imports — this run only unlinks, and those mappings stop syncing as
                soon as it finishes. What they already imported stays in cyboflow.
              </>
            ) : (
              <>
                {includedIssues.length} issues will import as ideas now. Ongoing changes sync every
                5 minutes.
              </>
            )}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {cards.map((card) => (
            <div key={card.label} className={cn(CARD, 'p-3')}>
              <Eyebrow>{card.label}</Eyebrow>
              <p className="mt-1.5 text-xs font-semibold text-text-primary">{card.value}</p>
              <p className="mt-0.5 text-[11px] text-text-tertiary">{card.detail}</p>
            </div>
          ))}
        </div>

        {stagedUnlinks.length > 0 && (
          <div className={CARD} data-testid="tracker-unlink-list">
            <div className="border-b border-border-primary bg-surface-secondary px-3 py-2">
              <Eyebrow>Unlink first</Eyebrow>
            </div>
            <div className="divide-y divide-border-primary">
              {stagedUnlinks.map((sibling) => {
                const row = unlinkProgress[sibling.id];
                return (
                  <div
                    key={sibling.id}
                    className="flex items-center gap-3 px-3 py-2"
                    data-testid={`tracker-unlink-row-${sibling.id}`}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
                      Unlink {siblingLabel(sibling)} from {projectName(sibling.projectId)}
                    </span>
                    <span
                      className={cn(
                        'flex-shrink-0 text-[11px]',
                        row?.status === 'ok' && 'text-status-success',
                        row?.status === 'error' && 'text-status-error',
                        (row === undefined || row.status === 'connecting') && 'text-text-tertiary',
                      )}
                    >
                      {row === undefined
                        ? 'Pending'
                        : row.status === 'connecting'
                          ? 'Unlinking…'
                          : row.status === 'ok'
                            ? 'Unlinked'
                            : (row.error ?? 'Failed')}
                    </span>
                  </div>
                );
              })}
            </div>
            {deferredUnlinkId !== null && (
              <p className="border-t border-dashed border-border-primary px-3 py-2 text-[11px] text-text-tertiary">
                {siblingLabel(stagedUnlinks.find((m) => m.id === deferredUnlinkId) ?? stagedUnlinks[0])}{' '}
                is unlinked last — its stored key is what authorizes the new mappings. Issues it
                still holds may take one sync pass to arrive under their new project.
              </p>
            )}
          </div>
        )}

        {mappedGroups.length > 0 && (
        <div className={CARD}>
          <div className="border-b border-border-primary bg-surface-secondary px-3 py-2">
            <Eyebrow>Connections to create</Eyebrow>
          </div>
          <div className="divide-y divide-border-primary">
            {mappedGroups.map((group) => {
              const pid = mappings[group.id];
              const row = progress[group.id];
              return (
                <div
                  key={group.id}
                  className="flex items-center gap-3 px-3 py-2"
                  data-testid={`tracker-mapping-${group.id}`}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
                    {group.sourceLabel} → {projectName(pid)}
                  </span>
                  {pushGroupIdFor(pid) === group.id && (
                    <span className="flex-shrink-0 rounded-none bg-surface-secondary px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em] text-text-tertiary">
                      Push target
                    </span>
                  )}
                  <span
                    className={cn(
                      'flex-shrink-0 text-[11px]',
                      row?.status === 'ok' && 'text-status-success',
                      row?.status === 'error' && 'text-status-error',
                      (row === undefined || row.status === 'connecting') && 'text-text-tertiary',
                    )}
                  >
                    {row === undefined
                      ? 'Pending'
                      : row.status === 'connecting'
                        ? 'Connecting…'
                        : row.status === 'ok'
                          ? 'Connected'
                          : (row.error ?? 'Failed')}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        )}

        {mappedGroups.length > 0 && (
          <div className={cn(CARD, 'p-3')}>
            <Eyebrow>Existing backlog</Eyebrow>
            <p className="mt-1.5 text-xs text-text-primary">
              {tally.keep} kept in cyboflow · {tally.link} linked to {meta.name} · {tally.discard}{' '}
              discarded
            </p>
          </div>
        )}

        <div className="flex justify-end">
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="rounded-none"
            loading={submitting}
            loadingText={unlinkOnly ? 'Unlinking…' : 'Connecting…'}
            onClick={() => void handleSubmit()}
          >
            {failedCount > 0
              ? `Retry ${failedCount} failed`
              : unlinkOnly
                ? `Unlink ${stagedUnlinks.length} mapping${stagedUnlinks.length === 1 ? '' : 's'}`
                : stagedUnlinks.length > 0
                  ? `Unlink ${stagedUnlinks.length} · connect & sync ${includedIssues.length} issues`
                  : `Connect & sync ${includedIssues.length} issues`}
          </Button>
        </div>
      </div>
    );
  };

  const stepBodies = [
    renderConnect,
    renderMap,
    renderTasks,
    renderStates,
    renderReconcile,
    renderReview,
  ];

  // -------------------------------------------------------------------------
  // Chrome
  // -------------------------------------------------------------------------

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="full"
      showCloseButton={false}
      closeOnOverlayClick={false}
      className="rounded-none"
    >
      <div
        className="flex flex-col"
        style={{ height: '90vh', maxHeight: '90vh' }}
        data-testid="tracker-wizard-modal"
      >
        {/* ── Head ────────────────────────────────────────────────────────── */}
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border-primary bg-surface-secondary px-4 py-2.5">
          <Eyebrow className="text-text-primary">Integrations</Eyebrow>
          <span className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">
            {sourceConnection !== undefined
              ? `/ Add a ${meta.name} mapping`
              : `/ Connect ${meta.name}`}
          </span>
          {sourceConnection !== undefined && shownIdentity !== null && (
            <span className="min-w-0 truncate text-[10px] uppercase tracking-[0.18em] text-text-tertiary">
              / {shownIdentity.workspaceName} · {shownIdentity.actorLabel}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-none border border-border-primary px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary hover:text-text-primary"
          >
            Close
          </button>
        </div>

        {/* ── Step rail ───────────────────────────────────────────────────── */}
        <div className="flex flex-shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border-primary bg-surface-secondary px-4">
          {STEP_LABELS.map((label, index) => {
            // Add-mapping mode drops Step 0 from the rail entirely — the step
            // does not exist for this run, so a disabled stub would misdescribe
            // it as "not reached yet". Test ids stay ABSOLUTE indices so one
            // vocabulary addresses the rail in both modes.
            if (index < firstStep) return null;
            const active = index === step;
            const past = index < step;
            // A run with nothing mapped skips the three middle steps — they are
            // shown rather than hidden (the run still HAS six steps; these three
            // simply have nothing to describe) and say so on hover.
            const skipped = mappedGroups.length === 0 && index > MAP_STEP && index < LAST_STEP;
            const reachable = index <= maxStep && !skipped;
            return (
              <button
                key={label}
                type="button"
                disabled={!reachable}
                title={skipped ? 'Nothing mapped — this run only unlinks.' : undefined}
                aria-current={active ? 'step' : undefined}
                data-testid={`tracker-step-${index}`}
                onClick={() => void goToStep(index)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.12em] transition-colors duration-[120ms]',
                  active && 'text-text-primary shadow-[inset_0_-2px_0_var(--color-interactive-primary)]',
                  !active && past && 'text-text-secondary',
                  !active && !past && 'text-text-tertiary',
                  !reachable && 'cursor-not-allowed',
                )}
              >
                <span
                  className={cn(
                    'flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px]',
                    active
                      ? 'bg-interactive text-text-on-interactive'
                      : past
                        ? 'bg-text-secondary text-bg-primary'
                        : 'bg-surface-tertiary text-text-tertiary',
                  )}
                >
                  {index - firstStep + 1}
                </span>
                {label}
              </button>
            );
          })}
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-bg-primary px-6 py-5">
          <div className="mx-auto w-full max-w-[840px]">
            {stepError !== null && (
              <p
                role="alert"
                className="mb-3 rounded-none border border-status-error px-3 py-2 text-xs text-status-error"
              >
                {stepError}
              </p>
            )}
            {stepBodies[step]()}
          </div>
        </div>

        {/* ── Footer nav (steps 1–5; Step 0 advances from its own card) ───── */}
        {step > 0 && (
          <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-dashed border-border-primary bg-bg-primary px-6 py-3">
            {/* Back is omitted on the run's FIRST step — in add-mapping mode Map
                has nothing behind it, and an inert button reads as a dead end. */}
            {step > firstStep ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-none"
                onClick={() => void goToStep(prevStepFrom(step))}
              >
                Back
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-3">
              <span className="text-[10px] uppercase tracking-[0.12em] text-text-tertiary">
                Step {step - firstStep + 1} of {STEP_LABELS.length - firstStep}
              </span>
              {step < LAST_STEP && (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="rounded-none"
                  disabled={nextBlocked || loading}
                  loading={loading}
                  onClick={() => void goToStep(nextStepFrom(step))}
                >
                  {nextStepFrom(step) === LAST_STEP ? 'Review' : 'Continue'}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
