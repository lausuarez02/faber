// Round 5 parts: every new part has a usage hint whose typical connections name real pins, and the
// session places and describes them through get_part like any built-in.
import { describe, expect, it } from "vitest";
import { getPart, partDefinitions } from "@jumper/parts";
import { PARTS_R5_HINTS } from "../src/hints-parts.ts";
import { usageFor } from "../src/hints.ts";

const NEW = [
  "gc9a01-round-tft", "lipo-battery", "tp4056-charger", "passive-buzzer", "vibration-motor", "ttp223-touch",
  "capacitive-soil-moisture", "relay-module", "water-pump", "ir-proximity", "bump-switch", "dht22", "pir-motion", "ws2812-strip",
];
const shortId = (type: string) => type.replace(/[^A-Za-z0-9_]/g, "");

describe("round 5 part hints", () => {
  it.each([...new Set([...NEW, ...Object.keys(PARTS_R5_HINTS)])])("%s has wiring, typical connections on real pins and an example", (type) => {
    const spec = getPart(type)?.spec;
    expect(spec, `${type} in the registry`).toBeDefined();
    expect(PARTS_R5_HINTS[type], `${type} in hints-parts.ts`).toBeDefined();
    const u = usageFor(spec!);
    expect(u.wiring.length).toBeGreaterThan(40);
    expect(u.example, `${type}: example (hint or example.ino)`).toBeTruthy();
    for (const line of u.connect ?? []) {
      const [a, b] = line.split(" -> ");
      for (const end of [a!, b!]) {
        const i = end.indexOf(".");
        const part = end.slice(0, i);
        const pin = end.slice(i + 1);
        if (part === "uno") {
          expect(getPart("arduino-uno")!.spec.pins.some((p) => p.id === pin || (pin === "GND" && p.id.startsWith("GND"))), `${line}: uno.${pin}`).toBe(true);
          continue;
        }
        const t = partDefinitions.map((d) => d.spec.id).find((x) => `${shortId(x)}1` === part);
        expect(t, `${line}: '${part}' is a first-placed id`).toBeDefined();
        expect(getPart(t!)!.spec.pins.map((p) => p.id), `${line}: ${part}.${pin}`).toContain(pin);
      }
    }
  });

  it("the active buzzer no longer claims tone() works", () => {
    expect(usageFor(getPart("buzzer")!.spec).wiring).toMatch(/tone\(\) does NOT set its pitch/);
  });

  it("uses the tested example.ino for parts that ship one", () => {
    expect(usageFor(getPart("dht22")!.spec).example).toMatch(/readDht22/);
    expect(usageFor(getPart("ws2812-strip")!.spec).example).toMatch(/__builtin_avr_delay_cycles/);
    expect(usageFor(getPart("gc9a01-round-tft")!.spec).example).toMatch(/class GC9A01/);
    expect(usageFor(getPart("passive-buzzer")!.spec).example).toMatch(/tone\(BUZZER/);
  });

  it("never wires a battery or a 5 V-only part to the wrong rail", () => {
    expect(usageFor(getPart("lipo-battery")!.spec).connect!.some((c) => /uno\.(5V|VIN)/.test(c))).toBe(false);
    expect(usageFor(getPart("relay-module")!.spec).connect).toContain("relaymodule1.VCC -> uno.5V");
    expect(usageFor(getPart("pir-motion")!.spec).connect).toContain("pirmotion1.VCC -> uno.5V");
  });
});
