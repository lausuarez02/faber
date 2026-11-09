import { expect, type Page, type TestInfo } from "@playwright/test";

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
