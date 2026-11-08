import { expect, type Page, type TestInfo } from "@playwright/test";

export const SHOTS = "test-results/screenshots";

export async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-${name}.png` });
}

/** Fail with a readable reason when a package this test depends on is not built yet. */
export async function requireParts(page: Page, types: string[]): Promise<void> {
  const missing = await page.evaluate(
    (types) => types.filter((t) => !document.querySelector(`[data-testid="library-${t}"]`)),
    types,
  );
  expect(
    missing,
    `parts registry is missing ${missing.join(", ")}: add them under packages/parts/src/parts and run \`pnpm gen\``,
  ).toEqual([]);
}

export async function openCanvas(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.locator(".react-flow__renderer")).toBeVisible();
}
