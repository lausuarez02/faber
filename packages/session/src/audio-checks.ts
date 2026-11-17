/**
 * Round 13 (audio): design checks for digital audio out, generic over parts: an I2S amplifier (a part
 * with I2S input pins and a bridge-tied OUT+ / OUT- pair, such as the MAX98357A) and the speaker it
 * drives. Nothing here knows what the audio is for (tones, clips, speech from an API).
 *
 *   amp-no-speaker          the amplifier's output pair is not across a speaker
 *   amp-out-shorted         OUT+ or OUT- tied to ground, a supply or a board pin (bridge-tied output)
 *   amp-speaker-overpower   full-scale audio would push more power into the speaker than it is rated for
 *   amp-speaker-impedance   a speaker below the amplifier's minimum load
 */
import { buildNets, type Project } from "@fabwright/project-format";
import type { PartRegistry, PartSpec } from "@fabwright/sim-core";
import type { DesignIssue } from "./drc.ts";
import { isSpeakerType } from "./voice.ts";

/**
 * Per amplifier type: RMS voltage across OUT+ / OUT- at digital full scale with the nominal gain
 * and a 5 V supply (it scales with the supply, until the output swing clips), the gain prop, its
 * nominal value and the smallest load. MAX98357A: 3.2 W into 4 Ω at 5 V (datasheet, 10 % THD+N)
 * is ~3.6 V RMS; 9 dB nominal gain (GAIN floating); 4 Ω minimum.
 */
export const I2S_AMPS: Record<string, { fullScaleVrms5V: number; gainProp: string; nominalGainDb: number; minLoadOhms: number }> = {
  max98357a: { fullScaleVrms5V: 3.6, gainProp: "gain_db", nominalGainDb: 9, minLoadOhms: 4 },
};

const num = (v: unknown, d: number) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const round2 = (x: number) => Math.round(x * 100) / 100;

