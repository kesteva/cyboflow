/**
 * HostTerminalManager — interactive `ssh` PTYs for the Environments "Open terminal" action.
 *
 * Modeled on RunShellManager: the node-pty spawner is injected (`ShellSpawner`) so the class is
 * unit-testable without the native module, and bytes leave through `emitBytes` (the caller sends
 * them on `cyboflow:shell:<terminalId>`). Differences: the spawned command is `ssh -tt … -- <target>`
 * (no BatchMode: the user may need to answer a prompt), the cwd is the home directory, and an
 * exited terminal is KEPT (backlog readable, exited/exitCode set) until `closeOne` — or until a new open needs
 * its slot: the open-terminal cap counts LIVE terminals only, and the oldest exited entry is evicted first.
 * `onExit` pushes the exit to the renderer (the view reads `exited` only once, at mount).
 */
import * as os from 'os';
import { getShellPath } from '../../utils/shellPath';
import { stampSpawnMarker } from '../../utils/spawnMarker';
import { redactSecrets } from '../telemetry/scrub';
import type { ManagedPty, ShellSpawner } from '../runShellManager';
import { SSH_TARGET_RE } from '../../../../shared/types/hosts';
import { HostTerminalUnavailableError, InvalidSshTargetError } from '../../orchestrator/hosts/errors';

interface HostTerminal {
  pty: ManagedPty;
  terminalId: string;
  hostId: string;
  backlog: string;
  exited: boolean;
  exitCode: number | null;
}

export interface OwnedHostShell {
  pid: number;
  terminalId: string;
  hostId: string;
}

const DEFAULT_MAX_OPEN = 8;
const MAX_BACKLOG = 256_000;

export class HostTerminalManager {
  private readonly terminals = new Map<string, HostTerminal>();
  private nextN = 1;
  private readonly homedir: () => string;
  private readonly maxOpen: number;
  private readonly onExit: ((terminalId: string, exitCode: number | null) => void) | undefined;

  constructor(
    /** Push a raw PTY chunk to the renderer (wired to `cyboflow:shell:<terminalId>`). */
    private readonly emitBytes: (terminalId: string, chunk: string) => void,
    /** node-pty spawner (production: `pty.spawn`; tests: a fake). */
    private readonly spawn: ShellSpawner,
    opts?: {
      homedir?: () => string;
      maxOpen?: number;
      /** The ssh process exited (on its own, or killed by a close). Never throws back into the PTY callback. */
      onExit?: (terminalId: string, exitCode: number | null) => void;
    },
  ) {
    this.homedir = opts?.homedir ?? os.homedir;
    this.maxOpen = opts?.maxOpen ?? DEFAULT_MAX_OPEN;
    this.onExit = opts?.onExit;
  }

  /** Make room for one more terminal: evict the oldest EXITED entry; throw only when every slot is live. */
  private reserveSlot(): void {
    if (this.terminals.size < this.maxOpen) return;
    for (const [terminalId, term] of this.terminals) {
      if (!term.exited) continue;
      this.terminals.delete(terminalId); // Map order = open order, so this is the oldest exited one
      return;
    }
    throw new HostTerminalUnavailableError();
  }

  open(hostId: string, sshTarget: string): string {
    if (!SSH_TARGET_RE.test(sshTarget)) throw new InvalidSshTargetError();
    this.reserveSlot();

    const cwd = this.homedir();
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: getShellPath(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
    };
    // A user terminal must carry no run-scoped cyboflow context or the orch bearer token.
    delete env.CYBOFLOW_RUN_ID;
    delete env.CYBOFLOW_ORCH_SOCKET;
    delete env.CYBOFLOW_ORCH_TOKEN;
    delete env.CYBOFLOW_RUN_ARTIFACTS_DIR;

    const ptyProcess = this.spawn(
      'ssh',
      ['-tt', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '--', sshTarget],
      { name: 'xterm-color', cols: 80, rows: 30, cwd, env: stampSpawnMarker(env, cwd) },
    );

    const terminalId = `host::${hostId}::t${this.nextN++}`;
    const term: HostTerminal = { pty: ptyProcess, terminalId, hostId, backlog: '', exited: false, exitCode: null };
    this.terminals.set(terminalId, term);

    ptyProcess.onData((data) => {
      term.backlog += data;
      if (term.backlog.length > MAX_BACKLOG) term.backlog = term.backlog.slice(-MAX_BACKLOG);
      this.emitBytes(terminalId, data);
    });
    ptyProcess.onExit((event) => {
      term.exited = true;
      term.exitCode = event.exitCode;
      try {
        this.onExit?.(terminalId, event.exitCode);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[HostTerminalManager] exit listener threw for ${terminalId}:`, redactSecrets(msg));
      }
    });
    return terminalId;
  }

  write(terminalId: string, text: string): void {
    const term = this.terminals.get(terminalId);
    if (!term || term.exited) return;
    term.pty.write(text);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const term = this.terminals.get(terminalId);
    if (!term || term.exited) return;
    if (cols <= 0 || rows <= 0) return;
    term.pty.resize(cols, rows);
  }

  getBacklog(terminalId: string): { backlog: string; exited: boolean; exitCode: number | null } {
    const term = this.terminals.get(terminalId);
    if (!term) return { backlog: '', exited: true, exitCode: null };
    return { backlog: term.backlog, exited: term.exited, exitCode: term.exitCode };
  }

  closeOne(terminalId: string): void {
    const term = this.terminals.get(terminalId);
    if (!term) return;
    this.kill(term);
    this.terminals.delete(terminalId);
  }

  closeForHost(hostId: string): void {
    for (const [terminalId, term] of this.terminals) {
      if (term.hostId !== hostId) continue;
      this.kill(term);
      this.terminals.delete(terminalId);
    }
  }

  destroyAll(): void {
    for (const term of this.terminals.values()) this.kill(term);
    this.terminals.clear();
  }

  /** Live (not exited) terminals with a real pid, for the process snapshot's shared `ps` scan. */
  listOwnedShells(): OwnedHostShell[] {
    const owned: OwnedHostShell[] = [];
    for (const term of this.terminals.values()) {
      if (term.exited) continue;
      const pid = term.pty.pid;
      if (!Number.isInteger(pid) || pid <= 0) continue;
      owned.push({ pid, terminalId: term.terminalId, hostId: term.hostId });
    }
    return owned;
  }

  private kill(term: HostTerminal): void {
    if (term.exited) return;
    try {
      term.pty.kill();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[HostTerminalManager] Error killing terminal ${term.terminalId}:`, redactSecrets(msg));
    }
  }
}
