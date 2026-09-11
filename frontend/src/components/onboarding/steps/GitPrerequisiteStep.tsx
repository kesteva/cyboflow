import type { GitPrerequisiteResult } from '../../../../../shared/types/gitPrerequisite';

/** Draft of the identity form — controlled by the gate, written on Save. */
export interface GitIdentityDraft {
  name: string;
  email: string;
}

interface GitPrerequisiteStepProps {
  result: GitPrerequisiteResult;
  /** A probe is in flight ("Check again" / Save). */
  checking: boolean;
  identity: GitIdentityDraft;
  onIdentityChange: (draft: GitIdentityDraft) => void;
  /** The last Save's failure message, if any. */
  error: string | null;
  onRecheck: () => void;
  onDownload: () => void;
}

/** Per-platform install lines — the card shows the host's only. */
const INSTALL_LINES: Record<GitPrerequisiteResult['platform'], ReadonlyArray<{ label: string; command: string }>> = {
  win32: [{ label: 'winget', command: 'winget install --id Git.Git -e --source winget' }],
  darwin: [
    { label: 'Xcode tools', command: 'xcode-select --install' },
    { label: 'Homebrew', command: 'brew install git' },
  ],
  linux: [
    { label: 'Debian / Ubuntu', command: 'sudo apt install git' },
    { label: 'Fedora', command: 'sudo dnf install git' },
  ],
};

function GhostButton({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border border-border-primary bg-transparent px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[.1em] text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary"
    >
      {label}
    </button>
  );
}

function Code({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <code className="border border-border-primary bg-bg-primary px-1">{children}</code>;
}

/**
 * The git prerequisite card — NOT a tour step. Rendered by the gate in front of
 * whichever modal step the tour is on while the boot probe reports git as
 * missing or identity-less (shared/types/gitPrerequisite.ts), and gone the
 * moment a re-probe clears. Two bodies, one per blocked state:
 *   'missing'  — install lines for this platform + a download link; the footer
 *                primary is "Check again".
 *   'identity' — name/email fields written with `git config --global`; the
 *                footer primary is "Save & continue".
 */
export function GitPrerequisiteStep({
  result,
  checking,
  identity,
  onIdentityChange,
  error,
  onRecheck,
  onDownload,
}: GitPrerequisiteStepProps): React.JSX.Element {
  if (result.state === 'missing') {
    return (
      <div className="px-6 pb-3 pt-5">
        <div className="mb-3 text-[12px] leading-[1.6] text-text-primary">
          Cyboflow could not find git on this machine. Every session runs in its own git worktree, so
          nothing can start without it.
        </div>
        <div className="border border-border-primary bg-[var(--paper-3)] px-3.5 py-2.5 text-[10px] leading-[1.55] text-text-secondary">
          <div className="mb-1.5 font-bold text-text-primary">Install git, then check again</div>
          {INSTALL_LINES[result.platform].map((line) => (
            <div key={line.command} className="mt-1">
              {line.label}: <Code>{line.command}</Code>
            </div>
          ))}
          <div className="mt-2 flex flex-wrap gap-2">
            <GhostButton label="Download git" onClick={onDownload} />
          </div>
        </div>
        <div className="mt-3 text-[10px] leading-[1.5] text-text-tertiary">
          {checking
            ? 'Looking for git…'
            : 'Already installed? Cyboflow searches your shell PATH and the standard install locations on every check.'}
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 pb-3 pt-5">
      <div className="mb-3 text-[12px] leading-[1.6] text-text-primary">
        Git is installed{result.binary.version ? ` (${result.binary.version})` : ''}, but it has no name and
        email to sign commits with. Cyboflow and its agents commit on your behalf, so git needs to know
        who you are.
      </div>
      <label htmlFor="git-identity-name" className="mb-[5px] block text-[9px] font-bold tracking-[.14em] text-text-tertiary">
        NAME
      </label>
      <input
        id="git-identity-name"
        type="text"
        value={identity.name}
        autoFocus={!identity.name}
        spellCheck={false}
        placeholder="Ada Lovelace"
        onChange={(e) => onIdentityChange({ ...identity, name: e.target.value })}
        className="mb-3.5 w-full border-[1.4px] border-border-emphasized bg-surface-primary px-3.5 py-[11px] text-[12px] text-text-primary caret-interactive outline-none placeholder:text-text-tertiary"
      />
      <label htmlFor="git-identity-email" className="mb-[5px] block text-[9px] font-bold tracking-[.14em] text-text-tertiary">
        EMAIL
      </label>
      <input
        id="git-identity-email"
        type="email"
        value={identity.email}
        autoFocus={Boolean(identity.name) && !identity.email}
        spellCheck={false}
        placeholder="ada@example.com"
        onChange={(e) => onIdentityChange({ ...identity, email: e.target.value })}
        className="mb-3.5 w-full border-[1.4px] border-border-emphasized bg-surface-primary px-3.5 py-[11px] text-[12px] text-text-primary caret-interactive outline-none placeholder:text-text-tertiary"
      />
      {error && <div className="-mt-2 mb-3 text-[10px] leading-[1.55] text-status-error">{error}</div>}
      <div className="text-[10px] leading-[1.5] text-text-tertiary">
        Saved with <Code>git config --global</Code> — the same thing you'd run in a terminal. Already set
        it elsewhere?{' '}
        <button
          type="button"
          onClick={onRecheck}
          className="border-none bg-transparent p-0 text-[10px] text-text-secondary underline hover:text-text-primary"
        >
          Check again
        </button>
        .
      </div>
    </div>
  );
}
