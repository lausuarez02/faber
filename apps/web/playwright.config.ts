import { defineConfig, devices } from "@playwright/test";

// `pnpm test:e2e` starts the Vite dev server and runs e2e/*.spec.ts on a desktop
// and a phone viewport (the brief requires both). Screenshots land in test-results/.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/artifacts",
  fullyParallel: true,
  // The blink test needs the sim at ~1x real time; too many browsers at once starve it.
  workers: 3,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 45_000,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    colorScheme: "dark", // dark-first brand; the theme test switches to light itself
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      testIgnore: /perf\.spec\.ts/,
    },
    {
      // The 200-part frame-rate benchmark. It runs in full Chromium ("new headless") with the
      // GPU on where the machine has one, like a person's browser. The default headless shell
      // composites in software, which measures the CPU rasterizer rather than the app.
      name: "perf",
      testMatch: /perf\.spec\.ts/,
      // Measured last and alone, so the other browsers do not steal its frames.
      dependencies: ["desktop", "mobile"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        channel: "chromium",
        launchOptions: {
          args: ["--enable-gpu", "--ignore-gpu-blocklist", ...(process.platform === "darwin" ? ["--use-angle=metal"] : [])],
        },
      },
    },
    {
      // iPhone 13 metrics, driven by Chromium (the only browser installed for CI).
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium", defaultBrowserType: "chromium" },
      // The 200-part frame-rate benchmark is measured once, in the "perf" project.
      testIgnore: /perf\.spec\.ts/,
    },
  ],
  webServer: {
    command: "pnpm exec vite --port 5173 --strictPort",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
