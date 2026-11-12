/**
 * openIdeaSessionCore — the FIND-OR-CREATE door behind the backlog idea card's
 * "Open" (idea sessions plan, Stage 1).
 *
 * An idea owns at most ONE live session: an IN-PLACE (no worktree), SDK-pinned
 * Claude session that is the idea's persistent home. "Open" resolves that
 * session — reusing it when it exists, minting it when it does not — and always
 * hands back a REGISTERED Claude chat panel so the renderer can dispatch the
 * first turn immediately.
 *
 * Shaped like createQuickSessionCore: every collaborator is injected
 * (structurally), so the whole door is unit-testable with fakes and the boot
 * layer (main/src/index.ts) owns the wiring. It layers on TOP of
 * createQuickSessionCore rather than duplicating it — the session row, the
 * `__quick__` sentinel run, and the `chat_run_id` backfill all come from there.
 *
 * Ordering contracts that are NOT free to rearrange:
 *   - The RENAME happens AFTER createQuickSessionCore resolves. In-place session
 *     matching inside the core is by GENERATED NAME, so renaming earlier would
 *     make the core's own `session-created` matcher miss its session.
 *   - `refreshSession` runs after the stamps. Raw UPDATEs never reach the
 *     renderer; SessionManager.refreshSessionFromDatabase re-maps the row and
 *     emits `session-updated`.
 *   - The panel ensure runs LAST and OUTSIDE the compensation window (see
 *     below) — by then the session is legitimately the idea's home and must not
 *     be swept.
 *
 * Compensation window: everything between "the core returned a real session" and
 * "the home/origin stamp committed". A throw there (the substrate belt-guard, or
 * the partial-unique index rejecting a concurrent Open) leaves a provisioned
 * session nobody holds, so it is dismissed through the injected full-dismiss
 * primitive before the error propagates — the same shape as
 * finishDesignSessionCreate. A UNIQUE violation additionally RE-QUERIES the
 * winner and returns it, so the losing Open still lands the user in the idea's
 * home instead of on an error.
 *
 * Accepted crash window (no reservation system): process death between the
 * core's return and the stamp leaves an ordinary unlinked quick session — user-
 * dismissable junk, never a claimed idea.
 */
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ClaudePanelState, CreatePanelRequest, ToolPanel } from '../../../shared/types/panels';
import type { OpenIdeaSessionRequest, OpenIdeaSessionResponse } from '../../../shared/types/ideaSession';
import {
  createQuickSessionCore,
  stampQuickSessionRuntimeConfig,
  type CreateQuickSessionCoreDeps,
} from './createQuickSessionCore';
import { validateIdeaSessionLink } from './ideaSessionValidation';
import type { ClaudeSdkPreflightFailure, ClaudeSdkPreflightResult } from './claudeSdkSessionPreflight';

/**
 * The door's response. Aliased to the SHARED wire type
 * (shared/types/ideaSession.ts) rather than re-declared, so preload, the
 * renderer API wrapper, and this core can never drift a field apart.
 */
export type OpenIdeaSessionResult = OpenIdeaSessionResponse;

export type OpenIdeaSessionFailureCode =
  | 'invalid_idea'
  | ClaudeSdkPreflightFailure
  | 'substrate_mismatch';

/** Structured rejection so the IPC boundary never string-matches a message. */
export class OpenIdeaSessionError extends Error {
  readonly code: OpenIdeaSessionFailureCode;

  constructor(code: OpenIdeaSessionFailureCode, message: string) {
    super(message);
    this.name = 'OpenIdeaSessionError';
    this.code = code;
  }
}

/** Narrow PanelManager slice: find the session's chat panel, else create one. */
export interface IdeaSessionPanelManagerLike {
  getPanelsForSession(sessionId: string): ToolPanel[];
  createPanel(request: CreatePanelRequest): Promise<ToolPanel>;
}

/** Narrow ClaudePanelManager slice — registration only; this door NEVER starts a panel. */
export interface ClaudePanelRegistrarLike {
  registerPanel(panelId: string, sessionId: string, initialState?: ClaudePanelState): void;
}

