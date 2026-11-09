import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { projectId, serverBase } from "@jumper/session";
import { startJumperServer, type JumperServer } from "../src/serve.ts";

// Round 5, track agent (decision 0003, C3): the viewer link, recordings and the pet gateway on jumper serve.
let root: string;
let srv: JumperServer;
const oldHome = process.env.JUMPER_HOME;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jumper-agent-routes-"));
  process.env.JUMPER_HOME = join(root, "home");
  mkdirSync(join(root, "proj"));
  srv = await startJumperServer({ dir: join(root, "proj"), port: 0, web: "none" });
}, 30_000);
afterAll(async () => {
  await srv?.close();
  if (oldHome === undefined) delete process.env.JUMPER_HOME;
  else process.env.JUMPER_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

describe("jumper serve: agent routes", () => {
  it("GET /v/:id sends the person to the live, running project; other ids say why", async () => {
    const id = projectId(srv.dir);
    const r = await fetch(`${srv.url}/v/${id}`, { redirect: "manual" });
    expect(r.status).toBe(302);
    const loc = r.headers.get("location")!;
    expect(loc).toMatch(new RegExp(`^/\\?follow=ws%3A%2F%2Flocalhost%3A${srv.port}%2Flive&project=${id}&autorun=1$`));
    const other = await fetch(`${srv.url}/v/abcdefabcdef`, { redirect: "manual" });
    expect(other.status).toBe(404);
    expect(await other.text()).toMatch(/No such project here.*Fix:/s);
  });

  it("GET /api/media/:file serves recordings from .jumper/media only, with ranges", async () => {
    mkdirSync(join(srv.dir, ".jumper", "media"), { recursive: true });
    writeFileSync(join(srv.dir, ".jumper", "media", "build-1.mp4"), Buffer.from("0123456789"));
    const ok = await fetch(`${srv.url}/api/media/build-1.mp4`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("video/mp4");
    expect(await ok.text()).toBe("0123456789");
    const part = await fetch(`${srv.url}/api/media/build-1.mp4`, { headers: { range: "bytes=2-4" } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("234");
    expect((await fetch(`${srv.url}/api/media/..%2Fjumper.json`)).status).toBe(400);
    const missing = await fetch(`${srv.url}/api/media/nope.mp4`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatch(/Why:.*Fix:/);
  });

  it("starts the pet AI gateway (port 0 under tests) and says where; m= passes through", async () => {
    const g = await (await fetch(`${srv.url}/api/ai-gateway`)).json();
    expect(g.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(g.provider).toBe("Mock");
    const pet = await fetch(`${g.url}/v1/pet?a=talk&f=50&j=50&e=50&m=${encodeURIComponent("hello there")}`);
    expect(await pet.text()).toMatch(/"hello there"/);
  });

  it("viewer_url and new_project {folder} over MCP give the server's link", async () => {
    expect(serverBase()).toBe(srv.url);
    const client = new Client({ name: "agent-routes-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.mcpUrl)));
    try {
      const r = (await client.callTool({ name: "viewer_url", arguments: {} })) as { content: { text: string }[] };
      expect(JSON.parse(r.content[0]!.text).url).toBe(`${srv.url}/v/${projectId(srv.dir)}`);
      expect(client.getInstructions()).toMatch(/plan_device/);
      expect(client.getInstructions()).toMatch(/ONE clarifying question/);
    } finally {
      await client.close();
    }
  });
});
