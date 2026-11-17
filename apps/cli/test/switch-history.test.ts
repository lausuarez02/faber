import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@faber/runner";
import { lineDiff } from "@faber/session";
import { startFaberServer, type FaberServer } from "../src/serve.ts";

// Round 6, switch track (decision 0004): an opened example's first version is the untouched copy,
// History counts file changes after a restore with +N / -M lines, and "built" only where it built.
const REPO_EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const GOLDEN = readFileSync(join(REPO_EXAMPLES, "blink/firmware/blink.hex"), "utf8");
const builder = async (_req: BuildRequest): Promise<BuildResult> => ({ ok: true, hex: GOLDEN, cached: false, durationMs: 1, hash: "y", diagnostics: [], errors: 0, warnings: 0, libraries: [], logTail: "" });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("history after opening an example (round 6, switch)", () => {
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
    tmp = mkdtempSync(join(tmpdir(), "faber-switch-"));
    process.env.FABER_HOME = join(tmp, "home");
    const examples = join(tmp, "examples");
    cpSync(join(REPO_EXAMPLES, "blink"), join(examples, "blink"), { recursive: true });
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

  it("version 1 is the example as it came; restoring it brings the sketch back and says what changed", async () => {
    const blink = ((await get("/api/projects")).examples as Json[]).find((e) => e.name === "Blink")!;
    const made = await send("POST", "/api/projects", { from: blink.id, name: "My blink" });
    expect(made.status).toBe(200);
    const sketchPath = "firmware/blink/blink.ino";
    const original = readFileSync(join(made.body.dir, sketchPath), "utf8");

    let versions = (await get("/api/history")).versions as Json[];
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, op: "open_example", actor: "web", why: "opened the example Blink" });
    expect(versions[0]!.firmwareHash).toBeUndefined();
    const v1 = await get("/api/history/1");
    expect(v1.files[sketchPath]).toBe(original);

    // Two edits by the person in the code editor (same "why"), then a build of the second only.
    const edit1 = original.replace("delay(1000)", "delay(250)");
    const edit2 = edit1 + "// two\n// lines\n";
    expect((await send("PUT", "/api/file", { path: sketchPath, content: edit1 })).status).toBe(200);
    expect((await send("PUT", "/api/file", { path: sketchPath, content: edit2 })).status).toBe(200);
    versions = (await get("/api/history")).versions as Json[];
    expect(versions).toHaveLength(3);
    expect(versions[1]!.changes.changed).toEqual([`file:${sketchPath}`]);
    expect(versions[1]!.lines[sketchPath]).toEqual({ added: 1, removed: 1 });
    expect(versions[2]!.lines[sketchPath]).toEqual({ added: 2, removed: 0 });
    // Never built: no "built <hash>" on either edit.
    expect(versions[1]!.firmwareHash).toBeUndefined();
    expect(versions[2]!.firmwareHash).toBeUndefined();

    const b = await send("POST", "/api/build", {});
    expect(b.body.ok).toBe(true);
    versions = (await get("/api/history")).versions as Json[];
    expect(versions[2]!.firmwareHash).toMatch(/^[0-9a-f]{64}$/);
    expect(versions[1]!.firmwareHash).toBeUndefined();

    const r = await send("POST", "/api/history/1/restore", { why: "restore version 1" });
    expect(r.status).toBe(200);
    expect(readFileSync(join(made.body.dir, sketchPath), "utf8")).toBe(original);
    versions = (await get("/api/history")).versions as Json[];
    expect(versions).toHaveLength(4);
    const v4 = versions[3]!;
    expect(v4.op).toBe("restore_version");
    expect(v4.changes.changed).toContain(`file:${sketchPath}`);
    expect(v4.lines[sketchPath]).toEqual({ added: 1, removed: 3 });
    // The restored sketch was not built: the hex of version 3 does not belong to it.
    expect(v4.firmwareHash).toBeUndefined();
    expect((await get("/api/history/4")).files[sketchPath]).toBe(original);
  });

  it("counts lines like a diff", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\n")).toEqual({ added: 1, removed: 1 });
    expect(lineDiff("", "a\nb\n")).toEqual({ added: 2, removed: 0 });
    expect(lineDiff("a\nb\nc", "c\na")).toEqual({ added: 1, removed: 2 });
    expect(lineDiff("same", "same")).toEqual({ added: 0, removed: 0 });
  });
});
