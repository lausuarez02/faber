import { defineConfig, devices } from "@playwright/test";

// `pnpm test:e2e` starts the Vite dev server and runs e2e/*.spec.ts on a desktop
// and a phone viewport (the brief requires both). Screenshots land in test-results/.
//
// Ports (decision 0003, C9): E2E_PORT is the Vite port (default 5173) and E2E_HUB_PORT_BASE the
// first port specs give to the `faber serve` processes they start (default 7900, see
// e2e/helpers.ts hubPort). Parallel worktrees each pick their own pair, e.g. E2E_PORT=5174
// E2E_HUB_PORT_BASE=8000. Never 7780: a person may be using it.
const PORT = Number(process.env.E2E_PORT ?? 5173);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT === 7780) throw new Error(`E2E_PORT=${process.env.E2E_PORT} is not a usable port (7780 is reserved for a person's faber serve). Fix: pick another, e.g. 5174.`);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: process.env.E2E_OUTPUT_DIR ?? "./test-results/artifacts",
  fullyParallel: true,
  // The blink test needs the sim at ~1x real time; too many browsers at once starve it.
  workers: 3,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  // Sim behaviour is asserted on virtual time (e2e/helpers.ts waitForSimTime); a 2-vCPU CI runner
  // may simulate well below 1x, so it gets more wall time per test.
  timeout: process.env.CI ? 240_000 : 45_000,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    colorScheme: "dark", // dark-first brand; the theme test switches to light itself
    // Chromium refuses some ports outright (6000 is X11's): let the chosen Vite port through
    launchOptions: { args: [`--explicitly-allowed-ports=${PORT}`] },
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      testIgnore: /perf\.spec\.ts|case-costs\.spec\.ts/,
    },
    {
      // Round 8b: two real CAD builds of a domed egg plus the costs, several minutes of full CPU:
      // run after the other specs, alone, so it does not starve the timing-sensitive ones.
      name: "case-costs",
      testMatch: /case-costs\.spec\.ts/,
      dependencies: ["desktop", "mobile"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      // The 200-part frame-rate benchmark. It runs in full Chromium ("new headless") with the
      // GPU on where the machine has one, like a person's browser. The default headless shell
      // composites in software, which measures the CPU rasterizer rather than the app.
      name: "perf",
      testMatch: /perf\.spec\.ts/,
      // Measured last and alone, so the other browsers do not steal its frames.
      dependencies: ["desktop", "mobile", "case-costs"],
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
      testIgnore: /perf\.spec\.ts|case-costs\.spec\.ts/,
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