export interface OpenIdeaSessionCoreDeps {
  getDb(): Database.Database;
  /** The quick-session core's own collaborators (taskQueue / sessionManager / workflowRegistry / getDb / dismiss). */
  quickSession: CreateQuickSessionCoreDeps;
  /** Shared SDK-pinned availability ladder (claudeSdkSessionPreflight.ts). */
  runPreflights(): Promise<ClaudeSdkPreflightResult>;
  panelManager: IdeaSessionPanelManagerLike;
  /**
   * Resolved LAZILY: ipc/claudePanel assigns the manager at boot, long before
   * any Open, but the module-level binding is not readable at wiring time.
   */
  getClaudePanelRegistrar(): ClaudePanelRegistrarLike | undefined;
  /** SessionManager.refreshSessionFromDatabase — re-map + emit `session-updated`. */
  refreshSession(sessionId: string): void;
  /** The FULL safe session-dismiss primitive (dismissSessionFully) used to compensate. */
  dismissSession(sessionId: string): Promise<void>;
}

export type OpenIdeaSessionCoreOptions = OpenIdeaSessionRequest;

/**
 * Runtime shape of the `sessions:open-idea-session` args (fed to
 * `validateInput` at the IPC boundary — docs/CODE-PATTERNS.md "IPC handler input
 * validation"). Declared HERE, beside the door it guards, so it is unit-testable
 * without importing the Electron-bound handler module.
 *
 * `satisfies` pins the parse output to the shared request type: widening the
 * wire type without widening the schema (or vice versa) fails the build.
 */
export const OPEN_IDEA_SESSION_SCHEMA = z.object({
  projectId: z.number().finite(),
  ideaId: z.string().min(1),
}) satisfies z.ZodType<OpenIdeaSessionRequest, OpenIdeaSessionRequest>;

/** Per-failure wording for THIS door (the design doors keep their own). */
const PREFLIGHT_MESSAGES: Readonly<Record<ClaudeSdkPreflightFailure, string>> = {
  provider_disabled:
    'Idea sessions require Claude, which is turned off in Settings → Integrations. Enable Claude to open this idea.',
  claude_not_detected:
    'Idea sessions require the Claude SDK substrate — Claude credentials/binary not detected. Sign in to Claude Code and try again.',
  interactive_pty_only:
    'Idea sessions cannot run on the interactive substrate, but this app is locked to interactive-PTY-only mode. Disable that lock in Settings to open this idea.',
};

interface HomeSessionRow {
  sessionId: unknown;
  chatRunId: unknown;
  runId: unknown;
}

/**
 * The idea's live home session, if any. Scoped to non-archived rows for the same
 * reason migration 115's partial-unique index is: archiving a home RELEASES the
 * idea's slot, so an archived row must not satisfy a later Open.
 */
function findLiveHomeSession(
  db: Database.Database,
  ideaId: string,
): { sessionId: string; chatRunId: string | null } | null {
  const row = db
    .prepare(
      `SELECT id AS sessionId, chat_run_id AS chatRunId, run_id AS runId
         FROM sessions
        WHERE home_idea_id = ? AND (archived = 0 OR archived IS NULL)
        LIMIT 1`,
    )
    .get(ideaId) as HomeSessionRow | undefined;
  if (!row || typeof row.sessionId !== 'string') return null;
  const chatRunId =
    typeof row.chatRunId === 'string' ? row.chatRunId : typeof row.runId === 'string' ? row.runId : null;
  return { sessionId: row.sessionId, chatRunId };
}

