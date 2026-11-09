import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

export const SHOTS = "test-results/screenshots";

export async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-${name}.png` });
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 820;

/** Open the parts library popover (the white "+" on the tool rail). */
export async function openLibrary(page: Page): Promise<void> {
  if (await page.getByTestId("parts-library").isVisible()) return;
  await page.getByTestId("rail-add").click();
  await expect(page.getByTestId("parts-library")).toBeVisible();
}

export async function closeLibrary(page: Page): Promise<void> {
  if (await page.getByTestId("parts-library").isVisible()) await page.getByTestId("rail-add").click();
  await expect(page.getByTestId("parts-library")).toHaveCount(0);
}

/** Open the serial console panel (top-right icon on desktop, the bottom rail on phones). */
export async function openSerial(page: Page): Promise<void> {
  if (await page.getByTestId("serial-console").count()) return;
  await page.getByTestId(isPhone(page) ? "rail-serial" : "toggle-serial").click();
  await expect(page.getByTestId("serial-console")).toBeAttached();
}

/** Open the inspector panel (opens by itself on desktop when something is selected). */
export async function openInspector(page: Page): Promise<void> {
  if (await page.getByTestId("inspector").count()) return;
  await page.getByTestId(isPhone(page) ? "rail-inspect" : "rail-more").click();
  if (!isPhone(page)) await page.getByRole("menuitem", { name: /Inspector/ }).click();
}

/** Fail with a readable reason when a package this test depends on is not built yet. */
export async function requireParts(page: Page, types: string[]): Promise<void> {
  await openLibrary(page);
  const missing = await page.evaluate(
    (types) => types.filter((t) => !document.querySelector(`[data-testid="library-${t}"]`)),
    types,
  );
  expect(
    missing,
    `parts registry is missing ${missing.join(", ")}: add them under packages/parts/src/parts and run \`pnpm gen\``,
  ).toEqual([]);
  await closeLibrary(page);
}

export async function openCanvas(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.locator(".react-flow__renderer")).toBeVisible();
}

// ---- Virtual time ------------------------------------------------------------------------------
// The simulator runs on virtual time (MCU cycles) and holds ~1x real time on a fast laptop, but a
// 2-vCPU CI runner can fall well below that. Assertions about firmware behaviour therefore wait on
// VIRTUAL time ("within 3 s of sim time the LED turns off"), with a generous wall-clock cap that
// only guards against a sim that has stopped advancing.

/** Wall-clock cap for virtual-time waits: generous on CI, where the sim may run far below 1x. */
export const SIM_WALL_CAP_MS = process.env.CI ? 120_000 : 45_000;

/** Current virtual time in ms, from the sim-time pill's clock (`data-time-ms`). */
export async function simTimeMs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = document.querySelector('[data-testid="sim-clock"]')?.getAttribute("data-time-ms");
    if (v != null) return Number(v);
    // The readout is not mounted (e.g. under a full-screen overlay): read the engine directly.
    const j = (window as unknown as { jumper?: { engine: { simulation?: { timeMs: number } } } }).jumper;
    return j?.engine.simulation?.timeMs ?? 0;
  });
}

function stalled(start: number, now: number, wallMs: number, what: string): Error {
  return new Error(
    `${what}: the simulation only advanced ${Math.round(now - start)} virtual ms in ${Math.round(wallMs / 1000)} s of wall time. ` +
      `It is running far below real time on this machine (or stopped); check data-run on the sim-time pill and for a sim-error.`,
  );
}

/** Wait until `ms` more milliseconds of virtual time have passed (the sim must be running). */
export async function waitForSimTime(page: Page, ms: number, wallCapMs = SIM_WALL_CAP_MS): Promise<number> {
  const start = await simTimeMs(page);
  const t0 = Date.now();
  for (;;) {
    const now = await simTimeMs(page);
    if (now - start >= ms) return now;
    if (Date.now() - t0 > wallCapMs) throw stalled(start, now, Date.now() - t0, `waiting for ${ms} virtual ms`);
    await page.waitForTimeout(50);
  }
}

/**
 * Assert that `check` becomes true within `ms` of VIRTUAL time from now. Polls `check`; fails with
 * `message` when the sim clock passes the budget first, or with a stall error at the wall-clock cap.
 * The clock is read before each check, so a check that is still false at a time past the budget fails.
 */
export async function expectWithinSimTime(
  page: Page,
  ms: number,
  check: () => Promise<boolean> | boolean,
  message: string,
  wallCapMs = SIM_WALL_CAP_MS,
): Promise<void> {
  const start = await simTimeMs(page);
  const t0 = Date.now();
  for (;;) {
    const now = await simTimeMs(page);
    if (await check()) return;
    if (now - start > ms) throw new Error(`${message} (not true after ${Math.round(now - start)} virtual ms; budget ${ms} ms)`);
    if (Date.now() - t0 > wallCapMs) throw stalled(start, now, Date.now() - t0, message);
    await page.waitForTimeout(50);
  }
}

/** Shorthand: within `ms` virtual ms, the locator's attribute matches. */
export async function expectAttrWithinSimTime(page: Page, locator: Locator, name: string, value: string | RegExp, ms: number): Promise<void> {
  await expectWithinSimTime(
    page,
    ms,
    async () => {
      const v = await locator.getAttribute(name);
      return v !== null && (typeof value === "string" ? v === value : value.test(v));
    },
    `${name} should become ${String(value)} within ${ms} virtual ms`,
  );
}

// ---- Hardware WebGL ----------------------------------------------------------------------------
// The 3D Device view renders with three.js. With software WebGL (SwiftShader / llvmpipe) on a 2-vCPU
// CI runner it starves the main-thread sim loop and page.screenshot can take minutes, so the tests
// that measure the 3D scene only run where WebGL is fast:
//   JUMPER_E2E_GPU=1  always run them;  JUMPER_E2E_GPU=0  always skip them;
//   otherwise on CI they run only when the renderer is a hardware GPU; locally they always run
//   (software WebGL on a fast desktop is enough).

/** The unmasked WebGL renderer string ("none" without WebGL). */
export async function webglRenderer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const g = document.createElement("canvas").getContext("webgl");
    if (!g) return "none";
    const ext = g.getExtension("WEBGL_debug_renderer_info");
    return String(ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER));
  });
}

const SOFTWARE_GL = /SwiftShader|llvmpipe|softpipe|Software|^none$/i;

/** Skip the current test (with the reason in the report) when fast WebGL is not available. */
export async function requireFastWebGL(page: Page): Promise<void> {
  const flag = process.env.JUMPER_E2E_GPU;
  if (flag === "1") return;
  if (flag === "0") {
    test.skip(true, "@gpu: needs fast WebGL; skipped because JUMPER_E2E_GPU=0");
    return;
  }
  if (!process.env.CI) return;
  const renderer = await webglRenderer(page);
  test.skip(
    SOFTWARE_GL.test(renderer),
    `@gpu: needs hardware WebGL, but this CI runner renders with "${renderer}" (software), which starves the sim loop and stalls screenshots. ` +
      `Covered by the Device view smoke test here; run with JUMPER_E2E_GPU=1 on a GPU machine.`,
  );
}
