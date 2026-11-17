import { cpSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFaberServer, type FaberServer } from "../src/serve.ts";

// Round 12, track kit: the Build it panel's routes, on the pocket Muse (a full project with a case).
const MUSE = fileURLToPath(new URL("../../../examples/agent-built/claude-pocket-muse", import.meta.url));
let root: string;
let srv: FaberServer;
let token: string;
const oldHome = process.env.FABER_HOME;

beforeAll(async () => {
  process.env.FABER_CASE_PDF = "0";
  root = mkdtempSync(join(tmpdir(), "faber-kit-routes-"));
  process.env.FABER_HOME = join(root, "home");
  cpSync(MUSE, join(root, "proj"), { recursive: true });
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, "proj", "firmware", "main.hex"), later, later);
  srv = await startFaberServer({ dir: join(root, "proj"), port: 0, web: "none" });
  token = (await (await fetch(`${srv.url}/api/connect`)).json()).token;
}, 30_000);
afterAll(async () => {
  await srv?.close();
  delete process.env.FABER_CASE_PDF;
  if (oldHome === undefined) delete process.env.FABER_HOME;
  else process.env.FABER_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

describe("faber serve: kit routes", () => {
  it("GET /api/kit gives the kit; POST writes the files; GET /api/kit/file serves them", async () => {
    const k = await (await fetch(`${srv.url}/api/kit?region=uk`)).json();
    expect(k.project).toBe("Pocket Muse");
    expect(k.region).toBe("uk");
    expect(k.print.items).toHaveLength(3);
    expect(k.steps.length).toBeGreaterThan(5);
    expect((await fetch(`${srv.url}/api/kit/files`, { method: "POST", body: "{}" })).status).toBe(403);
    const r = await fetch(`${srv.url}/api/kit/files`, { method: "POST", headers: { "content-type": "application/json", "x-faber-token": token }, body: JSON.stringify({ region: "uk" }) });
    expect(r.status).toBe(200);
    const f = await r.json();
    expect(f.zip_url).toMatch(/^\/api\/kit\/file\?path=pocket-muse-kit\.zip$/);
    const html = await fetch(`${srv.url}${f.html_url}`);
    expect(html.headers.get("content-type")).toMatch(/text\/html/);
    expect(await html.text()).toContain("Build it yourself: Pocket Muse");
    const zip = await fetch(`${srv.url}${f.zip_url}`);
    expect(zip.headers.get("content-disposition")).toMatch(/attachment; filename="pocket-muse-kit.zip"/);
    expect((await fetch(`${srv.url}/api/kit/file?path=../faber.json`)).status).toBe(400);
    expect((await fetch(`${srv.url}/api/kit/file?path=none.zip`)).status).toBe(404);
  }, 120_000);
});
