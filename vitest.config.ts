import { defineConfig } from "vitest/config";
import { serviceVitestConfig } from "@rodrigo-barraza/utilities-library/vitest";

// Agent worktrees live under .claude/worktrees — a run from the main
// checkout must not pick up (and double-run) their copies of the tests.
export default defineConfig({
  ...serviceVitestConfig,
  test: {
    ...serviceVitestConfig.test,
    exclude: [...serviceVitestConfig.test.exclude, ".claude/**", "coverage/**"],
  },
});
