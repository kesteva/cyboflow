const js = require('@eslint/js');
const typescript = require('typescript-eslint');
const executionFsExemptions = require('./eslint/executionFsExemptions.json');

module.exports = [
  js.configs.recommended,
  ...typescript.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: typescript.parser
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-require-imports': 'warn', // Downgrade to warning
      'no-console': 'off', // Allow console in main process
      'no-useless-escape': 'warn', // Downgrade to warning
      'prefer-const': 'warn', // Downgrade to warning
      'no-empty': 'warn' // Downgrade to warning
    }
  },
  {
    // Standalone-typecheck invariant (docs/ARCHITECTURE.md → "Team-tier v2"):
    // main/src/orchestrator/** must stay extractable to a plain Node service, so
    // it may not reach for Electron or for a concrete service implementation.
    // The seam is a DatabaseLike-style interface or a value injected by the boot
    // wiring in main/src/index.ts.
    //
    // `allowTypeImports` is on because a type-only import is erased by tsc and so
    // never binds the extracted service to anything at runtime. The companion
    // ratchet test (src/orchestrator/__tests__/standaloneInvariant.test.ts) scans
    // the same tree for dynamic `require('electron')`, which no import rule sees,
    // and holds the frozen exemption list.
    files: ['src/orchestrator/**/*.ts'],
    ignores: [
      'src/orchestrator/**/*.test.ts',
      'src/orchestrator/**/*.itest.ts',
      'src/orchestrator/**/__tests__/**'
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{
          name: 'electron',
          message:
            'orchestrator/** must stay standalone-extractable: no electron. Inject the fact you need from main/src/index.ts instead (see docs/ARCHITECTURE.md).',
          allowTypeImports: true
        }],
        patterns: [{
          group: ['**/services/*', '**/services/**'],
          message:
            'orchestrator/** must not import a concrete service: depend on an interface (DatabaseLike-style) or take the value from the boot wiring in main/src/index.ts.',
          allowTypeImports: true
        }]
      }]
    }
  },
  {
    // Frozen exemptions to the rule above. This list may SHRINK, never grow —
    // the ratchet test carries the same set with a reason for each entry and
    // fails if one goes stale. Keep the two lists in sync.
    files: [
      'src/orchestrator/trpc/ipcAdapter.ts',
      'src/orchestrator/mcpServer/scriptPath.ts',
      'src/orchestrator/verify/codexVerificationAgentQuery.ts'
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off'
    }
  },
  {
    // fs / child_process ratchet: execution paths must reach the machine through
    // ExecutionHost so remote environments work. Files that already import these
    // modules are frozen in eslint/executionFsExemptions.json (may shrink, never
    // grow); src/__tests__/executionFsRatchet.test.ts also catches require().
    files: [
      'src/orchestrator/**/*.ts',
      'src/services/panels/**/*.ts',
      'src/services/worktreeManager.ts',
      'src/services/taskQueue.ts'
    ],
    ignores: [
      '**/*.test.ts',
      '**/*.itest.ts',
      '**/__tests__/**',
      '**/__test_fixtures__/**',
      ...executionFsExemptions
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'child_process', 'node:child_process'].map(name => ({
          name,
          message:
            'Execution paths must not touch the local machine directly: go through ExecutionHost (MachineFs / GitExecutor / exec) so remote environments work. See the fs ratchet (main/src/__tests__/executionFsRatchet.test.ts).'
        }))
      }]
    }
  },
  {
    ignores: ['dist/', 'node_modules/', '*.config.js']
  }
];