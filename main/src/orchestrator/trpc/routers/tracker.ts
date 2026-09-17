/**
 * cyboflow.tracker sub-router — the Settings > Integrations surface for the
 * Linear/Plane sync feature. Design: docs/proposals/tracker-sync-integration.md.
 *
 *   wizardValidate / wizardGroups / wizardContainers / wizardNarrows /
 *   wizardStates / wizardFieldOptions /
 *   wizardIssues                  : mutations    -> stateless provider probes (persist nothing)
 *                                                   (wizardFieldOptions = the priority/type
 *                                                    vocabularies the mapping tables offer)
 *   reconcilePreview              : mutation     -> TrackerReconcileItem[] (wizard Step 4)
 *   connect                       : mutation     -> { connectionId } (row + encrypted key + reconcile + first pass)
 *   updateCredentials             : mutation     -> TrackerWorkspaceIdentity (rotate the key in place, resume)
 *   probeRecovery                 : query        -> TrackerRecoveryProbe (WHICH recovery a paused keyless connection needs)
 *   remapRenamedPrefix            : mutation     -> TrackerRemapResult (rewrite links after `bd rename-prefix`)
 *   adoptNewWorkspace             : mutation     -> TrackerAdoptionResult (retire + re-bind after a REPLACED workspace)
 *   connections                   : query        -> TrackerConnectionSummary[]
 *   mappings                      : query        -> TrackerConnectionSummary[] (one identity's siblings, ACROSS projects)
 *   setPushTarget                 : mutation     -> { ok } (arm this mapping as its pair's pusher)
 *   updateSettings / disconnect   : mutations    -> void
 *   syncNow                       : mutation     -> TrackerSyncPassSummary ("Sync now")
 *   conflicts                     : query        -> TrackerConflictSummary[]
 *   resolveConflict               : mutation     -> void
 *   linksForEntity                : query        -> TrackerEntityLinkRef[]
 *   hasLinkedDescendants          : query        -> boolean (does the delete cascade hit synced children?)
 *   stageUnlinkRuling             : mutation     -> { ok } (COLLECT the local-removal ruling; mutates nothing)
 *   clearUnlinkRuling             : mutation     -> { ok } (DISCARD a ruling the user backed out of)
 *   unlinkEntity                  : mutation     -> { unlinked } (apply a ruling directly)
 *   onTrackerChanged              : subscription -> TrackerChangedEvent
 *
 * Every procedure is a THIN 1:1 wrapper over the TrackerSyncFacade wired at boot
 * (main/src/index.ts -> setTrackerSyncFacade). All behaviour — secret handling,
 * the entity-write chokepoint, conflict semantics, the poll loop — lives in the
 * service; this file validates input and maps failures onto TRPCError codes.
 *
 * SECRETS: `credentials` travels renderer -> main on the wizard/connect calls
 * and stops there (the service encrypts before sqlite). NOTHING this router
 * RETURNS carries key material — see shared/types/trackerSync.ts. The mapping-
 * management path carries even less: it names an existing `connectionId` and the
 * service resolves that row's stored key, so no key crosses IPC in either
 * direction — which is exactly why the three probes that path re-enters accept
 * `credentials` XOR `connectionId` rather than requiring a paste.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. That is exactly why the facade + its emitter live in
 * orchestrator/trackerSyncBridge.ts rather than being imported from the service,
 * and why the two service-side error classes are recognized BY NAME below
 * instead of by `instanceof`.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { TaskChangeError } from '../../taskChangeRouter';
import {
  getTrackerSyncFacade,
  trackerProjectChannel,
  trackerSyncEvents,
  TrackerSyncNotInitializedError,
  type TrackerChangedEvent,
} from '../../trackerSyncBridge';
import {
  PROVIDER_NEEDS_SECRET,
  providerNeedsSecret,
} from '../../../../../shared/types/trackerSync';
import type {
  TrackerAdoptionResult,
  TrackerConflictSummary,
  TrackerConnectionSummary,
  TrackerEntityLinkRef,
  TrackerFieldOptions,
  TrackerGroupTree,
  TrackerIssue,
  TrackerReconcileItem,
  TrackerRecoveryProbe,
  TrackerRemapResult,
  TrackerSourceNarrow,
  TrackerSourceTree,
  TrackerState,
  TrackerSyncPassSummary,
  TrackerWorkspaceIdentity,
} from '../../../../../shared/types/trackerSync';
import { eventToAsyncIterable } from './events';

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Error-class recognition by NAME. The two classes that matter here
 * (TrackerAuthError, TrackerSecretsUnavailableError) live under
 * main/src/services/trackerSync/, which this file must not import — and both set
 * `this.name` in their constructor precisely so a consumer across a boundary can
 * branch on class without importing it.
 */
function isErrorNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name;
}

/**
 * Does this error come from a KEYLESS provider's adapter?
 *
 * Read STRUCTURALLY (`provider` is a public readonly field on TrackerApiError)
 * for the same reason the checks above read `name`: this file may not import
 * the error classes. The own-property test is what keeps an unrelated error
 * carrying a `provider`-shaped field from smuggling an adapter message into
 * the wizard — an unknown string is not a keyless provider, it is not a
 * provider at all.
 */
function isKeylessProviderError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const provider = (err as { provider?: unknown }).provider;
  if (typeof provider !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_NEEDS_SECRET, provider)) return false;
  return !PROVIDER_NEEDS_SECRET[provider as keyof typeof PROVIDER_NEEDS_SECRET];
}

/**
 * Map a tracker/chokepoint failure onto a TRPCError the renderer can branch on:
 *
 *   TrackerAuthError                -> UNAUTHORIZED       (the key is bad — re-connect)
 *   TrackerConnectionNotFoundError  -> NOT_FOUND          (unknown connection id)
 *   TrackerConnectionPausedError    -> CONFLICT           (arming a paused row over an active pusher)
 *   TrackerIdentityMismatchError    -> CONFLICT           (right key, wrong workspace)
 *   TrackerSecretsUnavailableError  -> PRECONDITION_FAILED (no OS keychain on this host)
 *   TrackerSyncNotInitializedError  -> PRECONDITION_FAILED (called before boot wired the facade)
 *   TaskChangeError                 -> the chokepoint's own code map (mirrors tasks.ts)
 *
 * Anything else re-throws unchanged.
 */
