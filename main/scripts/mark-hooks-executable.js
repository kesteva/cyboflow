#!/usr/bin/env node
/**
 * mark-hooks-executable — chmod +x the compiled shell-hook scripts after `tsc`.
 *
 * The interactive-substrate PreToolUse gate (interactiveSettingsWriter) registers
 * `preToolUseShellHook.js` as a BARE-PATH hook command, so Claude Code execs it via
 * `/bin/sh` — which requires the file's execute bit plus its `#!/usr/bin/env node`
 * shebang. `tsc` emits `.js` at mode 644, so without this step a clean build leaves
 * the gate non-executable and it fails OPEN at runtime
 * ("/bin/sh: …/preToolUseShellHook.js: Permission denied" → tool proceeds ungated).
 *
 * electron-builder preserves dist file modes into the `asar.unpacked` dir, so
 * marking the file here fixes both dev (`pnpm build:main`) and packaged builds.
 * Runs in the `main` build chain after `tsc`; a no-op if the dir is absent.
 */
const fs = require('fs');
const path = require('path');

const HOOKS_DIR = path.join(__dirname, '..', 'dist', 'main', 'src', 'orchestrator', 'shellHooks');

let marked = 0;
try {
  for (const entry of fs.readdirSync(HOOKS_DIR)) {
    if (path.extname(entry) !== '.js') continue;
    fs.chmodSync(path.join(HOOKS_DIR, entry), 0o755);
    marked += 1;
  }
} catch (err) {
  if (err && err.code === 'ENOENT') {
    console.warn('[mark-hooks-executable] no compiled shellHooks dir — skipping (run after tsc)');
    process.exit(0);
  }
  throw err;
}
console.log(`[mark-hooks-executable] chmod +x ${marked} shell-hook script(s)`);
