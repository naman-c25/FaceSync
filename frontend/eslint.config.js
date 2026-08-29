import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * Lint exists here for one rule in particular.
 *
 * `rules-of-hooks` catches a hook placed after an early return, which is not a
 * style question: React counts hooks per render, so a component that returns
 * before reaching one renders a different number on that branch and throws.
 * The screen goes blank with nothing on it to read.
 *
 * That is not hypothetical — two announcement effects were added below the
 * kiosk's PIN branch, and the kiosk blanked the moment anyone reached the PIN
 * while the till, whose hooks all sat above its returns, carried on working.
 * Nothing in a build catches it, because the code is perfectly valid
 * JavaScript.
 */
export default [
  // Flat config does not read .gitignore, so build output has to be named
  // here or every run drowns in a few hundred errors from one minified
  // bundle -- which is the same as having no linter, because nobody reads
  // output that is always red.
  { ignores: ['dist/**', '../backend/public/**', 'node_modules/**'] },

  js.configs.recommended,

  // Build tooling runs in Node, not a browser.
  {
    files: ['vite.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // JSX makes a component look unused to the base rule.
      'no-unused-vars': ['warn', { varsIgnorePattern: '^[A-Z]' }],
    },
  },
];