export function audioChecks(project: Project, registry: PartRegistry): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const nets = buildNets(project);
  const netOf = (part: string, pin: string) => nets.find((n) => n.pins.some((x) => x.part === part && x.pin === pin));
  const partOf = (id: string) => project.parts.find((p) => p.id === id);
  const specOf = (id: string): PartSpec | undefined => {
    const p = partOf(id);
    return p ? registry.get(p.type)?.spec : undefined;
  };

  for (const amp of project.parts) {
    const spec = registry.get(amp.type)?.spec;
    if (!spec) continue;
    const hasI2s = spec.pins.some((x) => x.protocols?.some((p) => p.startsWith("i2s-")));
    const outs = ["OUT+", "OUT-"].filter((id) => spec.pins.some((x) => x.id === id));
    if (!hasI2s || outs.length !== 2) continue;
    const others = (pin: string) => netOf(amp.id, pin)?.pins.filter((x) => x.part !== amp.id) ?? [];
    const plus = others("OUT+");
    const minus = others("OUT-");

    // Bridge-tied: neither output may touch ground, a supply or a board pin.
    for (const pin of outs) {
      const bad = others(pin).filter((x) => {
        const s = specOf(x.part);
        const sp = s?.pins.find((q) => q.id === x.pin);
        return sp?.type === "ground" || sp?.type === "power" || (s?.category === "board" && sp?.type !== "passive");
      });
      if (bad.length) {
        issues.push({
          severity: "error",
          code: "amp-out-shorted",
          message: `${amp.id}.${pin} is wired to ${bad.map((x) => `${x.part}.${x.pin}`).join(", ")}. Why: ${spec.name}'s outputs are bridge-tied (both swing; neither is ground), so tying one to GND, a supply or a board pin shorts the amplifier: it overheats or shuts down, and the speaker stays silent. Fix: disconnect it; the speaker goes across ${amp.id}.OUT+ and ${amp.id}.OUT- only.`,
          parts: [amp.id, ...new Set(bad.map((x) => x.part))],
          pins: [`${amp.id}.${pin}`, ...bad.map((x) => `${x.part}.${x.pin}`)],
        });
      }
    }

    const speakers = plus.filter((a) => isSpeakerType(partOf(a.part)?.type ?? "") && minus.some((b) => b.part === a.part)).map((a) => a.part);
    if (!speakers.length) {
      const loose = [...plus, ...minus].filter((x) => isSpeakerType(partOf(x.part)?.type ?? ""));
      issues.push({
        severity: "warning",
        code: "amp-no-speaker",
        message: `${amp.id} (${spec.name}) has no speaker across its output. Why: the audio the board sends over I2S only becomes sound through a speaker between OUT+ and OUT-; ${loose.length ? `${loose.map((x) => `${x.part}.${x.pin}`).join(", ")} is on only one of them, so no current flows` : "nothing is on those pins"}. Fix: place_part speaker-20mm (or speaker), then connect ${amp.id}.OUT+ → speaker + and ${amp.id}.OUT- → speaker -.`,
        parts: [amp.id],
        pins: [`${amp.id}.OUT+`, `${amp.id}.OUT-`],
      });
      continue;
    }

    const model = I2S_AMPS[spec.id];
    if (!model) continue;
    // Supply: the highest rail on VIN's net (a board's 5V / VBUS pin, 3V3, or a battery's maximum).
    const vin = Math.max(0, ...(netOf(amp.id, "VIN")?.pins ?? []).map((x) => (x.part === amp.id ? 0 : (specOf(x.part)?.pins.find((q) => q.id === x.pin)?.voltage?.max ?? 0))));
    const supply = vin > 0 ? vin : 5;
    const gain = num(amp.props?.[model.gainProp], model.nominalGainDb);
    // Bridge-tied swing clips near the supply: at most ~0.9 x VIN peak, as RMS of a sine.
    const vrms = Math.min(model.fullScaleVrms5V * (supply / 5) * 10 ** ((gain - model.nominalGainDb) / 20), (0.9 * supply) / Math.SQRT2);
    for (const spk of speakers) {
      const sp = partOf(spk)!;
      const sspec = specOf(spk);
      const ohms = num(sp.props?.ohms, num(sspec?.props?.find((x) => x.id === "ohms")?.default, 8));
      const rated = num(sp.props?.rated_w, num(sspec?.props?.find((x) => x.id === "rated_w")?.default, sspec?.limits?.maxPowerW ?? 0.5));
      if (ohms < model.minLoadOhms) {
        issues.push({
          severity: "error",
          code: "amp-speaker-impedance",
          message: `${spk} is ${ohms} Ω, below the ${model.minLoadOhms} Ω ${spec.name} can drive. Why: a lower load draws more current than the amplifier allows; it overheats and shuts down. Fix: use a ${model.minLoadOhms} Ω or 8 Ω speaker.`,
          parts: [amp.id, spk],
        });
        continue;
      }
      const watts = (vrms * vrms) / ohms;
      if (watts > rated * 1.25) {
        // Largest level that stays within the rating: sample peak as a fraction of full scale.
        const safe = Math.min(1, Math.sqrt(rated / watts));
        const dbfs = Math.round(20 * Math.log10(safe));
        issues.push({
          severity: "warning",
          code: "amp-speaker-overpower",
          message: `${amp.id} can push about ${round2(watts)} W into ${spk} (${ohms} Ω, rated ${rated} W) at full-scale audio (${round2(supply)} V on VIN, ${gain} dB gain). Why: a loud sound, a full-scale tone or speech normalized to 0 dBFS would distort and can burn the coil. Fix: keep the samples at or below ${Math.round(safe * 100)} % of full scale (${dbfs} dBFS; scale them in the firmware), or lower the gain (${amp.id}.GAIN to VIN = 6 dB; 100 kΩ to VIN = 3 dB), or use a speaker rated ${round2(Math.ceil(watts * 4) / 4)} W or more.`,
          parts: [amp.id, spk],
        });
      }
    }
  }
  return issues;
}
