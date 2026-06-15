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
const YELLOW = '\x1b[33m';
const NL = '\r\n';

// Visible-width helpers: ANSI SGR codes are zero display-width, so padding /
// alignment math must measure the plain text only.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visLen = (s: string): number => s.replace(ANSI_RE, '').length;

/**
 * Build the Claude Code startup banner sized to the live terminal width — the
 * rounded box (title border + Welcome + mascot + model/account + cwd), the
 * setup-issue line, and the input rule + prompt. Mirrors the real CLI's
 * width-aware paint so a demo PTY session reads unmistakably as Claude Code.
 */
function buildWelcome(cols: number): string {
  const boxWidth = Math.max(40, Math.min(cols, 88));
  const inner = boxWidth - 2; // columns between the │ borders

  // Centered content row within the box.
  const row = (content: string): string => {
    const pad = Math.max(0, inner - visLen(content));
    const left = Math.floor(pad / 2);
    return `${ORANGE}│${RESET}${' '.repeat(left)}${content}${' '.repeat(pad - left)}${ORANGE}│${RESET}`;
  };
  const blank = row('');

  // Top border carries the title (✻ Claude Code vX.Y.Z), like the real CLI.
  const title = `${ORANGE}${BOLD}✻ Claude Code${RESET} ${DIM}v2.1.36${RESET}`;
  const titleVis = visLen(title);
  const topDashes = Math.max(0, inner - 2 - titleVis); // 1 lead dash + 1 trailing space
  const top = `${ORANGE}╭─${RESET} ${title} ${ORANGE}${'─'.repeat(topDashes)}╮${RESET}`;
  const bottom = `${ORANGE}╰${'─'.repeat(inner)}╯${RESET}`;

  // Small terracotta mascot — simple framed face that renders everywhere.
  const face = [`${ORANGE}╭─────╮${RESET}`, `${ORANGE}│ ▪ ▪ │${RESET}`, `${ORANGE}╰─────╯${RESET}`];

  const lines = [
    top,
    blank,
    row(`${BOLD}Welcome back!${RESET}`),
    blank,
    ...face.map(row),
    blank,
    row(`${DIM}Opus 4.8 (1M context) · Claude Max${RESET}`),
    blank,
    row(`${DIM}~/project${RESET}`),
    blank,
    bottom,
    '',
    ` ${YELLOW}⚠${RESET} ${DIM}1 setup issue: MCP ·${RESET} ${DIM}/doctor${RESET}`,
    '',
    `${DIM}${'─'.repeat(Math.min(cols, boxWidth))}${RESET}`,
    '',
  ];
  return lines.join(NL);
}

/** The canned opening turn that plays after the banner, as an ordered list of
 *  {@link Chunk}s. `delay` is the pause (ms) BEFORE the chunk is written, giving
 *  a streaming feel. Under reduced motion every delay is collapsed to 0.
 *
 *  This mirrors the cyboflow PTY preamble a real interactive quick session
 *  receives as its first prompt (`QUICK_PTY_BRIEFING` in main/src/ipc/session.ts)
 *  followed by the agent's brief acknowledgement — so the demo terminal reads
 *  like a real freshly-briefed quick session. Kept in sync by hand (display-only
 *  copy; the renderer cannot import main-process source). */
interface Chunk {
  text: string;
  delay: number;
}

const SESSION_INTRO: Chunk[] = [
  { text: `${DIM}›${RESET} ${DIM}You are running inside cyboflow, a desktop app that manages${RESET}${NL}`, delay: 600 },
  { text: `${DIM}  parallel AI coding sessions in isolated git worktrees.${RESET}${NL}`, delay: 60 },
  { text: `${NL}${DIM}  Session context:${RESET}${NL}`, delay: 120 },
  { text: `${DIM}  - This is a user-driven quick session: no predefined workflow,${RESET}${NL}`, delay: 60 },
  { text: `${DIM}    no step ceremony — just you and the user.${RESET}${NL}`, delay: 60 },
  { text: `${DIM}  - Your working directory is a dedicated git worktree for this${RESET}${NL}`, delay: 60 },
  { text: `${DIM}    session; commits stay local to its branch.${RESET}${NL}`, delay: 60 },
  { text: `${DIM}  - A "cyboflow" MCP server is connected; its tools write to${RESET}${NL}`, delay: 60 },
  { text: `${DIM}    cyboflow's project database (tasks/backlog).${RESET}${NL}`, delay: 60 },
  { text: `${NL}${DIM}  Acknowledge briefly and wait for the user's instructions.${RESET}${NL}${NL}`, delay: 120 },
  { text: `${ORANGE}●${RESET} Understood — I'm set up in this cyboflow worktree on its own${NL}  branch, with the cyboflow MCP tools available. What would you${NL}  like to work on?${NL}${NL}`, delay: 900 },
  { text: `${DIM}›${RESET} `, delay: 300 },
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

    // Play the canned session once the terminal is measured: paint the
    // width-aware Claude Code banner immediately, then stream the coding
    // exchange. Each chunk is queued at its cumulative delay; reduced motion
    // collapses every delay to 0.
    const playScript = (): void => {
      if (scriptStarted) return;
      scriptStarted = true;
      term.write(buildWelcome(term.cols));
      term.scrollToBottom();
      let elapsedDelay = 0;
      for (const chunk of SESSION_INTRO) {
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
