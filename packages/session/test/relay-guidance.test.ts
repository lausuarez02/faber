// Round 13 (star eval): an agent asked for a device that sends what it sees to an API must learn the
// general relay pattern (call the real API through JumperRelay.h), not invent a backend of its own; and
// a board's own card slot puts a microSD card on the shopping list only when the firmware uses one.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@jumper/runner";
import { registry } from "@jumper/parts";
import { planDevice, ProjectSession } from "../src/index.ts";
import { AGENT_LOOP as AGENT_INSTRUCTIONS } from "../src/catalog.ts";
import { buildKit } from "../src/kit/index.ts";
import * as E from "@jumper/enclosure";

const SEE_AND_SAY = fileURLToPath(new URL("../../../examples/see-and-say", import.meta.url));
const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}`);
};
const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function open(src: string): ProjectSession {
  const dir = mkdtempSync(join(tmpdir(), "jumper-relayhint-"));
  dirs.push(dir);
  cpSync(src, dir, { recursive: true });
  const s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
  sessions.push(s);
  return s;
}

describe("agents learn the relay for API calls", () => {
  it("get_part on a Wi-Fi board in the ESP emulator carries the network guide; other boards do not", async () => {
    const s = open(SEE_AND_SAY);
    const sense = (await s.getPart({ type: "seeed-xiao-esp32s3-sense" })) as { network?: string };
    expect(sense.network).toMatch(/JumperRelay\.h/);
    expect(sense.network).toMatch(/jumperRelayUrl/);
    expect(sense.network).toMatch(/backend of your own/);
    const uno = (await s.getPart({ type: "arduino-uno" })) as { network?: string };
    expect(uno.network).toBeUndefined();
  });

  it("plan_device for a device that sends what it sees to an API lists the relay step", () => {
    const p = planDevice("a star keychain with a camera that sends what it sees through an api and a speaker that says funny things", { pocket: true }, registry);
    expect(p.board.type).toBe("seeed-xiao-esp32s3-sense");
    expect(p.next.join("\n")).toMatch(/through the relay.*JumperRelay\.h/);
    const offline = planDevice("a night light that glows when it is dark", {}, registry);
    expect(offline.next.join("\n")).not.toMatch(/JumperRelay/);
  });

  it("the agent instructions name the relay and say not to invent a backend", () => {
    expect(AGENT_INSTRUCTIONS).toMatch(/jumperRelayUrl\(host, path\)/);
    expect(AGENT_INSTRUCTIONS).toMatch(/never invent a backend/);
  });
});

describe("a board's own card slot", () => {
  it("needs no microSD card when the firmware never reads one, and lists it when it does", async () => {
    const s = open(SEE_AND_SAY);
    const kit = await buildKit(s, { slicer: "off" });
    expect(kit.shopping.lines.map((l) => l.name)).not.toContain("microSD card");
    writeFileSync(join(s.dir, "firmware/sd.cpp"), '#include <SD_MMC.h>\nvoid mountCard() { SD_MMC.begin(); }\n');
    const withCard = await buildKit(s, { slicer: "off" });
    expect(withCard.shopping.lines.map((l) => l.name)).toContain("microSD card");
  });

  it("the assembly plan puts a card into the board's slot only when the firmware reads one", () => {
    const s = open(SEE_AND_SAY);
    const project = { ...s.project, enclosure: { shape: "rounded-box" } } as typeof s.project;
    const specOf = (t: string) => s.registry.get(t)?.spec;
    const L = E.layoutCase(E.layoutInput(project, specOf));
    const cardStep = (fw?: string) => E.assemblyPlan({ project, layout: L, specOf, ...(fw !== undefined ? { firmwareText: fw } : {}) }).steps.some((st) => /microSD card into/.test(st.title));
    expect(cardStep("void setup() {}\nvoid loop() {}")).toBe(false);
    expect(cardStep('#include "SD_MMC.h"\nvoid setup() { SD_MMC.begin(); }')).toBe(true);
    expect(E.assemblyPlan({ project, layout: L, specOf, firmwareText: "void setup() {}" }).firmware_card).toBe(false);
  });
});
