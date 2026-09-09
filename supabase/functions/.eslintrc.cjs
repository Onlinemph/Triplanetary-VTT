/**
 * Lint the Edge Function on its own terms.
 *
 * The root config points `parserOptions.project` at `tsconfig.json`, and that
 * tsconfig covers the browser build: `src`, `server`, `tools`, `tests`. Nothing
 * under `supabase/functions` is in it, and a file the project does not include
 * is a parse error rather than a lint result — so without this file
 * `npm run lint` fails on the function before reading a line of it.
 *
 * Ignoring the directory would silence that. This lints it instead, minus the
 * rules that need a type checker, because these files are Deno's: they import
 * `npm:` specifiers and a generated bundle that no tsconfig in this repository
 * describes. `root: true` stops the cascade so the type-aware settings above do
 * not come back down.
 *
 * The cost is honest and worth stating: `no-floating-promises` and
 * `switch-exhaustiveness-check` do not run here, and neither does `tsc`. Deno
 * type-checks this code, and there is no Deno in this environment.
 */

/* eslint-env node */
module.exports = {
  root: true,
  env: { es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  globals: {
    Deno: 'readonly',
    Request: 'readonly',
    Response: 'readonly',
    crypto: 'readonly',
    console: 'readonly',
  },
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
    ],
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    '@typescript-eslint/no-explicit-any': 'error',
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'prefer-const': 'error',
    'no-var': 'error',
  },
};
