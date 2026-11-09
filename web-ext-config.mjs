// Keeps dev-only files out of `web-ext build` / `web-ext sign` packages.
// node_modules and dotfiles are ignored by web-ext by default.
export default {
  ignoreFiles: [
    "test",
    "package.json",
    "package-lock.json",
    "vitest.config.js",
    "*.md",
  ],
};
