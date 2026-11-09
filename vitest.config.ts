import { defineConfig } from "vitest/config";

// `pnpm test` at the root runs every workspace's unit tests.
// Each package is a Vitest project; apps/web has its own vitest.config.ts
// (jsdom, React plugin, excludes Playwright e2e specs).
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: ["packages/*", "apps/web", "apps/cli", "services/*"],
  },
});
