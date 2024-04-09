// eslint does not properly load plugins loaded by presets
// this fixes that
require('@rushstack/eslint-patch/modern-module-resolution');

module.exports = {
  root: true,
  extends: [
    '@ephys/eslint-config-typescript',
    '@ephys/eslint-config-typescript/node',
    '@ephys/eslint-config-typescript/commonjs',
  ],
  ignorePatterns: ['/lib'],
};