/** Session name + worktree-template hint derived from the idea's display ref. */
interface IdeaSessionIdentity {
  /** Worktree/session template fed to createQuickSessionCore's name matcher. */
  nameHint: string;
  /** Final session name, stamped AFTER the core resolves. */
  displayName: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/**
 * Resolve the idea's display identity server-side. `ideas.ref` (e.g. IDEA-009)
 * is the name users recognise; a row without one falls back to a truncated
 * title. The nameHint is kept to `[a-z0-9-]` because createQuickSessionCore
 * embeds it in a RegExp.
 */
export function resolveIdeaSessionIdentity(db: Database.Database, ideaId: string): IdeaSessionIdentity {
  const row = db.prepare(`SELECT ref AS ref, title AS title FROM ideas WHERE id = ?`).get(ideaId) as
    | { ref?: unknown; title?: unknown }
    | undefined;
  const ref = typeof row?.ref === 'string' && row.ref.length > 0 ? row.ref : null;
  if (ref !== null) {
    return { nameHint: slugify(ref) || 'idea-session', displayName: `${ref} · idea` };
  }
  const title = typeof row?.title === 'string' ? row.title.trim() : '';
  const label = title.length > 40 ? `${title.slice(0, 39)}…` : title;
  return {
    nameHint: slugify(title) || 'idea-session',
    displayName: label.length > 0 ? `${label} · idea` : 'idea',
  };
}

/**
 * better-sqlite3 surfaces the partial-unique index (migration 115) as an
 * SqliteError carrying `code: 'SQLITE_CONSTRAINT_UNIQUE'`. The message test is a
 * belt for builds/adapters that only populate the text.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /UNIQUE constraint failed/i.test(message);
}

/**
 * The session's Claude chat panel, created + registered when absent.
 *
 * Deliberately NOT modelled on index.ts's `kickoffDesignPanel`, which also
 * `startPanel`s immediately: an idea session must boot to its canvas, and the
 * first user message starts the panel through `panels:continue`'s
 * first-message branch. Runs on BOTH the found and created paths — panels are
 * deletable, so "the home session already has one" is not an invariant.
 */
export async function ensureRegisteredClaudePanel(
  deps: Pick<OpenIdeaSessionCoreDeps, 'panelManager' | 'getClaudePanelRegistrar'>,
  sessionId: string,
): Promise<string> {
  const existing = deps.panelManager.getPanelsForSession(sessionId).find((p) => p.type === 'claude');
  if (existing) return existing.id;

  const panel = await deps.panelManager.createPanel({ sessionId, type: 'claude', title: 'Chat' });
  const registrar = deps.getClaudePanelRegistrar();
  if (!registrar) {
    throw new Error('the Claude panel manager is not available yet');
  }
  // We just created this panel with type 'claude', so its customState IS a
  // ClaudePanelState — but ToolPanelState.customState is a union with no
  // discriminant tying it to panel.type, so TS cannot see that (same narrowing
  // as index.ts's kickoffDesignPanel).
  registrar.registerPanel(
    panel.id,
    panel.sessionId,
    panel.type === 'claude' ? (panel.state.customState as ClaudePanelState | undefined) : undefined,
  );
  return panel.id;
}

/**
 * Find-or-create the idea's persistent home session. See the module header for
 * the ordering + compensation contracts. Throws {@link OpenIdeaSessionError} for
 * every rejection a user can cause; anything else propagates verbatim.
 */
export async function openIdeaSessionCore(
  deps: OpenIdeaSessionCoreDeps,
  opts: OpenIdeaSessionCoreOptions,
): Promise<OpenIdeaSessionResult> {
  const db = deps.getDb();

  const validation = validateIdeaSessionLink(db, opts.ideaId, opts.projectId);
  if (!validation.ok) {
    throw new OpenIdeaSessionError('invalid_idea', validation.error);
  }

  const existing = findLiveHomeSession(db, opts.ideaId);
  if (existing) {
    return {
      sessionId: existing.sessionId,
      chatRunId: existing.chatRunId,
      claudePanelId: await ensureRegisteredClaudePanel(deps, existing.sessionId),
      created: false,
    };
  }

  // Fail closed BEFORE anything is provisioned — an idea session is hard-pinned
  // to the Claude SDK substrate exactly like a design session.
  const preflight = await deps.runPreflights();
  if (!preflight.ok) {
    throw new OpenIdeaSessionError(preflight.reason, PREFLIGHT_MESSAGES[preflight.reason]);
  }

  const identity = resolveIdeaSessionIdentity(db, opts.ideaId);

  const { session, runId, resolvedSubstrate } = await createQuickSessionCore(deps.quickSession, {
    projectId: opts.projectId,
    nameHint: identity.nameHint,
    // The idea's home lives in the project checkout — it talks to the backlog,
    // it never cuts a branch.
    inPlace: true,
    // Provider/runtime/substrate are HARD-CODED here, never sourced from a
    // request, and requireSdkSubstrate threads createRun's post-resolution guard.
    agentProvider: 'claude',
    agentRuntime: 'claude-sdk',
    requestedSubstrate: 'sdk',
    requireSdkSubstrate: true,
  });

  // --- compensation window: a real session/sentinel now exists ---------------
  try {
    if (resolvedSubstrate !== 'sdk') {
      // Expected unreachable — requireSdkSubstrate already throws inside
      // createRun. Fail closed rather than claim the idea on a substrate whose
      // MCP/tool contract this door never validated.
      throw new OpenIdeaSessionError(
        'substrate_mismatch',
        'Idea sessions require the Claude SDK substrate. The session was created but could not be linked to the idea — please retry.',
      );
    }
    // Persist the RESOLVED substrate/runtime through the shared chokepoint, same
    // as every other quick-session caller — sessions.substrate/agent_runtime are
    // what the chat relay and panel-lane resolution read back.
    stampQuickSessionRuntimeConfig(db, session.id, { resolvedSubstrate });
    // The home claim + its own lineage (an idea session is, trivially, launched
    // from its idea) + the display name, in ONE statement so a UNIQUE rejection
    // leaves nothing half-applied.
    db.prepare(`UPDATE sessions SET home_idea_id = ?, origin_idea_id = ?, name = ? WHERE id = ?`).run(
      opts.ideaId,
      opts.ideaId,
      identity.displayName,
      session.id,
    );
  } catch (err) {
    await deps.dismissSession(session.id).catch(() => {});
    if (isUniqueConstraintViolation(err)) {
      // A concurrent Open won the partial-unique index (migration 115). We are
      // the loser and have just swept ourselves — hand the user the WINNER.
      const winner = findLiveHomeSession(db, opts.ideaId);
      if (winner) {
        return {
          sessionId: winner.sessionId,
          chatRunId: winner.chatRunId,
          claudePanelId: await ensureRegisteredClaudePanel(deps, winner.sessionId),
          created: false,
        };
      }
    }
    throw err;
  }
  // --- compensation window closed -------------------------------------------

  // Raw UPDATEs never reach the renderer; this is what makes the rename + link visible.
  deps.refreshSession(session.id);

  // OUTSIDE the compensation window on purpose: the session is now legitimately
  // the idea's home, so a panel failure must NOT sweep it. The next Open takes
  // the found path and retries the panel.
  const claudePanelId = await ensureRegisteredClaudePanel(deps, session.id);

  return { sessionId: session.id, chatRunId: runId, claudePanelId, created: true };
}

// ---------------------------------------------------------------------------
// Boot-wired singleton (setter pattern, mirroring setStartRunDeps /
// setExperimentsDeps): the IPC handler lives in ipc/session.ts but the
// dismiss/panel/preflight collaborators are only assembled in index.ts.
// ---------------------------------------------------------------------------

let openIdeaSessionDeps: OpenIdeaSessionCoreDeps | null = null;

/** Wire the real collaborators once at boot. Until called, the IPC door rejects. */
export function setOpenIdeaSessionDeps(deps: OpenIdeaSessionCoreDeps): void {
  openIdeaSessionDeps = deps;
}

/** Test-only: drop the boot wiring so a case can assert the unwired rejection. */
export function _resetOpenIdeaSessionDepsForTesting(): void {
  openIdeaSessionDeps = null;
}

/** The boot-wired entry point the `sessions:open-idea-session` handler delegates to. */
export async function openIdeaSession(
  opts: OpenIdeaSessionCoreOptions,
): Promise<OpenIdeaSessionResult> {
  if (!openIdeaSessionDeps) {
    throw new Error('open-idea-session dependencies not wired yet. Call setOpenIdeaSessionDeps() at boot.');
  }
  return openIdeaSessionCore(openIdeaSessionDeps, opts);
}
