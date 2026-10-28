const shared = require('./.eslintrc.shared.cjs')

module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2020: true,
  },
  extends: ['eslint:recommended', 'prettier'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint', 'prettier', 'react-hooks'],
  rules: {
    ...shared.rules,
    'prettier/prettier': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'warn',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@typescript-eslint/prefer-nullish-coalescing': 'warn',
    '@typescript-eslint/prefer-optional-chain': 'warn',
    'no-control-regex': 'warn',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      rules: {
        ...shared.typescriptOverrideRules,
        'no-dupe-class-members': 'off',
        'no-redeclare': 'off',
        '@typescript-eslint/no-dupe-class-members': 'error',
        '@typescript-eslint/no-redeclare': 'error',
      },
    },
    {
      files: ['**/*.test.ts', '**/*.spec.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  ],
  globals: shared.globals,
}
