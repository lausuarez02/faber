// Round 6b: the factory pack never says "the sketch changed" when the hex was built from these very
// sources (an opened example is a copy: no build record, file times a moment apart), and when the
// firmware really is missing it says what to press.
import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSession } from "../src/index.ts";

const MUSE = fileURLToPath(new URL("../../../examples/agent-built/claude-pocket-muse", import.meta.url));
const T = 240_000;
let dir: string | undefined;
let s: ProjectSession | undefined;
afterEach(() => {
  s?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
  s = undefined;
  dir = undefined;
});

const copy = () => {
  process.env.FABWRIGHT_CASE_PDF = "0";
  dir = mkdtempSync(join(tmpdir(), "fabwright-fw-"));
  cpSync(MUSE, dir, { recursive: true });
  return dir;
};
type Missing = { item: string; why: string; fix: string; say?: string }[];

describe("factory pack firmware", () => {
  it(
    "a copied example whose sources are a moment newer than its hex is not 'changed'",
    async () => {
      const d = copy();
      const now = Date.now() / 1000;
      utimesSync(join(d, "firmware", "main.hex"), now - 0.5, now - 0.5);
      for (const f of ["main.ino", "types.h", "gc9a01.h"]) utimesSync(join(d, "firmware", f), now, now);
      s = new ProjectSession({ dir: d, actor: "test" });
      const r = (await s.call("export_manufacturing", {})) as { files: string[]; missing: Missing };
      expect(r.missing.map((m) => m.item)).not.toContain("firmware/firmware.hex");
      expect(r.files).toContain("firmware/firmware.hex");
    },
    T,
  );

  it(
    "an edited sketch is stale, and the fix says what to press",
    async () => {
      const d = copy();
      const now = Date.now() / 1000;
      utimesSync(join(d, "firmware", "main.hex"), now - 3600, now - 3600);
      writeFileSync(join(d, "firmware", "main.ino"), "// edited\nvoid setup(){}\nvoid loop(){}\n");
      s = new ProjectSession({ dir: d, actor: "test" });
      const r = (await s.call("export_manufacturing", {})) as { missing: Missing };
      const fw = r.missing.find((m) => m.item === "firmware/firmware.hex")!;
      expect(fw.why).toBe("the sketch changed since the last build");
      expect(fw.say).toBe("press Run (or Build) first, then Factory pack again");
      expect(fw.say).not.toMatch(/export_manufacturing|build_firmware|_/);
    },
    T,
  );
});
