import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectSession } from "../src/index.ts";

// Round 6b (ui): the person's own changes (actor "web") are never pending agent steps.
let dir: string;
let s: ProjectSession;
const steps = async () => ((await s.call("list_steps")) as { steps: { id: number; status: string; actor?: string; why: string }[] }).steps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fabwright-person-steps-"));
  s = new ProjectSession({ dir, actor: "mcp" });
});
afterEach(() => {
  s.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("person steps", () => {
  it("accepts a web change when made, keeps the agent's step pending and open", async () => {
    await s.call("new_project", { template: "blank", name: "t" });
    await s.call("place_part", { type: "arduino-uno", why: "the board" });
    await s.call("write_file", { path: "firmware/main.ino", content: "void setup(){}\nvoid loop(){}\n", why: "edited in the code editor" }, { actor: "web" });
    await s.call("place_part", { type: "led" }); // no why: joins the agent's open step
    const list = await steps();
    const agent = list.filter((x) => x.actor === "mcp");
    const own = list.filter((x) => x.actor === "web");
    expect(own).toHaveLength(1);
    expect(own[0]!.status).toBe("accepted");
    expect(agent.some((x) => x.why === "the board" && x.status === "pending")).toBe(true);
    expect(list.filter((x) => x.status === "pending").every((x) => x.actor !== "web")).toBe(true);
    // the log names the person's own step on the person's entry (History shows its why)
    const log = readFileSync(join(dir, ".fabwright", "actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { op: string; actor: string; step?: { id: number; why: string } });
    const w = log.find((e) => e.op === "write_file")!;
    expect(w.step).toEqual({ id: own[0]!.id, why: "edited in the code editor" });
    // the LED joined the agent's open step, not the person's
    const full = s.history.steps.find((x) => x.why === "the board")!;
    expect(full.labels.some((l) => l.startsWith("place_part led"))).toBe(true);
  });

  it("redo of the person's step comes back accepted", async () => {
    await s.call("new_project", { template: "blank", name: "t" }, { actor: "web" });
    await s.call("place_part", { type: "arduino-uno", why: "my board" }, { actor: "web" });
    await s.call("undo", {}, { actor: "web" });
    await s.call("redo", {}, { actor: "web" });
    const mine = (await steps()).find((x) => x.why === "my board");
    expect(mine).toMatchObject({ status: "accepted", actor: "web" });
  });

  it("settles pending steps saved before steps carried an actor when their ops were the person's", async () => {
    await s.call("new_project", { template: "blank", name: "t" });
    await s.call("place_part", { type: "arduino-uno", why: "agent board" });
    await s.call("place_part", { type: "led", why: "my led" }, { actor: "web" });
    s.dispose();
    // rewrite history.json the way round 6 saved it: every step pending, no actor
    const hf = join(dir, ".fabwright", "history.json");
    const h = JSON.parse(readFileSync(hf, "utf8")) as { steps: { status: string; actor?: string }[] };
    for (const st of h.steps) {
      st.status = "pending";
      delete st.actor;
    }
    writeFileSync(hf, JSON.stringify(h));
    s = new ProjectSession({ dir, actor: "mcp" });
    const list = await steps();
    expect(list.find((x) => x.why === "my led")?.status).toBe("accepted");
    expect(list.find((x) => x.why === "agent board")?.status).toBe("pending");
  });
});
