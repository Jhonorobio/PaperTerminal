// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // "app" is a nested copy of another project kept for reference — Expo's lint target
    // includes it (Router convention), so only its generated build output is off-limits.
    ignores: ["dist/*", "app/dist/**"],
  },
  {
    // The Chrome extension is a standalone MV3 bundle (plain JS + ES modules, no build
    // step). Its only non-standard global is the `chrome` API; everything else it uses
    // is DOM/web and already covered by the Expo config.
    files: ["extension/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: { chrome: "readonly" },
    },
  },
]);
