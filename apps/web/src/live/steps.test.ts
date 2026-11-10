import { describe, expect, it } from "vitest";
import { agentSteps, noteStepActors, type LiveStep } from "./liveStore.ts";

// Round 6, switch track: the person's own edits (actor "web") are never pending agent steps.
const steps: LiveStep[] = [
  { id: 1, why: "wire the OLED", status: "pending", ops: ["connect w1"] },
  { id: 2, why: "edited in the code editor", status: "pending", ops: ["write_file firmware/a.ino"] },
  { id: 3, why: "restore version 1", status: "pending", ops: ["restore_version 1"] },
  { id: 4, why: "older step", status: "accepted", ops: ["place_part led1"] },
];

describe("Agent steps", () => {
  it("leaves out steps the person made on the page, keeps agents' and unknown ones", () => {
    const actors = noteStepActors(
      [
        { step: { id: 1 }, actor: "mcp" },
        { step: { id: 2 }, actor: "web" },
        { step: { id: 2 }, actor: "web" },
        { step: { id: 3 }, actor: "web" },
        {},
      ],
      {},
    );
    expect(actors).toEqual({ 1: ["mcp"], 2: ["web"], 3: ["web"] });
    expect(agentSteps(steps, actors, "follow").map((s) => s.id)).toEqual([1, 4]);
    // A replay shows the whole recording.
    expect(agentSteps(steps, actors, "replay").map((s) => s.id)).toEqual([1, 2, 3, 4]);
    // A step an agent and the page both touched stays.
    expect(agentSteps(steps, noteStepActors([{ step: { id: 2 }, actor: "cli" }], actors), "follow").map((s) => s.id)).toEqual([1, 2, 4]);
  });
});

describe("Agent steps with the step's own actor", () => {
  it("never lists a step the server says the person made, even without its log entry", () => {
    const own: LiveStep[] = [
      { id: 7, why: "update_case", status: "pending", ops: ["update_case"], actor: "web" },
      { id: 8, why: "add a buzzer", status: "pending", ops: ["place_part bz"], actor: "mcp" },
    ];
    expect(agentSteps(own, {}, "follow").map((s) => s.id)).toEqual([8]);
  });
});
