// `jumper` (the command's name before the rename to Faber) and JUMPER_* variables keep working.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = (name: string) => fileURLToPath(new URL(`../bin/${name}.mjs`, import.meta.url));
const run = (bin: string, args: string[], env: Record<string, string> = {}) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FABER_") && !k.startsWith("JUMPER_")));
  const r = spawnSync(process.execPath, [BIN(bin), ...args], { encoding: "utf8", env: { ...clean, FABER_DOCKER_PROBE_MS: "1", ...env }, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("the jumper alias", () => {
  it("runs faber with the same arguments and says so once on stderr, never on stdout", () => {
    const old = run("jumper", ["help"]);
    const now = run("faber", ["help"]);
    expect(old.code).toBe(0);
    expect(old.out).toBe(now.out);
    expect(old.err).toMatch(/^jumper: this command is now called faber/);
    expect(now.err).not.toMatch(/now called faber/);
  });

  it("honours JUMPER_* when FABER_* is unset, and FABER_* wins when both are set", () => {
    const home = mkdtempSync(join(tmpdir(), "faber-legacy-home-"));
    expect(run("faber", ["setup", "list"], { JUMPER_NATIVE_HOME: home, FABER_RUNTIME: "native" }).out).toContain(home);
    const other = join(home, "other");
    const both = run("faber", ["setup", "list"], { JUMPER_NATIVE_HOME: home, FABER_NATIVE_HOME: other, FABER_RUNTIME: "native" }).out;
    expect(both).toContain(other);
  });
});
