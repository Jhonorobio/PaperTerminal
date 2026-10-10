// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // "app" is a nested copy of another project kept for reference — Expo's lint target
    // includes it (Router convention), so only its generated build output is off-limits.
    ignores: ["dist/*", "app/dist/**"],
  }
]);
