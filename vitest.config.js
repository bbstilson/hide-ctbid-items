import { defineConfig } from "vitest/config";

// Each test builds its own happy-dom Window (see test/helpers.js), so the
// default node environment is used and tests never share page state.
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    restoreMocks: true,
  },
});
