import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@faber/runner";
import { startFaberServer, type FaberServer } from "../src/serve.ts";
import { freeName } from "../src/routes/projects.ts";

// Round 6b (ui): opening an example twice reopens the person's copy (a new copy only when asked, as
// "Name (2)"), and a freshly opened copy is not "sketch changed, not built yet".
const REPO_EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const GOLDEN = readFileSync(join(REPO_EXAMPLES, "blink/firmware/blink.hex"), "utf8");
const builder = async (_req: BuildRequest): Promise<BuildResult> => ({ ok: true, hex: GOLDEN, cached: false, durationMs: 1, hash: "y", diagnostics: [], errors: 0, warnings: 0, libraries: [], logTail: "" });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("example copies (round 6b)", () => {
  let tmp: string;
  let srv: FaberServer;
  let token: string;
  const oldHome = process.env.FABER_HOME;
  const get = async (path: string): Promise<Json> => (await (await fetch(`${srv.url}${path}`)).json()) as Json;
  const send = async (method: string, path: string, body: unknown = {}): Promise<{ status: number; body: Json }> => {
    const r = await fetch(`${srv.url}${path}`, { method, headers: { "content-type": "application/json", "x-faber-token": token }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Json };
  };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "faber-copies-"));
    process.env.FABER_HOME = join(tmp, "home");
    const examples = join(tmp, "examples");
    cpSync(join(REPO_EXAMPLES, "ai-pet"), join(examples, "ai-pet"), { recursive: true });
    // A checkout where the sketch is newer than the hex and has CRLF line endings.
    const ino = join(examples, "ai-pet", "firmware", "ai-pet", "ai-pet.ino");
    writeFileSync(ino, readFileSync(ino, "utf8").replace(/\r?\n/g, "\r\n"));
    const later = new Date(Date.now() + 60_000);
    utimesSync(ino, later, later);
    mkdirSync(join(examples, "agent-built"), { recursive: true });
    srv = await startFaberServer({ dir: join(tmp, "projects/playground"), port: 0, web: "none", builder, examplesRoot: examples, launcher: async () => {} });
    token = ((await (await fetch(`${srv.url}/api/connect`)).json()) as { token: string }).token;
  }, 30_000);

  afterAll(async () => {
    await srv?.close();
    if (oldHome === undefined) delete process.env.FABER_HOME;
    else process.env.FABER_HOME = oldHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a fresh copy's shipped hex counts as built from its sketch; an edit makes it stale; CRLF alone does not", async () => {
    const pet = ((await get("/api/projects")).examples as Json[]).find((e) => e.name === "AI pet")!;
    expect(pet).toBeTruthy();
    const made = await send("POST", "/api/projects", { from: pet.id, name: pet.name });
    expect(made.status).toBe(200);
    expect((await get("/api/firmware")).stale).toBe(false);
    expect(srv.session.firmwareState()).toBe("fresh");
    const ino = join(made.body.dir, "firmware", "ai-pet", "ai-pet.ino");
    // Line endings only: the same sketch.
    writeFileSync(ino, readFileSync(ino, "utf8").replace(/\r\n/g, "\n"));
    expect((await get("/api/firmware")).stale).toBe(false);
    // A real change: stale until built.
    writeFileSync(ino, readFileSync(ino, "utf8") + "\n// changed\n");
    expect((await get("/api/firmware")).stale).toBe(true);
  });

  it("opening the example again reopens that copy; a new copy only when asked, named (2)", async () => {
    const list0 = await get("/api/projects");
    const pet = (list0.examples as Json[]).find((e) => e.name === "AI pet")!;
    const firstCopy = (list0.projects as Json[]).find((p) => p.copyOf === pet.id)!;
    expect(firstCopy).toBeTruthy();
    expect(pet.copy).toBe(firstCopy.id);
    // Away to another project, then open the example again.
    expect((await send("POST", "/api/projects", { name: "Something else" })).status).toBe(200);
    expect(srv.session.project.name).toBe("Something else");
    const again = await send("POST", "/api/projects", { from: pet.id, name: pet.name });
    expect(again.body).toMatchObject({ id: firstCopy.id, reopened: true });
    expect(srv.dir).toBe(firstCopy.dir);
    let names = ((await get("/api/projects")).projects as Json[]).map((p) => p.name);
    expect(names.filter((n) => n === "AI pet")).toHaveLength(1);
    // Asked for a new copy.
    const second = await send("POST", "/api/projects", { from: pet.id, name: pet.name, copy: true });
    expect(second.status).toBe(200);
    expect(second.body.reopened).toBeUndefined();
    names = ((await get("/api/projects")).projects as Json[]).map((p) => p.name);
    expect(names).toContain("AI pet (2)");
    expect(names.filter((n) => n === "AI pet")).toHaveLength(1);
  });

  it("freeName numbers only on a clash", () => {
    expect(freeName("Pocket Muse", ["Blink"])).toBe("Pocket Muse");
    expect(freeName("Pocket Muse", ["Pocket Muse", "Pocket Muse (2)"])).toBe("Pocket Muse (3)");
    expect(freeName("Pocket Muse (2)", ["Pocket Muse (2)"])).toBe("Pocket Muse (3)");
  });
});
