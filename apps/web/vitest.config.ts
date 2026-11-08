import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit/component tests for the web app. Playwright specs live in e2e/ and are excluded.
export default defineConfig({
  plugins: [react()],
  test: {
    name: "@jumper/web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
  },
});
