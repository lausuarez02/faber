// Screenshots of the v2 shell at 1440x900 and 390x844 (design review). Usage:
//   node apps/web/scripts/ui-shots.mjs [baseUrl] [outDir] [only]
import { chromium, devices } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:5173";
const out = process.argv[3] ?? "test-results/ui-v2";
const only = process.argv[4];

const scenes = [
  { name: "blink", url: "/", act: async () => {} },
  { name: "blink-running", url: "/", act: async (p) => { await p.getByTestId("run-button").click(); await p.waitForTimeout(1600); } },
  { name: "tamagotchi", url: "/?example=tamagotchi", act: async (p) => { await p.getByTestId("run-button").click(); await p.waitForTimeout(2500); } },
  { name: "rover", url: "/?example=rover", act: async (p) => { await p.getByTestId("run-button").click(); await p.waitForTimeout(3000); } },
  { name: "parts", url: "/", act: async (p) => { await p.getByTestId("rail-add").click(); await p.waitForTimeout(300); } },
  { name: "select-led", url: "/", act: async (p, m) => { const b = await p.getByTestId("part-led1").boundingBox(); await p.mouse.click(b.x + b.width / 2, b.y + 6); if (m) await p.getByTestId("rail-inspect").click(); await p.waitForTimeout(300); } },
  { name: "serial-tests", url: "/?example=tamagotchi", act: async (p, m) => { if (m) { await p.getByTestId("phone-menu").click(); await p.getByTestId("phone-serial").click(); } else { await p.getByTestId("toggle-serial").click(); await p.getByTestId("toggle-tests").click(); } await p.getByTestId("run-button").click(); await p.waitForTimeout(1500); } },
  { name: "mcp", url: "/", act: async (p, m) => { if (m) { await p.getByTestId("phone-menu").click(); await p.waitForTimeout(200); } else await p.getByTestId("install-mcp").click(); await p.waitForTimeout(300); } },
  { name: "more", url: "/", act: async (p) => { await p.getByTestId("rail-more").click(); await p.waitForTimeout(300); } },
  { name: "light", url: "/", act: async (p) => { await p.evaluate(() => window.jumper.store.getState().setTheme("light")); await p.waitForTimeout(300); } },
  { name: "device", url: "/?example=tamagotchi", act: async (p, m) => { if (m) { await p.getByTestId("phone-menu").click(); await p.getByRole("menuitem", { name: "Device view" }).click(); } else await p.getByTestId("toggle-device").click(); await p.waitForTimeout(3500); } },
  { name: "replay", url: "/?replay=" + encodeURIComponent("/@fs" + new URL("../e2e/fixtures/blink-session.jsonl", import.meta.url).pathname) + "&speed=8", act: async (p) => { await p.getByTestId("replay-index").filter({ hasText: "done" }).waitFor({ timeout: 30000 }); } },
  { name: "instruments", url: "/", act: async (p, m) => { if (m) return; await p.getByTestId("rail-instruments").click(); await p.getByTestId("run-button").click(); await p.waitForTimeout(1500); } },
];

const browser = await chromium.launch();
for (const [label, ctxOpts] of [["desktop", { viewport: { width: 1440, height: 900 }, colorScheme: "dark" }], ["mobile", { ...devices["iPhone 13"], colorScheme: "dark" }]]) {
  for (const s of scenes) {
    if (only && !s.name.includes(only)) continue;
    const ctx = await browser.newContext(ctxOpts);
    await ctx.addInitScript(() => localStorage.setItem("jumper.theme", "dark"));
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(base + s.url);
    await p.getByTestId("app").waitFor();
    await p.waitForTimeout(700);
    try {
      await s.act(p, label === "mobile");
    } catch (e) {
      errors.push(`act: ${e.message.split("\n")[0]}`);
    }
    await p.screenshot({ path: `${out}/${label}-${s.name}.png` });
    if (errors.length) console.log(label, s.name, errors);
    await ctx.close();
  }
}
await browser.close();
console.log("done");
