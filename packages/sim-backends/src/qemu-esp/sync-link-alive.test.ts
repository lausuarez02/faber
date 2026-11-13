// SyncBridgeLink.nextAsync keeps a short-lived process alive while the emulator boots: its worker
// and the emulator are unref'd and Atomics.waitAsync holds no handle, so before the fix Node exited
// with "unsettled top-level await" (exit 13) when the only thing left was the wait (`jumper test`
// booting the third scenario's QEMU). The child script is the whole program, as in the CLI.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LINK = fileURLToPath(new URL("./sync-link.ts", import.meta.url));

describe("SyncBridgeLink.nextAsync", () => {
  it("holds the event loop until the emulator answers (no other handle open)", () => {
    const dir = mkdtempSync(join(tmpdir(), "jumper-sync-link-"));
    try {
      const script = join(dir, "main.mts");
      // The "emulator" is a detached, unref'd process with no stdio that connects 600 ms later.
      writeFileSync(
        script,
        `import { spawn } from "node:child_process";
import { SyncBridgeLink } from ${JSON.stringify(LINK)};
const link = new SyncBridgeLink();
const emu = spawn(process.execPath, ["-e", "setTimeout(() => { const s = require('node:net').connect(" + link.port + ", '127.0.0.1', () => s.write('T 1\\\\n')); s.on('error', () => {}); setTimeout(() => s.destroy(), 300); }, 600)"], { stdio: "ignore", detached: true });
emu.unref();
const lines = await link.nextAsync(5000);
process.stdout.write("got " + JSON.stringify(lines) + "\\n");
link.close();
`,
      );
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script], { encoding: "utf8", timeout: 20_000 });
      expect(r.stderr).not.toContain("unsettled top-level await");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('got ["T 1"]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
