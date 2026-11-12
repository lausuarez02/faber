import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startJumperServer, type JumperServer } from "../src/serve.ts";

// Round 6, track case (decision 0004, R6): the Case view's routes on jumper serve.
const MUSE = readFileSync(new URL("../../../packages/enclosure/test/fixtures/pocket-muse.json", import.meta.url), "utf8");
let root: string;
let srv: JumperServer;
let token: string;
const oldHome = process.env.JUMPER_HOME;

beforeAll(async () => {
  process.env.JUMPER_CASE_PDF = "0";
  root = mkdtempSync(join(tmpdir(), "jumper-case-routes-"));
  process.env.JUMPER_HOME = join(root, "home");
  mkdirSync(join(root, "proj"));
  writeFileSync(join(root, "proj", "jumper.json"), MUSE);
  srv = await startJumperServer({ dir: join(root, "proj"), port: 0, web: "none" });
  token = (await (await fetch(`${srv.url}/api/connect`)).json()).token;
}, 30_000);
afterAll(async () => {
  await srv?.close();
  if (oldHome === undefined) delete process.env.JUMPER_HOME;
  else process.env.JUMPER_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown, t = token) => fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-jumper-token": t }, body: JSON.stringify(body) });

describe("jumper serve: case routes", () => {
  it("before a case: GET says null, mesh says why and how to fix", async () => {
    expect(await (await fetch(`${srv.url}/api/case`)).json()).toEqual({ enclosure: null, stale: false, variants: [] });
    const m = await fetch(`${srv.url}/api/case/mesh`);
    expect(m.status).toBe(404);
    expect((await m.json()).error).toMatch(/No case yet\. Why: .*Fix: /);
    expect(await (await fetch(`${srv.url}/api/device/case`)).json()).toEqual({ case: null });
  });

  it("GET lists the shapes made with save: false (case/variants/<shape>/report.json)", async () => {
    const v = join(root, "proj", "case", "variants", "puck");
    mkdirSync(v, { recursive: true });
    writeFileSync(join(v, "report.json"), JSON.stringify({ shape: "puck", size_mm: { w: 63.1, h: 55.2, d: 32 }, pocket: "tight", ok: true, files: [{ path: "stl/front.stl" }] }));
    const g = await (await fetch(`${srv.url}/api/case`)).json();
    expect(g.variants).toEqual([{ shape: "puck", size_mm: { w: 63.1, h: 55.2, d: 32 }, pocket: "tight", ok: true, files: ["variants/puck/stl/front.stl"] }]);
    rmSync(join(root, "proj", "case"), { recursive: true, force: true });
  });

  it("POST needs the token and a shape", async () => {
    expect((await post("/api/case", { shape: "pebble" }, "nope")).status).toBe(403);
    const r = await post("/api/case", {});
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/a new case needs a shape/);
  });

  it(
    "POST designs, then updates; mesh, files and the factory pack download",
    async () => {
      const r = await post("/api/case", { shape: "rounded-box" });
      expect(r.status).toBe(200);
      const rep = await r.json();
      expect(rep.ok).toBe(true);
      const u = await (await post("/api/case", { params: { color: "#2B3038" } })).json();
      expect(u.enclosure.params.color).toBe("#2B3038");
      const g = await (await fetch(`${srv.url}/api/case`)).json();
      expect(g.enclosure.shape).toBe("rounded-box");
      expect(g.stale).toBe(false);
      expect(g.report.size_mm.w).toBeGreaterThan(30);
      const mesh = await (await fetch(`${srv.url}/api/case/mesh`)).json();
      expect(mesh.hash).toBe(g.report.hash);
      const front = mesh.bodies.find((b: { body: string }) => b.body === "front");
      expect(front.kind).toBe("shell");
      expect(Buffer.from(front.positions, "base64").length % 12).toBe(0);
      expect(mesh.bodies.some((b: { kind: string }) => b.kind === "part")).toBe(true);
      const stl = await fetch(`${srv.url}/api/case/file?path=stl/front.stl`);
      expect(stl.status).toBe(200);
      expect(stl.headers.get("content-disposition")).toMatch(/attachment; filename="front.stl"/);
      expect((await fetch(`${srv.url}/api/case/file?path=../jumper.json`)).status).toBe(400);
      expect((await fetch(`${srv.url}/api/case/file?path=stl/none.stl`)).status).toBe(404);
      const pack = await (await post("/api/manufacturing", {})).json();
      expect(pack.url).toMatch(/^\/api\/manufacturing\/pocket-muse-v\d+\.zip$/);
      const zip = await fetch(`${srv.url}${pack.url}`);
      expect(zip.status).toBe(200);
      expect(zip.headers.get("content-type")).toBe("application/zip");
      expect((await fetch(`${srv.url}/api/manufacturing/..%2Fjumper.zip`)).status).toBe(404);
    },
    240_000,
  );

  it(
    "GET /api/device/case: the built case with its openings; a changed project shows it as built, stale, without rebuilding",
    async () => {
      const g = await (await fetch(`${srv.url}/api/case`)).json();
      const d = (await (await fetch(`${srv.url}/api/device/case`)).json()).case;
      expect(d.hash).toBe(g.report.hash);
      expect(d.stale).toBe(false);
      expect(d.color).toBe("#2B3038");
      expect(d.mesh.bodies.find((b: { body: string }) => b.body === "front").kind).toBe("shell");
      const win = d.openings.find((o: { kind: string }) => o.kind === "window");
      expect(win.part).toBe("eye");
      expect(win.screen.u).toBeGreaterThan(20);
      const btn = d.openings.find((o: { kind: string; part: string }) => o.kind === "button" && o.part === "pet");
      expect(btn.insert.kind).toBe("cap");
      expect(d.mesh.bodies.some((b: { body: string }) => b.body === "cap-pet")).toBe(true);
      // a part changes: the Device view still gets the case as built, marked stale, and case/ is untouched
      const before = readFileSync(join(root, "proj", "case", "manifest.json"), "utf8");
      const p = JSON.parse(readFileSync(join(root, "proj", "jumper.json"), "utf8"));
      p.parts = p.parts.filter((x: { id: string }) => x.id !== "imu");
      p.wires = (p.wires ?? []).filter((w: { from: { part: string }; to: { part: string } }) => w.from.part !== "imu" && w.to.part !== "imu");
      writeFileSync(join(root, "proj", "jumper.json"), JSON.stringify(p, null, 2));
      const s = (await (await fetch(`${srv.url}/api/device/case`)).json()).case;
      expect(s.stale).toBe(true);
      expect(s.stale_reason).toMatch(/changed since/);
      expect(s.hash).toBe(d.hash);
      // the openings stay where the built meshes have them (each moved back by how far its part moved)
      const sw = s.openings.find((o: { kind: string }) => o.kind === "window");
      for (const k of [0, 1, 2]) expect(sw.at[k]).toBeCloseTo(win.at[k], 1);
      const sb = s.openings.find((o: { kind: string; part: string }) => o.kind === "button" && o.part === "pet");
      for (const k of [0, 1, 2]) expect(sb.at[k]).toBeCloseTo(btn.at[k], 1);
      expect(s.openings.some((o: { part: string }) => o.part === "imu")).toBe(false);
      expect(readFileSync(join(root, "proj", "case", "manifest.json"), "utf8")).toBe(before);
    },
    120_000,
  );
});
