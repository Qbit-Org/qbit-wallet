// Rules and globals that the workspace lint entry point (.eslintrc.js) and the
// deterministic repository lint entry point (.eslintrc.repo.cjs) must enforce
// identically. Each entry point keeps its own parser, environment, and
// additional rules; only this shared subset is composed so the two cannot drift.
const unusedVariableOptions = { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }

module.exports = {
  globals: {
    chrome: 'readonly',
  },
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', unusedVariableOptions],
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-script-url': 'error',
    'no-useless-catch': 'warn',
    'react-hooks/exhaustive-deps': 'warn',
    'react-hooks/rules-of-hooks': 'error',
  },
  typescriptOverrideRules: {
    'no-undef': 'off',
    'no-unused-vars': 'off',
  },
}
