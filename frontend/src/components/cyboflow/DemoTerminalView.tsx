/**
 * DemoTerminalView — a canned, NON-interactive xterm.js playback of a generic
 * Claude Code session, used ONLY in demo mode to illustrate the interactive PTY
 * substrate without spawning a real `claude` REPL.
 *
 * It mirrors the visible chrome of {@link InteractiveTerminalView} (INTERACTIVE
 * pill + LIVE PTY bar) so a PTY-mode quick session in demo looks identical to a
 * live one, but everything is client-side: there is NO `cyboflow:pty:<runId>`
 * subscription, NO relay, and NO backend process. A scripted typewriter writes a
 * believable Claude Code startup + short coding exchange into the terminal, then
 * rests at an idle prompt. With `showComposer`, a cosmetic composer echoes the
 * typed line and a canned acknowledgement back into the terminal (still entirely
 * local — it never touches `sessions:input`).
 *
 * The xterm construct / deferred-open / fit / dispose lifecycle is the same
 * defer-until-measured pattern as InteractiveTerminalView (open only once the
 * container has a non-zero layout box; a ResizeObserver + rAF drive the first
 * open) so it is safe inside a flex child and under React 18 StrictMode.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Send } from 'lucide-react';
import { getTerminalTheme } from '../../utils/terminalTheme';
import { Button } from '../ui/Button';
import { cn } from '../../utils/cn';
import '@xterm/xterm/css/xterm.css';

/** Resolve the monospace font stack from `--font-family-mono`, falling back to
 *  `'monospace'` — matches InteractiveTerminalView so the demo terminal honors
 *  the active theme's mono font. */
function getCSSMonoFont(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-family-mono')
    .trim();
  return value || 'monospace';
}

/** Track `prefers-reduced-motion: reduce`. When set, the typewriter writes the
 *  whole script at once and the pulsing dots stop. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    setReduced(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Live elapsed counter for the LIVE PTY bar, formatted `Xm YYs`. */
function useElapsed(): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

// ANSI helpers — kept terse and inline so the script below reads close to what
// it paints. xterm has convertEol:false, so every newline is an explicit \r\n.
const RESET = '\x1b[0m';
const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';
const ORANGE = '\x1b[38;5;208m';
const GREEN = '\x1b[32m';
const NL = '\r\n';

/** The canned generic Claude Code session, as an ordered list of
 *  {@link Chunk}s. `delay` is the pause (ms) BEFORE the chunk is written, giving
 *  a streaming feel. Under reduced motion every delay is collapsed to 0. */
interface Chunk {
  text: string;
  delay: number;
}

const SCRIPT: Chunk[] = [
  { text: `${ORANGE}✻${RESET} ${BOLD}Welcome to Claude Code${RESET} ${DIM}v2.0.1${RESET}${NL}`, delay: 120 },
  { text: `${DIM}  /help for help · cwd: ~/project${RESET}${NL}${NL}`, delay: 220 },
  { text: `${DIM}>${RESET} Add input validation to the signup form${NL}${NL}`, delay: 500 },
  { text: `${ORANGE}●${RESET} I'll add validation to the signup form. Let me look at the${NL}  component first.${NL}${NL}`, delay: 650 },
  { text: `${GREEN}●${RESET} ${BOLD}Read${RESET} src/components/SignupForm.tsx ${DIM}(142 lines)${RESET}${NL}`, delay: 600 },
  { text: `${GREEN}●${RESET} ${BOLD}Edit${RESET} src/components/SignupForm.tsx${NL}`, delay: 700 },
  { text: `${DIM}   ⎿  Added email + password validation with inline errors${RESET}${NL}${NL}`, delay: 400 },
  { text: `${ORANGE}●${RESET} Done. The form now validates the email format and requires an${NL}  8+ character password, surfacing inline errors before submit.${NL}${NL}`, delay: 800 },
  { text: `${DIM}─────────────────────────────────────────────${RESET}${NL}`, delay: 300 },
  { text: `${DIM}>${RESET} `, delay: 200 },
];

