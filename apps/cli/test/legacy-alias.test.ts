// `jumper` (the command's name before the rename to Fabwright) and JUMPER_* variables keep working.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = (name: string) => fileURLToPath(new URL(`../bin/${name}.mjs`, import.meta.url));
const run = (bin: string, args: string[], env: Record<string, string> = {}) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FABWRIGHT_") && !k.startsWith("JUMPER_")));
  const r = spawnSync(process.execPath, [BIN(bin), ...args], { encoding: "utf8", env: { ...clean, FABWRIGHT_DOCKER_PROBE_MS: "1", ...env }, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("the jumper alias", () => {
  it("runs fabwright with the same arguments and says so once on stderr, never on stdout", () => {
    const old = run("jumper", ["help"]);
    const now = run("fabwright", ["help"]);
    expect(old.code).toBe(0);
    expect(old.out).toBe(now.out);
    expect(old.err).toMatch(/^jumper: this command is now called fabwright/);
    expect(now.err).not.toMatch(/now called fabwright/);
  });

  it("honours JUMPER_* when FABWRIGHT_* is unset, and FABWRIGHT_* wins when both are set", () => {
    const home = mkdtempSync(join(tmpdir(), "fabwright-legacy-home-"));
    expect(run("fabwright", ["setup", "list"], { JUMPER_NATIVE_HOME: home, FABWRIGHT_RUNTIME: "native" }).out).toContain(home);
    const other = join(home, "other");
    const both = run("fabwright", ["setup", "list"], { JUMPER_NATIVE_HOME: home, FABWRIGHT_NATIVE_HOME: other, FABWRIGHT_RUNTIME: "native" }).out;
    expect(both).toContain(other);
  });
});
