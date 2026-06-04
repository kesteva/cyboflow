#!/usr/bin/env node
/**
 * copy-workflow-assets — recursively copy every `*.md` under
 * `src/orchestrator/workflows/` into the compiled bundle at
 * `dist/main/src/orchestrator/workflows/`, PRESERVING directory structure.
 *
 * Replaces the former `cp src/orchestrator/workflows/*.md dist/...` step (which
 * copied only the top-level prose `.md`). It now also ships each flow's
 * co-located invokable bundle — `<name>/commands/*.md` and `<name>/agents/*.md`
 * (IDEA-013 rung-(ii)) — so `resolveWorkflowBundle(workflow_path)` finds the
 * sibling command/agent files at runtime in both dev and packaged builds.
 *
 * Robust by construction: skips `__tests__`, ignores `.ts`/non-`.md` files, and
 * no-ops cleanly when a flow has no bundle dir. CommonJS to match the other
 * build helpers in this directory.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'orchestrator', 'workflows');
const DEST = path.join(__dirname, '..', 'dist', 'main', 'src', 'orchestrator', 'workflows');

let copied = 0;

function walk(dir, rel) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing src dir — nothing to copy
  }
  for (const entry of entries) {
    const srcPath = path.join(dir, entry.name);
    const relPath = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      walk(srcPath, relPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const destPath = path.join(DEST, relPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      copied += 1;
    }
  }
}

walk(SRC, '');
console.log(`[copy-workflow-assets] copied ${copied} workflow markdown file(s) to dist`);
