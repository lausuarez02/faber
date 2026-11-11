// Round 10 (languages): MicroPython through the session, the path agents, the CLI and the web app
// use. No fake builder: MicroPython builds in process (pinned official firmware bundled in the repo,
// littlefs image, mpy-cross syntax check), and runs on rp2040js.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSession } from "../src/index.ts";

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): ProjectSession {
  const dir = mkdtempSync(join(tmpdir(), "jumper-lang-"));
  dirs.push(dir);
  const s = new ProjectSession({ dir, actor: "test" });
  sessions.push(s);
  return s;
}

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

describe("MicroPython on the Raspberry Pi Pico", { timeout: 120_000 }, () => {
  it("pico-micropython: main.py blinks the on-board LED, prints, and its scenario passes", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "pico-micropython" });
    const b = await call(s, "build");
    expect(b.ok).toBe(true);
    expect(b.language).toBe("micropython");
    expect(b.built).toMatch(/MicroPython 1\.29\.0 \(RPI_PICO\) \+ 1 file/);
    const r = await call(s, "run", { ms: 1300 });
    expect(r.serial).toContain("ready");
    expect(r.serial).toMatch(/LED on\r?\nLED off\r?\nLED on/);
    const t = await call(s, "run_tests");
    expect(t.failed).toBe(0);
    expect(t.passed).toBe(1);
  });

  it("pico-micropython-oled: I2C0 finds the OLED at 0x3C and the screen lights up", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "pico-micropython-oled" });
    const r = await call(s, "run", { ms: 1500 });
    expect(r.serial).toContain("i2c scan: ['0x3c']");
    expect(r.serial).toMatch(/frame 3/);
    const d = await call(s, "read_display", { part: "oled", scale: 2 });
    expect(d.lit_pixels).toBeGreaterThan(200);
    const t = await call(s, "run_tests");
    expect(t.failed).toBe(0);
  });

  it("a syntax error is a build error at file:line, before anything runs", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "pico-micropython" });
    await call(s, "write_file", { path: "firmware/helper.py", content: "def f(:\n    return 1\n" });
    const b = await call(s, "build");
    expect(b.ok).toBe(false);
    expect(b.errors.join("\n")).toMatch(/firmware\/helper\.py:1.*SyntaxError/);
  });

  it("a runtime traceback comes back as an error at the project's file:line, and the REPL answers", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "pico-micropython" });
    await call(s, "write_file", { path: "firmware/util.py", content: "def half(x):\n    return x / 0\n" });
    await call(s, "write_file", { path: "firmware/main.py", content: "import util\nprint('start')\nutil.half(4)\n" });
    const r = await call(s, "run", { ms: 400 });
    expect(r.serial).toContain("ZeroDivisionError");
    expect(r.errors).toEqual(["firmware/util.py:2: ZeroDivisionError: divide by zero"]);
    // main.py ended, so MicroPython waits at its REPL on the same console.
    const q = await call(s, "run", { ms: 200, serial_write: "print(6 * 7)\n" });
    expect(q.serial).toContain("42");
  });

  it("set_firmware switches a board's language and refuses one that does not run there, saying why", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "pico" });
    const r = await call(s, "set_firmware", { language: "micropython" });
    expect(r.main).toBe("firmware/main.py");
    expect(r.languages_on_this_board).toContain("micropython");
    const project = JSON.parse(readFileSync(join(s.dir, "jumper.json"), "utf8"));
    expect(project.firmware).toMatchObject({ language: "micropython", sketch: "main.py", build: { tool: "micropython" } });
    const uno = fresh();
    await call(uno, "new_project", { template: "uno" });
    await expect(call(uno, "set_firmware", { language: "micropython" })).rejects.toThrow(/does not run on uno \(atmega328p\).*2 KB RAM/s);
  });

  it("writing main.py on a fresh Pico project makes it a MicroPython project", async () => {
    const s = fresh();
    await call(s, "new_project", { template: "pico" });
    const w = await call(s, "write_file", { path: "firmware/main.py", content: "print('hi from py')\n" });
    expect(w.notes.join(" ")).toMatch(/MicroPython now/);
    const r = await call(s, "run", { ms: 300 });
    expect(r.serial).toContain("hi from py");
  });
});
