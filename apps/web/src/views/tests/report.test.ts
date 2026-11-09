import { describe, expect, it } from "vitest";
import report from "../../../public/reports/tamagotchi.json";
import { isVisualReport, type VisualReport } from "./types.ts";
import { stripFrames } from "./VisualTestReportView.tsx";
import { thumbKind } from "./thumbs.tsx";

describe("visual test report", () => {
  const r = report as unknown as VisualReport;
  it("reads the prebuilt example report", () => {
    expect(isVisualReport(r)).toBe(true);
    expect(r.scenarios.length).toBe(6);
    expect(r.failed).toBe(0);
  });
  it("filmstrips show checks and inputs, not plain waits, and screens as screen thumbs", () => {
    const play = r.scenarios.find((s) => s.id === "play-beeps")!;
    const strip = stripFrames(play);
    expect(strip.some((f) => f.kind === "run_ms")).toBe(false);
    expect(strip.map((f) => f.kind)).toContain("press");
    const sounding = strip.find((f) => f.label.startsWith("buzzer.sounding"))!;
    expect(sounding.state.buzzers?.buzzer).toBe(true);
    expect(thumbKind(sounding.state)).toBe("screen");
  });
});
