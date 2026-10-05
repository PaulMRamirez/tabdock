import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      // Agents' temporary worktrees: other checkouts of this repo, possibly mid-edit.
      '.claude/**',
      // The Pages site keeps its own packages outside the workspace (ADR 0029),
      // so a clean clone cannot type its imports; `pnpm site:build` typechecks
      // and tests it with those packages installed.
      'apps/site/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', '*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // Protocol types must stay precise; a stray any defeats the zod boundary checks.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The /pair page's script runs in the phone's browser, not in Node.
    files: ['packages/relay/src/pair-page/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  prettier,
);
