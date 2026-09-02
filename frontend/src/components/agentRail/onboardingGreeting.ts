/**
 * One-shot assistant greeting handed off by the onboarding finale.
 *
 * The guided set-up's last act (guided/guidedFinish.ts) primes a greeting for
 * the project it just added; the rail is UNMOUNTED at that moment (the tour
 * hides the shell), so the message cannot be pushed into React state — it is
 * parked in localStorage and picked up by AgentThreadView's first mount, which
 * prepends it as a synthetic transcript message. No SDK turn, no DB row.
 *
 * peek/clear are deliberately SEPARATE operations: the app runs under
 * <React.StrictMode>, whose double-invoked state initializers would consume a
 * read-and-delete helper on the first (discarded) pass and lose the greeting.
 * The read is non-destructive; the mount effect does the clearing.
 */

/** localStorage key holding the pending greeting. Brand-new key — no migration. */
export const GREETING_KEY = 'cyboflow.agentRail.onboardingGreeting';

/** Persisted payload — the project name only; the sentence is built on read. */
interface StoredGreeting {
  projectName: string;
}

/** Park a greeting for the next AgentThreadView mount. Best-effort. */
export function primeAssistantGreeting(projectName: string): void {
  const payload: StoredGreeting = { projectName };
  try {
    localStorage.setItem(GREETING_KEY, JSON.stringify(payload));
  } catch {
    // localStorage unavailable (private mode, blocked storage) — the finale's
    // other effects still stand; the user just gets no greeting.
  }
}

/**
 * The pending greeting's text, or null when none is parked (or the payload is
 * unreadable). NON-DESTRUCTIVE — call clearAssistantGreeting() once the
 * component that renders it has actually mounted.
 */
export function peekAssistantGreeting(): string | null {
  try {
    const raw = localStorage.getItem(GREETING_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const name = (parsed as Partial<StoredGreeting>).projectName;
    if (typeof name !== 'string' || name === '') return null;
    return `${name} is set up. If you need more help, ask me questions at any time.`;
  } catch {
    // Unparseable or unreadable — treat exactly like "nothing parked".
    return null;
  }
}

/** Drop the pending greeting. Idempotent; safe to call when none exists. */
export function clearAssistantGreeting(): void {
  try {
    localStorage.removeItem(GREETING_KEY);
  } catch {
    // localStorage unavailable — nothing was ever written either.
  }
}
