module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  plugins: [
    '@typescript-eslint'
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': 'warn',
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-script-url': 'error',
    'no-var': 'error',
    'no-console': 'warn'
  },
  ignorePatterns: [
    'lib/**/*',
    'dist/**/*',
    'coverage/**/*',
    '*.js',
    '*.mjs'
  ]
};
