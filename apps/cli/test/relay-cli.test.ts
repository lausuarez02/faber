// Round 13: `faber relay init | token | device-header | serve` on a real project folder.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../bin/faber.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "faber-relay-cli-"));
const faber = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, INIT_CWD: dir, FABER_PROJECT: "" }, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("faber relay", () => {
  const p = join(dir, "star");
  it("init refuses a project with no hosts, then writes relay/ from faber.json network", () => {
    expect(faber("new", "star", "--template", "xiao-esp32s3").code).toBe(0);
    const none = faber("relay", "init", "-p", "star");
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/nothing for a relay to call.*Fix: set_network/s);
    expect(faber("call", "set_network", JSON.stringify({ secrets: ["API_KEY"], allow: [{ host: "api.example.com", secrets: ["API_KEY"], headers: { Authorization: "Bearer {{secret:API_KEY}}" } }] }), "-p", "star").code).toBe(0);
    const init = faber("relay", "init", "-p", "star");
    expect(init.code, init.err).toBe(0);
    for (const f of ["server.mjs", "worker.js", "wrangler.toml", "README.md", "relay.config.mjs", "firmware/FaberRelay.h"]) expect(existsSync(join(p, "relay", f)), f).toBe(true);
    expect(faber("relay", "nope", "-p", "star").code).toBe(2);
  }, 60_000);

  it("token add / list / revoke keep raw tokens in .env only, hashes for the relay, and git-ignore the secrets", () => {
    const a = faber("relay", "token", "add", "star-1", "-p", "star");
    expect(a.code, a.err).toBe(0);
    const token = /device token for star-1: (jdt_\S+)/.exec(a.out)![1]!;
    const env = readFileSync(join(p, ".env"), "utf8");
    expect(env).toContain(`DEVICE_TOKEN=${token}`);
    expect(env).toMatch(/RELAY_DEVICE_TOKENS=star-1:[0-9a-f]{64}/);
    expect(readFileSync(join(p, ".gitignore"), "utf8")).toMatch(/^\.env$/m);
    expect(readFileSync(join(p, ".gitignore"), "utf8")).toMatch(/^faber_device\.h$/m);
    // nothing committed-looking holds the token
    for (const f of ["faber.json", "relay/relay.config.mjs", "relay/README.md"]) expect(readFileSync(join(p, f), "utf8")).not.toContain(token);
    expect(faber("relay", "token", "add", "star-2", "-p", "star").code).toBe(0);
    expect(faber("relay", "token", "list", "-p", "star").out.trim().split("\n")).toEqual(["star-1", "star-2"]);
    expect(faber("relay", "token", "revoke", "star-1", "-p", "star").code).toBe(0);
    expect(faber("relay", "token", "list", "-p", "star").out.trim()).toBe("star-2");
    expect(faber("relay", "token", "revoke", "ghost", "-p", "star").code).toBe(1);
    expect(faber("relay", "token", "add", "bad name!", "-p", "star").code).toBe(1);
  }, 60_000);

  it("device-header says what .env lacks, then writes faber_device.h next to the sketch", () => {
    const miss = faber("relay", "device-header", "-p", "star");
    expect(miss.code).toBe(1);
    expect(miss.err).toMatch(/RELAY_URL, WIFI_SSID not set.*Fix:/s);
    appendFileSync(join(p, ".env"), "RELAY_URL=https://star-relay.me.workers.dev\nWIFI_SSID=Home\nWIFI_PASSWORD=secret pass\n");
    const ok = faber("relay", "device-header", "-p", "star");
    expect(ok.code, ok.err).toBe(0);
    const h = readFileSync(join(p, "firmware", "faber_device.h"), "utf8");
    expect(h).toContain('#define FABER_RELAY_URL "https://star-relay.me.workers.dev"');
    expect(h).toContain('#define FABER_WIFI_PASSWORD "secret pass"');
    expect(existsSync(join(p, "firmware", "FaberRelay.h"))).toBe(true);
  }, 60_000);

  it("serve runs the relay from the project's config and .env", async () => {
    writeFileSync(join(p, ".env"), readFileSync(join(p, ".env"), "utf8") + "API_KEY=sk-test-not-real-123456\n");
    const port = 13000 + 90 + Math.floor(Math.random() * 9);
    const child = spawn(process.execPath, [BIN, "relay", "serve", "--port", String(port), "--host", "127.0.0.1", "-p", "star"], { env: { ...process.env, INIT_CWD: dir, FABER_PROJECT: "" }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((ok, bad) => {
        let err = "";
        child.stderr.on("data", (d: Buffer) => {
          err += d.toString();
          if (err.includes("Ctrl+C")) ok();
        });
        child.on("exit", (c) => bad(new Error(`relay serve exited ${c}: ${err}`)));
      });
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      const token = /^DEVICE_TOKEN=(\S+)$/m.exec(readFileSync(join(p, ".env"), "utf8"))![1]!;
      const r = await fetch(`http://127.0.0.1:${port}/other.example.net/x`, { headers: { "x-device-token": token } });
      expect(r.status).toBe(403);
    } finally {
      child.kill("SIGINT");
    }
  }, 60_000);
});
