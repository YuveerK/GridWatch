const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'android/*', 'ios/*', '.expo/*'],
  },
  {
    files: ['metro.config.cjs'],
    languageOptions: {
      globals: { __dirname: 'readonly' },
    },
  },
  {
    rules: {
      // Screens load data in effects. The rule flags that fetch pattern, including request guards.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]);