function rethrowAsTRPCError(err: unknown): never {
  if (isErrorNamed(err, 'TrackerConnectionNotFoundError')) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: err instanceof Error ? err.message : 'tracker connection not found',
      cause: err,
    });
  }
  if (isErrorNamed(err, 'TrackerConnectionPausedError')) {
    throw new TRPCError({
      code: 'CONFLICT',
      // Verbatim: the message carries the actionable fix (reconnect first).
      message: err instanceof Error ? err.message : 'this connection is paused',
      cause: err,
    });
  }
  if (isErrorNamed(err, 'TrackerIdentityMismatchError')) {
    throw new TRPCError({
      code: 'CONFLICT',
      // Passed through verbatim, unlike the generic auth message below: this one
      // names the two workspaces, which is the whole actionable content.
      message: err instanceof Error ? err.message : 'this key authorizes a different workspace',
      cause: err,
    });
  }
  if (isErrorNamed(err, 'TrackerAuthError')) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      // KEYLESS providers pass the message through VERBATIM. For a keyed one
      // the generic line is right — the provider's own 401 body is not
      // something to paste into a wizard, and "check the key" is always the
      // fix. A keyless provider has no key to check: its auth failures are
      // "`bd` is not installed" and "this repo has no beads workspace", two
      // different fixes that the generic line would erase, and it would send
      // the user hunting for an API key that does not exist.
      message: isKeylessProviderError(err)
        ? (err instanceof Error ? err.message : 'the tracker workspace could not be detected')
        : 'The tracker rejected these credentials. Check the API key and try again.',
      cause: err,
    });
  }
  if (isErrorNamed(err, 'TrackerCredentialsError')) {
    throw new TRPCError({
      // Not an auth failure: the connection is not wired to a workspace it can
      // reach (no project named, no repo path on disk, no recorded workspace).
      // Verbatim, because each of those has its own fix and none of them is
      // "check the key".
      code: 'PRECONDITION_FAILED',
      message: err instanceof Error ? err.message : 'this connection cannot be built',
      cause: err,
    });
  }
  if (isErrorNamed(err, 'TrackerRecoveryUnavailableError')) {
    throw new TRPCError({
      // Not a failure of the connection — the question does not apply to it.
      // Verbatim, because it names the provider and the reconnect that DOES
      // apply.
      code: 'PRECONDITION_FAILED',
      message: err instanceof Error ? err.message : 'this provider has no workspace recovery',
      cause: err,
    });
  }
  if (isErrorNamed(err, 'TrackerRecoveryStateError')) {
    throw new TRPCError({
      // The user acted on a classification that has since moved on. CONFLICT is
      // the honest code (a state mismatch, not a bad request), and the message
      // is verbatim because it names both the expected and the actual state.
      code: 'CONFLICT',
      message: err instanceof Error ? err.message : 'this workspace is in a different state now',
      cause: err,
    });
  }
  if (isErrorNamed(err, 'TrackerSecretsUnavailableError')) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'This machine has no OS-level secret storage available, so the API key cannot be stored securely.',
      cause: err,
    });
  }
  if (err instanceof TrackerSyncNotInitializedError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof TaskChangeError) {
    const codeMap: Record<TaskChangeError['code'], TRPCError['code']> = {
      not_found: 'NOT_FOUND',
      invalid_parent: 'BAD_REQUEST',
      invalid_lineage: 'BAD_REQUEST',
      forbidden_stage: 'FORBIDDEN',
      active_runs: 'CONFLICT',
      concurrency: 'CONFLICT',
      invalid_dependency: 'BAD_REQUEST',
      dependency_cycle: 'CONFLICT',
      // executor is tasks-only (migration 137) — a caller bug, not a conflict.
      invalid_executor: 'BAD_REQUEST',
      idea_needs_epic: 'CONFLICT',
      experiment_sandboxed: 'CONFLICT',
      experiment_sweep_failed: 'INTERNAL_SERVER_ERROR',
    };
    throw new TRPCError({
      code: codeMap[err.code],
      message: `${err.code}: ${err.message}`,
      cause: err,
    });
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Zod input schemas — the exact shapes in shared/types/trackerSync.ts
// ---------------------------------------------------------------------------

const providerSchema = z.enum(['linear', 'plane', 'dart', 'beads']);

/**
 * Renderer -> main, wizard/connect only. This is the ONLY inbound key path.
 *
 * `apiKey` is optional on the WIRE and required per PROVIDER: the refinement
 * below is what keeps a keyed provider from arriving keyless (which would
 * reach its adapter as an empty string and come back as a 401 the user cannot
 * act on) while letting beads — whose credential is that the project has a
 * `bd` workspace at all — connect with no key. `projectId` is beads' anchor,
 * and it is an ID rather than a path on purpose: main resolves the path it
 * spawns `bd` in, so nothing a renderer composed can point the CLI elsewhere.
 */
const credentialsSchema = z
  .object({
    provider: providerSchema,
    apiKey: z.string().min(1).optional(),
    /** Plane self-hosted origin; omitted = the provider's cloud default. */
    baseUrl: z.string().min(1).optional(),
    /** Plane only: the workspace slug all API paths are scoped under. */
    workspaceSlug: z.string().min(1).optional(),
    /** beads only: the project whose repo path anchors the workspace probe. */
    projectId: z.number().int().positive().optional(),
    /**
     * beads only: an opaque token main minted for a folder the user picked in
     * a NATIVE dialog (`wizardPickWorkspace`), overriding the project's repo
     * path. It stays a token all the way through — the refinement below still
     * requires `projectId`, because the token overrides path RESOLUTION only
     * and a stale one must fail closed rather than fall back to an unanchored
     * probe.
     */
    workspaceDirToken: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (providerNeedsSecret(value.provider)) {
      if (value.apiKey === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['apiKey'],
          message: `${value.provider} connections require an API key`,
        });
      }
      return;
    }
    if (value.projectId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projectId'],
        message: `${value.provider} connections require the project whose repo holds the workspace`,
      });
    }
  });

/**
 * A wizard probe's CREDENTIAL SOURCE (TrackerWizardSourceInput): a pasted key, or
 * the id of a connection whose stored key main resolves itself. Exactly one — a
 * payload carrying both is ambiguous about which key it meant, and one carrying
 * neither cannot probe anything, so both are BAD_REQUEST here rather than a
 * silent precedence rule invented at this seam.
 *
 * Spread into each probe's own object schema rather than nested, so the wire
 * shape stays `{ credentials?, connectionId?, … }` — the flat shape the renderer
 * already sends for the paste path.
 */
const wizardSourceShape = {
  credentials: credentialsSchema.optional(),
  connectionId: z.string().min(1).optional(),
};

/** The exactly-one rule, as a refinement both the probes and `connect` apply. */
function exactlyOneCredentialSource(credentials: unknown, connectionId: unknown): boolean {
  return (credentials !== undefined) !== (connectionId !== undefined);
}

const narrowKindSchema = z.enum(['all', 'project', 'view', 'cycle', 'module', 'space']);

