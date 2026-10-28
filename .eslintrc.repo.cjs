const shared = require('./.eslintrc.shared.cjs')

module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  ignorePatterns: ['**/dist/**', '**/lib/**'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  globals: shared.globals,
  rules: {
    ...shared.rules,
    '@typescript-eslint/ban-ts-comment': 'warn',
    '@typescript-eslint/no-var-requires': 'warn',
    'no-constant-condition': 'warn',
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-empty-pattern': 'warn',
    'no-regex-spaces': 'warn',
    'no-unsafe-finally': 'warn',
    'prefer-const': 'warn',
  },
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      rules: {
        ...shared.typescriptOverrideRules,
        '@typescript-eslint/no-explicit-any': 'warn',
        '@typescript-eslint/no-unused-vars': shared.rules['@typescript-eslint/no-unused-vars'],
      },
    },
    {
      files: ['**/*.cjs', '**/*.js'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
    {
      files: ['**/*.test.*', '**/*.spec.*'],
      rules: {
        '@typescript-eslint/no-empty-function': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
    {
      files: [
        'apps/extension/scripts/http-client-headers.test.js',
        'apps/extension/scripts/runtime-network-audit.test.js',
      ],
      rules: {
        // These tests deliberately evaluate transformed, repository-owned modules in isolation.
        'no-new-func': 'off',
      },
    },
    {
      files: ['packages/wallet-shared/test/explorer.test.ts'],
      rules: {
        // This negative test must pass a javascript: URL to the production sanitizer.
        'no-script-url': 'off',
      },
    },
  ],
}
