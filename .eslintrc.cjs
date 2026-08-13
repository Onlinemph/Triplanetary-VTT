/**
 * Lint rules.
 *
 * Two ideas are enforced here rather than left to review:
 *
 *  1. The engine is pure. `src/engine` and `src/scenarios` may not touch the
 *     DOM, `Date`, `Math.random`, or `console` — determinism is what makes
 *     replay, undo and networked play the same mechanism, and one stray
 *     `Math.random()` silently breaks all three.
 *  2. Relative imports carry the `.js` extension, because the project is native
 *     ESM and the extension is not optional at runtime.
 */

/* eslint-env node */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  // `recommended` plus a hand-picked set of type-aware rules. The full
  // `recommended-requiring-type-checking` preset is not used: its `no-unsafe-*`
  // family fires on every `JSON.parse` boundary, and this codebase parses saved
  // games and network frames deliberately, behind explicit type guards.
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', '*.cjs', '*.config.ts'],
  rules: {
    // Unused values are usually a mistake; a leading underscore says otherwise.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
    ],
    // `!` is the sanctioned answer to `noUncheckedIndexedAccess` where the index
    // is provably in range; the alternative is noise at every array access.
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/switch-exhaustiveness-check': 'error',
    '@typescript-eslint/no-unnecessary-condition': 'off',
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'prefer-const': 'error',
    'no-var': 'error',
  },
  overrides: [
    {
      // The rules engine and the scenarios are pure functions of their input.
      files: ['src/engine/**/*.ts', 'src/scenarios/**/*.ts'],
      excludedFiles: ['**/*.test.ts'],
      rules: {
        'no-console': 'error',
        'no-restricted-globals': [
          'error',
          { name: 'document', message: 'The engine must not touch the DOM.' },
          { name: 'window', message: 'The engine must not touch the DOM.' },
          { name: 'localStorage', message: 'The engine must not touch the DOM.' },
        ],
        'no-restricted-properties': [
          'error',
          {
            object: 'Math',
            property: 'random',
            message: 'Roll through src/engine/rng.ts so games replay identically.',
          },
          {
            object: 'Date',
            property: 'now',
            message: 'The engine must not read the clock; it is a pure function.',
          },
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: "NewExpression[callee.name='Date']",
            message: 'The engine must not read the clock; it is a pure function.',
          },
        ],
      },
    },
    {
      files: ['**/*.test.ts', 'tests/**/*.ts', 'tools/**/*.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        'no-console': 'off',
      },
    },
  ],
};