const sourceSelectionSchema = z.object({
  containerId: z.string().min(1),
  narrowId: z.string().min(1),
  narrowKind: narrowKindSchema,
  /** Dart space groups only — the concrete dartboard a create is filed on. */
  pushContainerId: z.string().min(1).optional(),
});

const mappingTargetSchema = z.enum(['dont', 'idea', 'ready', 'done', 'wontdo', 'indev']);
/** Keyed by TRACKER state id, so the keys are provider-defined and unconstrained. */
const stateMappingSchema = z.record(z.string(), mappingTargetSchema);

const selectionModeSchema = z.enum(['all', 'assignee', 'manual']);
const conflictModeSchema = z.enum(['auto', 'manual']);

/**
 * TrackerDirectionMode — the PULL and PUSH cadences. Same two literals as
 * `conflictModeSchema` and deliberately a SEPARATE declaration: they answer
 * different questions ("when does this direction run" vs. "who resolves a
 * clash"), and sharing one schema would silently couple them if either ever
 * grows a third value.
 *
 * Status left this schema at migration 130 — see `gatedSyncModeSchema`. Pull
 * and push stay two-state because neither writes to the tracker on its own.
 */
const directionModeSchema = z.enum(['auto', 'manual']);

/**
 * TrackerGatedSyncMode — the cadence of the three directions that can be turned
 * OFF outright: status (migration 130), field write-back and archive
 * (migration 118). A SEPARATE declaration from `directionModeSchema`,
 * deliberately: 'off' is a real third answer here ("never"), and coupling it
 * onto the two-state schema above would let pull/push silently accept a value
 * they must never see.
 */
const gatedSyncModeSchema = z.enum(['auto', 'manual', 'off']);

const priorityLevelSchema = z.enum(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
const entityCategorySchema = z.enum(['feature', 'bug', 'chore']);

/**
 * The wizard's edited priority-mapping overlay (migration 118's
 * `priority_mapping_json`). `toProvider` only — `toLocal` is deliberately
 * never sent by the wizard; the resolver falls back to the seed's own inbound
 * table when it is absent (see shared/types/trackerSync.ts's
 * TrackerPriorityMappingOverlay). A record schema validates only the keys it
 * sees, so a caller may send any subset of the seven levels — the same
 * looseness `stateMappingSchema` has.
 */
const priorityMappingOverlaySchema = z.object({
  toProvider: z.record(priorityLevelSchema, z.string().nullable()),
});

/** Same shape as {@link priorityMappingOverlaySchema}, for the category mapping. */
const categoryMappingOverlaySchema = z.object({
  toProvider: z.record(entityCategorySchema, z.string().nullable()),
});

const selectionJsonSchema = z.object({
  assigneeIds: z.array(z.string()).optional(),
  issueIds: z.array(z.string()).optional(),
});

const userRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  initials: z.string(),
});

/**
 * A TrackerIssue coming back IN from the renderer (reconcilePreview replays the
 * set `wizardIssues` handed it). Validated in full rather than trusted: it is
 * renderer-supplied input like any other, even though main produced it.
 */
