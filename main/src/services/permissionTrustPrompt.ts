import type { BrowserWindow, MessageBoxOptions } from 'electron';
import type { Project } from '../database/models';
import { projectSettingsContainAllowRules } from '../orchestrator/permissionRules';
import type { StreamEventPublisher } from '../orchestrator/runLauncher';

type PermissionTrust = NonNullable<Project['permission_trust']>;

export interface PermissionTrustPromptDeps {
  getProject(projectId: number): Project | undefined;
  updateProject(projectId: number, updates: { permission_trust: PermissionTrust }): unknown;
  getMainWindow(): BrowserWindow | null;
  /** `dialog.showMessageBox`, injected so this module never imports electron at runtime. */
  showMessageBox(window: BrowserWindow | null, options: MessageBoxOptions): Promise<{ response: number }>;
  /** Defaults to {@link projectSettingsContainAllowRules}; overridable for tests. */
  containsAllowRules?: (projectPath: string) => boolean;
}

/**
 * One-time per-project trust prompt for repo-supplied permission ALLOW rules
 * (migration 127). `permission_trust` is terminal once set, either answer, so
 * a project is asked at most once ever. Skips entirely when the project's
 * `.claude/settings*` carries no `allow` rules, since there is nothing to
 * decide trust over.
 *
 * Two triggers share one instance: project creation (`projects:create`) and
 * the first session/run launch in a project whose `permission_trust` is still
 * NULL (wired in main/src/index.ts) — the latter is what reaches projects that
 * predate migration 127. The in-process `attempted` set guarantees the dialog
 * is shown at most once per project per app run, so concurrent launches (or a
 * launch right after creation, before the user answers) never stack dialogs.
 *
 * Callers fire-and-forget: the dialog must never block the create/launch it
 * rides on. Fail-soft — any error here is logged and swallowed.
 */
export class PermissionTrustPrompter {
  private readonly attempted = new Set<number>();

  constructor(private readonly deps: PermissionTrustPromptDeps) {}

  /** Launch-time trigger: resolve the project by id, then {@link maybePrompt}. */
  async maybePromptForProject(projectId: number | undefined): Promise<void> {
    if (projectId === undefined || this.attempted.has(projectId)) return;
    let project: Project | undefined;
    try {
      project = this.deps.getProject(projectId);
    } catch (error) {
      console.error('[Main] Permission-trust prompt: project lookup failed (continuing):', error);
      return;
    }
    await this.maybePrompt(project);
  }

  async maybePrompt(project: Project | undefined): Promise<void> {
    if (!project) return;
    if (project.permission_trust != null) return; // already decided ('trusted' | 'untrusted')
    if (this.attempted.has(project.id)) return;
    this.attempted.add(project.id);

    try {
      const containsAllowRules = this.deps.containsAllowRules ?? projectSettingsContainAllowRules;
      if (!containsAllowRules(project.path)) return; // nothing to trust

      const options: MessageBoxOptions = {
        type: 'question',
        title: 'Trust project permission rules?',
        message: `"${project.name}" ships permission allow rules`,
        detail:
          `This project's .claude/settings.json (or settings.local.json) contains ` +
          `permission "allow" rules. By default cyboflow only honors allow rules from your ` +
          `personal ~/.claude/settings.json — a repo cannot grant itself auto-approval.\n\n` +
          `Trusting this project lets commands matching ITS allow list run without an approval ` +
          `prompt in sessions of this project, same as if they were in your personal settings. ` +
          `Only do this for repos you trust.`,
        buttons: ['Trust This Project', "Don't Trust"],
        defaultId: 1, // "Don't Trust" — the safe choice, including on Escape/close.
        cancelId: 1,
        noLink: true,
      };
      const result = await this.deps.showMessageBox(this.deps.getMainWindow(), options);

      const permission_trust: PermissionTrust = result.response === 0 ? 'trusted' : 'untrusted';
      this.deps.updateProject(project.id, { permission_trust });
    } catch (error) {
      console.error('[Main] Permission-trust prompt failed (continuing):', error);
    }
  }
}

/**
 * Run-launch trigger: wraps the publisher RunLauncher emits its synthetic
 * `run_started` envelope through (once per launch), so a run started on an
 * EXISTING session in an undecided project still reaches the prompt. New
 * sessions are covered separately by the `session-created` listener.
 */
export function withRunStartedTrustPrompt(
  publisher: StreamEventPublisher,
  prompter: PermissionTrustPrompter,
  getRunProjectId: (runId: string) => number | undefined,
): StreamEventPublisher {
  return {
    publish: (runId, event) => {
      publisher.publish(runId, event);
      if (event.type !== 'run_started') return;
      let projectId: number | undefined;
      try {
        projectId = getRunProjectId(runId);
      } catch (error) {
        console.error('[Main] Permission-trust prompt: run lookup failed (continuing):', error);
        return;
      }
      void prompter.maybePromptForProject(projectId);
    },
  };
}