export function DemoTerminalView({
  showComposer = false,
}: {
  /** Render the cosmetic composer beneath the terminal (quick-session use). The
   *  Terminal-tab use omits it. */
  showComposer?: boolean;
}): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const elapsed = useElapsed();

  const [text, setText] = useState('');

  // Append a cosmetic user turn + canned acknowledgement to the live terminal.
  // Purely client-side — no backend round-trip.
  const handleSend = useCallback((): void => {
    const term = termRef.current;
    const trimmed = text.trim();
    if (!term || trimmed.length === 0) return;
    term.write(
      `${trimmed}${NL}${NL}${ORANGE}●${RESET} ${DIM}(demo)${RESET} Got it — in a live session I'd act on that` +
        ` now.${NL}${NL}${DIM}>${RESET} `,
    );
    term.scrollToBottom();
    setText('');
  }, [text]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let opened = false;
    let renderable = false;
    let scriptStarted = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const term = new Terminal({
      fontSize: 14,
      fontFamily: getCSSMonoFont(),
      theme: getTerminalTheme(),
      scrollback: 5000,
      // Cosmetic only — the demo terminal never accepts keystrokes.
      disableStdin: true,
      cursorBlink: !reducedMotion,
      convertEol: false,
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);

    // Play the canned script once the terminal is measured. Each chunk is queued
    // at its cumulative delay; reduced motion collapses every delay to 0.
    const playScript = (): void => {
      if (scriptStarted) return;
      scriptStarted = true;
      let elapsedDelay = 0;
      for (const chunk of SCRIPT) {
        elapsedDelay += reducedMotion ? 0 : chunk.delay;
        timers.push(
          setTimeout(() => {
            if (disposed) return;
            term.write(chunk.text);
            term.scrollToBottom();
          }, elapsedDelay),
        );
      }
    };

    const ensureRenderable = (): void => {
      if (disposed || renderable) return;
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
      if (!opened) {
        term.open(container);
        opened = true;
      }
      try {
        fit.fit();
      } catch {
        return;
      }
      renderable = true;
      playScript();
    };

    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      if (!renderable) {
        ensureRenderable();
        return;
      }
      try {
        fit.fit();
      } catch {
        /* renderer not measurable yet — a later tick retries */
      }
    });
    resizeObserver.observe(container);

    // Defer the first open to the next frame so React 18 StrictMode's
    // mount→dispose→mount can cancel the throwaway instance's open before its
    // syncScrollArea timeout fires on a disposed renderer (same rationale as
    // InteractiveTerminalView).
    let openRaf: number | undefined = requestAnimationFrame(() => {
      openRaf = undefined;
      ensureRenderable();
    });

    return () => {
      disposed = true;
      if (openRaf !== undefined) cancelAnimationFrame(openRaf);
      for (const t of timers) clearTimeout(t);
      resizeObserver.disconnect();
      if (termRef.current === term) termRef.current = null;
      try {
        fit.dispose();
      } catch {
        /* ignore double-dispose */
      }
      try {
        term.dispose();
      } catch {
        /* ignore double-dispose */
      }
    };
  }, [reducedMotion]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full w-full flex-col" data-testid="demo-terminal-view">
      {/* INTERACTIVE pill — mirrors InteractiveTerminalView's pane-head chrome. */}
      <div className="flex items-center px-3 py-1.5" data-testid="demo-terminal-pane-head">
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-interactive px-2 py-0.5 font-semibold uppercase text-interactive"
          style={{ fontSize: '9px', letterSpacing: '0.16em' }}
        >
          <span
            className={cn(
              'inline-block h-1.5 w-1.5 rounded-full bg-interactive',
              !reducedMotion && 'animate-pulse',
            )}
            aria-hidden="true"
          />
          INTERACTIVE
        </span>
      </div>

      {/* LIVE PTY session bar — presentational; values are illustrative. */}
      <div
        className="flex items-center gap-3 border-b border-dashed border-border-primary bg-bg-secondary px-3 py-1"
        style={{ fontSize: '11px' }}
        data-testid="demo-terminal-pty-bar"
      >
        <span
          className="inline-flex items-center gap-1.5 font-bold uppercase text-interactive"
          style={{ fontSize: '9px', letterSpacing: '0.16em' }}
        >
          <span
            className={cn(
              'inline-block h-1.5 w-1.5 rounded-full bg-interactive',
              !reducedMotion && 'animate-pulse',
            )}
            aria-hidden="true"
          />
          LIVE PTY
        </span>
        <span className="text-text-secondary">
          <span className="font-semibold text-text-primary">claude --resume</span>
        </span>
        <span className="text-text-tertiary">pid 48213</span>
        <span className="text-text-tertiary">ttys001</span>
        <span className="ml-auto tabular-nums text-text-tertiary">{elapsed}</span>
        <span className="tabular-nums text-text-tertiary">↑ 0k tok</span>
      </div>

      {/* Terminal surface */}
      <div className="min-h-0 flex-1" data-testid="demo-terminal-surface">
        <div ref={containerRef} className="h-full w-full" />
      </div>

      {showComposer && (
        <div
          className="flex flex-col gap-1 border-t border-border-primary bg-bg-primary p-2 shrink-0"
          data-testid="demo-terminal-composer"
        >
          <div className="flex flex-col border border-border-primary bg-surface-primary transition-colors focus-within:border-border-hover">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message the live session…"
              rows={2}
              className="w-full resize-none bg-transparent px-3 pt-2 pb-1 text-xs text-text-primary placeholder-text-tertiary focus:outline-none"
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-2">
              <span className="text-[10px] text-text-tertiary">Demo session · input is illustrative</span>
              <Button
                size="sm"
                variant="primary"
                disabled={text.trim().length === 0}
                onClick={handleSend}
                className="gap-1.5"
              >
                <Send className="h-3.5 w-3.5" />
                Send
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DemoTerminalView;