const issueSchema = z.object({
  externalId: z.string().min(1),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  stateId: z.string(),
  assignee: userRefSchema.nullable(),
  estimate: z.number().nullable(),
  parentExternalId: z.string().nullable(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  // Provider-RAW tokens (see TrackerIssue.priority): validated as opaque
  // strings, deliberately not as an enum — each provider spells its own scale,
  // and Dart's is workspace-defined.
  priority: z.string().nullable(),
  category: z.string().nullable(),
  recoveryClientKey: z.string().nullable(),
});

const reconcileDecisionSchema = z.object({
  entityType: z.enum(['idea', 'task']),
  entityId: z.string().min(1),
  action: z.enum(['keep', 'link', 'discard']),
  /** Required in practice for action 'link'; the service skips a link without it. */
  linkExternalId: z.string().min(1).optional(),
  linkIdentifier: z.string().min(1).optional(),
  linkUrl: z.string().min(1).optional(),
});

const entityTypeSchema = z.enum(['idea', 'epic', 'task']);

export const trackerRouter = router({
  // -------------------------------------------------------------------------
  // Wizard probes
  //
  // MUTATIONS, not queries, deliberately: each one carries an API key in its
  // input and performs a live network call, so it must never be cached, keyed,
  // or transparently re-fetched by the client.
  // -------------------------------------------------------------------------

  /** Step 0 — live credential probe backing the "Authorized as …" card. */
  wizardValidate: protectedProcedure
    .input(z.object({ credentials: credentialsSchema }))
    .mutation(async ({ input }): Promise<TrackerWorkspaceIdentity> => {
      try {
        return await getTrackerSyncFacade().wizardValidate(input.credentials);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Step 0, KEYLESS ONLY — open the main-process folder dialog so the user can
   * point Detect at a workspace that is not at the project's repo path, and
   * answer with an opaque token for it (null = cancelled).
   *
   * A mutation for a reason of its own on top of the section note above: it
   * opens a modal OS dialog, so a cached or transparently re-fetched call would
   * put a second one on screen.
   */
  wizardPickWorkspace: protectedProcedure
    .input(z.object({ provider: providerSchema }))
    .mutation(async ({ input }): Promise<{ token: string; path: string } | null> => {
      try {
        return await getTrackerSyncFacade().wizardPickWorkspace(input.provider);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Step 0, KEYLESS ONLY — create the workspace Detect just failed to find, in
   * the folder these credentials already name (main resolves it; the input
   * carries no path). A mutation on top of the section note above because it
   * WRITES to the user's disk, which nothing may re-issue on its own.
   */
  wizardInitWorkspace: protectedProcedure
    .input(z.object({ credentials: credentialsSchema }))
    .mutation(async ({ input }): Promise<void> => {
      try {
        await getTrackerSyncFacade().wizardInitWorkspace(input.credentials);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Map step — the mappable tracker groups (Linear projects × teams + whole
   * teams, Plane projects, Dart spaces), each carrying its ready-made source
   * selection. A mutation for the same reason its siblings are: it makes a live
   * call (and on the paste path carries a key), so it must never be cached or
   * re-fetched.
   *
   * Takes a credential SOURCE: mapping management re-enters this step from an
   * existing connection and names it instead of pasting a key.
   */
  wizardGroups: protectedProcedure
    .input(
      z
        .object(wizardSourceShape)
        .refine((v) => exactlyOneCredentialSource(v.credentials, v.connectionId), {
          message: 'exactly one of credentials / connectionId',
        }),
    )
    .mutation(async ({ input }): Promise<TrackerGroupTree> => {
      try {
        return await getTrackerSyncFacade().wizardGroups({
          credentials: input.credentials,
          connectionId: input.connectionId,
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Step 1, top level — Linear teams / Plane projects. */
  wizardContainers: protectedProcedure
    .input(z.object({ credentials: credentialsSchema }))
    .mutation(async ({ input }): Promise<TrackerSourceTree> => {
      try {
        return await getTrackerSyncFacade().wizardContainers(input.credentials);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Step 1, second level — the narrows under one container (always includes 'all'). */
  wizardNarrows: protectedProcedure
    .input(z.object({ credentials: credentialsSchema, containerId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<TrackerSourceNarrow[]> => {
      try {
        return await getTrackerSyncFacade().wizardNarrows(input.credentials, input.containerId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Step 3 — the source's states (with canonical groups) for the mapping table.
   * Credential SOURCE, like `wizardGroups`.
   */
  wizardStates: protectedProcedure
    .input(
      z
        .object({ ...wizardSourceShape, selection: sourceSelectionSchema })
        .refine((v) => exactlyOneCredentialSource(v.credentials, v.connectionId), {
          message: 'exactly one of credentials / connectionId',
        }),
    )
    .mutation(async ({ input }): Promise<TrackerState[]> => {
      try {
        return await getTrackerSyncFacade().wizardStates(
          { credentials: input.credentials, connectionId: input.connectionId },
          input.selection,
        );
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * The priority/category mapping tables' options — the provider's priority
   * tokens and (Dart only) type titles. Credential SOURCE, like `wizardStates`;
   * no selection, because none of the three providers scopes these lists to a
   * container.
   */
  wizardFieldOptions: protectedProcedure
    .input(
      z
        .object(wizardSourceShape)
        .refine((v) => exactlyOneCredentialSource(v.credentials, v.connectionId), {
          message: 'exactly one of credentials / connectionId',
        }),
    )
    .mutation(async ({ input }): Promise<TrackerFieldOptions> => {
      try {
        return await getTrackerSyncFacade().wizardFieldOptions({
          credentials: input.credentials,
          connectionId: input.connectionId,
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Step 2 — every issue in the chosen source (assignee/manual pickers +
   * Reconcile). Credential SOURCE, like `wizardGroups`.
   */
  wizardIssues: protectedProcedure
    .input(
      z
        .object({ ...wizardSourceShape, selection: sourceSelectionSchema })
        .refine((v) => exactlyOneCredentialSource(v.credentials, v.connectionId), {
          message: 'exactly one of credentials / connectionId',
        }),
    )
    .mutation(async ({ input }): Promise<TrackerIssue[]> => {
      try {
        return await getTrackerSyncFacade().wizardIssues(
          { credentials: input.credentials, connectionId: input.connectionId },
          input.selection,
        );
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Reconcile + connect
  // -------------------------------------------------------------------------

  /**
   * Step 4 — the project's pre-existing backlog items with a suggested issue
   * match each. A mutation rather than a query: the issue set is wizard-local
   * state (not a cache key), and re-running it on a client-side refetch would
   * be pure waste.
   */
  reconcilePreview: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        issues: z.array(issueSchema),
      }),
    )
    .mutation(async ({ input }): Promise<TrackerReconcileItem[]> => {
      try {
        return await getTrackerSyncFacade().reconcilePreview(input.projectId, input.issues);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Step 5 — persist the connection: the row + the encrypted key, the reconcile
   * decisions (link / discard), and a fire-and-forget first sync pass. Returns
   * as soon as the row is durable; the first pass reports through the
   * `onTrackerChanged` subscription.
   *
   * The key is pasted (`credentials`) or borrowed from a connection already
   * authorized for this workspace (`sourceConnectionId`) — exactly one, same rule
   * as the probes; adding a mapping to an existing connection takes the latter.
   */
  connect: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        credentials: credentialsSchema.optional(),
        /** Reuse a live connection's stored key + identity instead of pasting one. */
        sourceConnectionId: z.string().min(1).optional(),
        source: sourceSelectionSchema,
        sourceLabel: z.string(),
        selectionMode: selectionModeSchema,
        selectionJson: selectionJsonSchema.nullable(),
        stateMapping: stateMappingSchema,
        statusSyncMode: gatedSyncModeSchema,
        pullMode: directionModeSchema,
        pushMode: directionModeSchema,
        /** Omitted = 'off'. */
        contentSyncMode: gatedSyncModeSchema.optional(),
        /** Omitted = 'off'; see contentSyncMode. */
        archiveSyncMode: gatedSyncModeSchema.optional(),
        /** Omitted = the seed only, no user override. */
        priorityMapping: priorityMappingOverlaySchema.optional(),
        /** Omitted = the seed only; also omitted for a provider with no category sync. */
        categoryMapping: categoryMappingOverlaySchema.optional(),
        mirrorSubissues: z.boolean(),
        conflictMode: conflictModeSchema,
        reconcile: z.array(reconcileDecisionSchema),
        /** Omitted = true; false on every sibling mapping but the pushing one. */
        pushTarget: z.boolean().optional(),
      })
      .refine((v) => exactlyOneCredentialSource(v.credentials, v.sourceConnectionId), {
        message: 'exactly one of credentials / connectionId',
      }),
    )
    .mutation(async ({ input }): Promise<{ connectionId: string }> => {
      try {
        return await getTrackerSyncFacade().connect(input);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Rotate an existing connection's API key in place and resume it — the
   * reconnect path for a revoked/rotated key, which `connect` cannot serve
   * (against a live or paused connection it would mint a second one and
   * re-import the whole synced backlog).
   *
   * The key travels in, exactly like the wizard calls, and nothing comes back
   * out: the result is the validated workspace identity. Rejects NOT_FOUND for
   * an unknown id and CONFLICT when the key belongs to a different workspace.
   *
   * `apiKey` is OPTIONAL because a keyless connection (beads) reconnects by
   * RE-DETECTING — there is no key to paste, and the same procedure re-probes
   * the workspace and resumes on an identity match. Which providers may omit
   * it is the SERVICE's call, not this schema's: the row names the provider,
   * and the renderer's connection summary is not a trustworthy place to decide
   * whether a key was required.
   */
  updateCredentials: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1), apiKey: z.string().min(1).optional() }))
    .mutation(async ({ input }): Promise<TrackerWorkspaceIdentity> => {
      try {
        return await getTrackerSyncFacade().updateCredentials(input.connectionId, input.apiKey);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * WHICH recovery a paused KEYLESS connection needs — 'healthy' | 'redetect' |
   * 'renamed' | 'replaced' — decided by re-probing the workspace and comparing
   * the ids, never by reading an error message.
   *
   * A QUERY, and a genuinely cheap one to re-run: it persists nothing, resumes
   * nothing, and is what the connected view's banner branches on to choose
   * between "Re-detect", "Remap links" and "Adopt new workspace". PRECONDITION_
   * FAILED for a keyed provider (which has no such classification);
   * NOT_FOUND for an unknown id.
   */
  probeRecovery: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .query(async ({ input }): Promise<TrackerRecoveryProbe> => {
      try {
        return await getTrackerSyncFacade().probeRecovery(input.connectionId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * 'renamed': rewrite every link and unresolved outbox row from the old issue
   * prefix to the new one, then resume and kick a pass. `bd rename-prefix`
   * preserves the id suffix, so this is a deterministic rewrite rather than a
   * re-match — but it is still a bulk write over every link, so the service
   * re-probes first and rejects CONFLICT when the workspace no longer reads as
   * renamed.
   */
  remapRenamedPrefix: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<TrackerRemapResult> => {
      try {
        return await getTrackerSyncFacade().remapRenamedPrefix(input.connectionId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * 'replaced': retire this connection, cancel its queued writes, and bind a
   * fresh one to the database now at the same path — the destructive recovery,
   * which is why the renderer confirms explicitly before calling it and why no
   * timer may ever reach it. Same re-probe guard as the remap (CONFLICT when the
   * state has moved on).
   */
  adoptNewWorkspace: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<TrackerAdoptionResult> => {
      try {
        return await getTrackerSyncFacade().adoptNewWorkspace(input.connectionId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Connected view
  // -------------------------------------------------------------------------

  /** The project's connections (disconnected ones are not listed). */
  connections: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .query(async ({ input }): Promise<TrackerConnectionSummary[]> => {
      try {
        return await getTrackerSyncFacade().connections(input.projectId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Every LIVE mapping sharing this connection's tracker identity — provider,
   * workspace, instance — ACROSS projects, which is what `connections` (scoped to
   * one project) structurally cannot return: a rev-4 wizard run mints one sibling
   * row per (tracker group -> cyboflow project) pair on ONE authorization, and
   * the management view's object is that authorization.
   *
   * A QUERY, unlike its wizard neighbours: it is a pure read of local rows with
   * no key in flight and no network call, so caching and re-fetching it is
   * exactly right. NOT_FOUND for an unknown id; a retired connection still
   * answers (with itself leading the list).
   */
  mappings: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .query(async ({ input }): Promise<TrackerConnectionSummary[]> => {
      try {
        return await getTrackerSyncFacade().mappings(input.connectionId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Arm this mapping as the one its (project, provider) pair files new ideas
   * through, demoting whichever sibling held the flag. The invariant is enforced
   * in ONE store statement rather than as two per-row writes, so there is no
   * window in which a project has two pushers (one idea, two remote issues) or
   * none. NOT_FOUND for an unknown or disconnected id.
   */
  setPushTarget: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      try {
        await getTrackerSyncFacade().setPushTarget(input.connectionId);
        return { ok: true };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Patch the sync-settings card. Only the keys present are written; an unknown
   * connection id is an idempotent no-op.
   */
  updateSettings: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().min(1),
        statusSyncMode: gatedSyncModeSchema.optional(),
        pullMode: directionModeSchema.optional(),
        pushMode: directionModeSchema.optional(),
        contentSyncMode: gatedSyncModeSchema.optional(),
        archiveSyncMode: gatedSyncModeSchema.optional(),
        priorityMapping: priorityMappingOverlaySchema.optional(),
        categoryMapping: categoryMappingOverlaySchema.optional(),
        mirrorSubissues: z.boolean().optional(),
        conflictMode: conflictModeSchema.optional(),
        stateMapping: stateMappingSchema.optional(),
        selectionMode: selectionModeSchema.optional(),
        selectionJson: selectionJsonSchema.nullable().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      const { connectionId, ...patch } = input;
      try {
        await getTrackerSyncFacade().updateSettings(connectionId, patch);
        return { ok: true };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Retire a connection (status 'disconnected' + the stored key cleared). Links stay. */
  disconnect: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      try {
        await getTrackerSyncFacade().disconnect(input.connectionId);
        return { ok: true };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** The manual "Sync now" — a forced pass, which also sweeps for remote deletions. */
  syncNow: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<TrackerSyncPassSummary> => {
      try {
        return await getTrackerSyncFacade().syncNow(input.connectionId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------

  /** The connection's OPEN conflicts (Manual mode's per-item queue). */
  conflicts: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .query(async ({ input }): Promise<TrackerConflictSummary[]> => {
      try {
        return await getTrackerSyncFacade().conflicts(input.connectionId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Resolve one conflict: 'remote' accepts the tracker's value (applied through
   * the entity chokepoint), 'local' keeps ours (and, for a stage conflict,
   * queues the write-back that converges the tracker onto it).
   */
  resolveConflict: protectedProcedure
    .input(
      z.object({
        conflictId: z.number().int().positive(),
        choice: z.enum(['local', 'remote']),
      }),
    )
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      try {
        await getTrackerSyncFacade().resolveConflictChoice(input.conflictId, input.choice);
        return { ok: true };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Entity link lookup
  // -------------------------------------------------------------------------

  /** Every live tracker link an entity has — empty when it is not synced (or every link is orphaned). */
  linksForEntity: protectedProcedure
    .input(z.object({ entityType: entityTypeSchema, entityId: z.string().min(1) }))
    .query(async ({ input }): Promise<TrackerEntityLinkRef[]> => {
      try {
        return await getTrackerSyncFacade().linksForEntity(input.entityType, input.entityId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Would deleting this entity also remove OTHER synced entities? (An idea's
   * epics/tasks, an epic's tasks.) The removal dialog's copy needs it to say the
   * ruling covers those children too.
   */
  hasLinkedDescendants: protectedProcedure
    .input(z.object({ entityType: entityTypeSchema, entityId: z.string().min(1) }))
    .query(async ({ input }): Promise<boolean> => {
      try {
        return await getTrackerSyncFacade().hasLinkedDescendants(input.entityType, input.entityId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * COLLECT the local-removal ruling the backlog's delete/archive path asks for
   * when the entity is linked ('keep the issue' vs `cancelRemote`). Mutates
   * NOTHING: the confirm dialog behind it may still be dismissed, and the ruling
   * is applied by the committed delete/archive itself (children included).
   */
  stageUnlinkRuling: protectedProcedure
    .input(
      z.object({
        entityType: entityTypeSchema,
        entityId: z.string().min(1),
        cancelRemote: z.boolean(),
      }),
    )
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      try {
        await getTrackerSyncFacade().stageUnlinkRuling(input.entityType, input.entityId, {
          cancelRemote: input.cancelRemote,
        });
        return { ok: true };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * DISCARD a staged ruling: the confirm dialog behind it closed without
   * committing (Cancel / escape / overlay), or the ruling dialog itself was
   * dismissed. Without this the abandoned answer stays consumable until it
   * expires, and the next removal of that entity would spend it — cancelling a
   * tracker issue the user explicitly backed out of. Idempotent: an entity with
   * no staged ruling is a no-op, so the renderer may fire it defensively.
   */
  clearUnlinkRuling: protectedProcedure
    .input(z.object({ entityType: entityTypeSchema, entityId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      try {
        await getTrackerSyncFacade().clearUnlinkRuling(input.entityType, input.entityId);
        return { ok: true };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Apply the ruling DIRECTLY — drop the link, and with `cancelRemote` queue the
   * write that cancels the issue in the tracker first. Never a remote hard
   * delete. `unlinked: false` means there was no live link (a stale read). The
   * board's delete path stages instead; this is for callers with no confirm
   * dialog left to dismiss.
   */
  unlinkEntity: protectedProcedure
    .input(
      z.object({
        entityType: entityTypeSchema,
        entityId: z.string().min(1),
        cancelRemote: z.boolean(),
      }),
    )
    .mutation(async ({ input }): Promise<{ unlinked: boolean }> => {
      try {
        return await getTrackerSyncFacade().unlinkEntity(input.entityType, input.entityId, {
          cancelRemote: input.cancelRemote,
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  /**
   * Subscribe to this project's tracker changes.
   *
   * Bridges the module-level `trackerSyncEvents` emitter (exported from
   * trackerSyncBridge.ts, NOT from this file) on the project channel
   * `tracker-project-<projectId>`. The payload is a NOTIFICATION — the client
   * re-reads `connections` / `conflicts` off the `kind` rather than patching a
   * card from the event.
   *
   * No throttle: connection/sync/conflict changes are minutes apart at the
   * feature's fixed 5-minute cadence.
   */
  onTrackerChanged: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<TrackerChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<TrackerChangedEvent>(
        trackerSyncEvents,
        trackerProjectChannel(input.projectId),
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
