// Round 14: battery life from duty cycles, for any project. Each load (the board's CPU and Wi-Fi, a
// camera, a screen, an audio amplifier, any part with a current figure) draws its active current part
// of the time and its idle current the rest; the duty comes from faber.json power.duty, or is guessed
// from the firmware (said in `assumptions`, so the person can correct it). Figures are datasheet
// typicals with their source; nothing here is measured. check_design reports `battery-life` (a warning
// under power.target_hours, with the cell size that would make it) and get_build_kit carries it.
import { LIPO_CELLS } from "@faber/enclosure";
import type { Project } from "@faber/project-format";
import type { PartRegistry, PartSpec } from "@faber/sim-core";

/** "always", "off", or on_s seconds every every_s seconds. */
export type Duty = "always" | "off" | { on_s: number; every_s: number };

export interface PowerProfile {
  /** Hours the device should run on one charge (check_design warns under it). */
  target_hours?: number;
  /** Duty per load: a role (cpu, wifi, camera, display, audio) or a part id. */
  duty?: Record<string, Duty>;
  /** What the board does between active moments: "none" (stays on), "light" or "deep" sleep. */
  sleep?: "none" | "light" | "deep";
  /** Round 15: wakes per day of a board that sleeps (timer + presses). */
  wakes_per_day?: number;
  /** Round 15: seconds awake per wake. */
  awake_s?: number;
}

/** Round 15: a wake pattern measured from a run's deep sleeps (Simulation.sleepLog()). */
export interface MeasuredSleep {
  wakes_per_day: number;
  awake_s: number;
  /** In words: what was measured, over how long. */
  source: string;
}

/** Wakes per day and seconds awake per wake from a run's sleep log (extrapolated from the run's length). */
export function measuredSleep(log: readonly { t_ms: number; woke?: { t_ms: number } }[], runMs: number): MeasuredSleep | undefined {
  if (!log.length || runMs <= 0) return undefined;
  const awake: number[] = [log[0]!.t_ms];
  for (let i = 0; i + 1 < log.length; i++) if (log[i]!.woke) awake.push(log[i + 1]!.t_ms - log[i]!.woke!.t_ms);
  const wakes = log.filter((e) => e.woke).length;
  const awake_s = Math.max(0.001, awake.reduce((a, b) => a + b, 0) / awake.length / 1000);
  return { wakes_per_day: Math.round(((wakes + 1) / runMs) * 86_400_000 * 10) / 10, awake_s: Math.round(awake_s * 1000) / 1000, source: `the last run: ${wakes + 1} boot(s) in ${Math.round(runMs / 1000)} s of virtual time, ${Math.round(awake_s * 1000)} ms awake each` };
}

/** The timer the firmware arms before sleeping, in seconds (literal products only, e.g. 3600ULL * 1000000ULL). */
export function sleepTimerSeconds(src: string): number | undefined {
  const m = /(?:esp_sleep_enable_timer_wakeup|esp_deep_sleep)\s*\(\s*([0-9ULul\s*]+)\)/.exec(src);
  if (!m) return undefined;
  const factors = m[1]!.split("*").map((x) => Number(x.trim().replace(/[ULul]+$/, "")));
  if (!factors.length || factors.some((f) => !Number.isFinite(f) || f <= 0)) return undefined;
  return factors.reduce((a, b) => a * b, 1) / 1e6;
}

export interface PowerLoad {
  load: string;
  part?: string;
  active_ma: number;
  idle_ma: number;
  duty: number;
  duty_text: string;
  avg_ma: number;
  share: number;
  source: string;
}

export interface PowerBudget {
  battery?: { part: string; capacity_mah: number; usable_mah: number };
  avg_ma: number;
  peak_ma: number;
  hours?: number;
  /** Round 15: hours / 24, for devices that last weeks. */
  days?: number;
  target_hours?: number;
  /** Round 15: a sleeping board's wake pattern the estimate used. */
  wakes?: { per_day: number; awake_s: number };
  loads: PowerLoad[];
  assumptions: string[];
  suggestions: string[];
  /** One line for people. */
  summary: string;
}

/** Chip figures (mA at 3.3 V, typical) with their source. Generic per chip, not per project. */
const CHIPS: Record<string, { cpu: number; wifiIdle: number; wifiBurst: number; wifiPeak: number; light: number; deep: number; source: string }> = {
  esp32s3: { cpu: 40, wifiIdle: 25, wifiBurst: 150, wifiPeak: 340, light: 0.24, deep: 0.008, source: "Espressif ESP32-S3 datasheet v1.9 §5.6 (CPU at 160-240 MHz with Wi-Fi off 30-70 mA; TX up to 340 mA at 21 dBm; RX ~95 mA; light-sleep 240 µA; deep-sleep 8 µA) and ESP-IDF 'Low power mode in Wi-Fi scenarios' (connected in modem-sleep, DTIM1: about 20-30 mA more)" },
  esp32: { cpu: 40, wifiIdle: 25, wifiBurst: 150, wifiPeak: 380, light: 0.8, deep: 0.01, source: "Espressif ESP32 datasheet v4.x §5.4 (modem-sleep 20-68 mA at 80-240 MHz; TX 802.11b up to 240-380 mA; light-sleep 0.8 mA; deep-sleep 10 µA) and ESP-IDF 'Low power mode in Wi-Fi scenarios'" },
  esp32c3: { cpu: 23, wifiIdle: 20, wifiBurst: 120, wifiPeak: 335, light: 0.13, deep: 0.005, source: "Espressif ESP32-C3 datasheet v1.x §5.5 (modem-sleep ~20-28 mA at 160 MHz; TX up to 335 mA at 21 dBm; light-sleep 130 µA; deep-sleep 5 µA)" },
  rp2040: { cpu: 21, wifiIdle: 0, wifiBurst: 0, wifiPeak: 0, light: 1.3, deep: 0.18, source: "Raspberry Pi RP2040 datasheet §2.15 (about 21 mA running at 125 MHz; SLEEP ~1.3 mA; DORMANT ~0.18 mA)" },
};
const CAMERA_STANDBY_MA = 0.6; // OV2640 datasheet: standby 600 µA (power-down mode)
const AMP_EFFICIENCY = 0.92; // MAX98357A datasheet: 92 % efficiency (8 Ω, 1 W)
const SPEECH_AVG_OF_PEAK = 0.1; // speech averages about a tenth of full-scale power (crest factor ~10 dB)
const USABLE = 0.8; // cells are not run to 0 % (protection cuts off; capacity fades); the planner uses the same
const CELL_V = 3.7;

const NET = /#\s*include\s*[<"](WiFi|HTTPClient|NetworkClientSecure|WiFiClientSecure|PubSubClient|WebSocketsClient|esp_http_client|esp_wifi)\.h[>"]/;

function dutyFraction(d: Duty): number {
  if (d === "always") return 1;
  if (d === "off") return 0;
  return d.every_s > 0 ? Math.min(1, Math.max(0, d.on_s / d.every_s)) : 1;
}

function dutyText(d: Duty): string {
  if (typeof d === "string") return d;
  return `${d.on_s} s every ${d.every_s >= 3600 ? `${+(d.every_s / 3600).toFixed(2)} h` : d.every_s >= 60 ? `${+(d.every_s / 60).toFixed(1)} min` : `${d.every_s} s`}`;
}

/** Validate a duty value (errors say which and the fix). */
export function checkDuty(key: string, d: unknown): string | undefined {
  if (d === "always" || d === "off") return undefined;
  const o = d as { on_s?: unknown; every_s?: unknown };
  if (!o || typeof o !== "object" || typeof o.on_s !== "number" || typeof o.every_s !== "number" || o.on_s < 0 || o.every_s <= 0 || o.on_s > o.every_s) {
    return `power.duty.${key} must be "always", "off" or {"on_s": n, "every_s": m} with 0 <= on_s <= every_s (got ${JSON.stringify(d)}); e.g. {"on_s": 2, "every_s": 600} for 2 s every 10 minutes`;
  }
  return undefined;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The power budget of a project. `profile` overrides faber.json power (estimate_power's what-if). */
export function powerBudget(project: Project, registry: PartRegistry, firmwareSource = "", profile?: PowerProfile, opts: { suggest?: boolean; measured?: MeasuredSleep } = {}): PowerBudget {
  const saved = (project.power ?? {}) as PowerProfile & { usb?: boolean };
  const prof: PowerProfile = { ...saved, ...profile, duty: { ...(saved.duty ?? {}), ...(profile?.duty ?? {}) } };
  const duty = prof.duty ?? {};
  const assumptions: string[] = [];
  const loads: Omit<PowerLoad, "share">[] = [];
  const spec = (t: string): PartSpec | undefined => registry.get(t)?.spec;
  const src = firmwareSource;
  const pick = (keys: string[], fallback: Duty, why: string): Duty => {
    for (const k of keys) if (duty[k] !== undefined) return duty[k]!;
    assumptions.push(why);
    return fallback;
  };

  const boardPart = project.parts.find((p) => p.id === project.firmware?.board) ?? project.parts.find((p) => spec(p.type)?.category === "board");
  const bspec = boardPart ? spec(boardPart.type) : undefined;
  const chipId = bspec?.mcu?.chip?.toLowerCase() ?? "";
  const chip = CHIPS[chipId];
  const sleepMode = prof.sleep ?? (/esp_deep_sleep_start|esp_deep_sleep\(|deepSleep\(/.test(src) ? "deep" : /esp_light_sleep_start/.test(src) ? "light" : "none");
  if (prof.sleep === undefined && sleepMode !== "none") assumptions.push(`the board ${sleepMode}-sleeps between active moments (the firmware calls ${sleepMode === "deep" ? "esp_deep_sleep_start" : "esp_light_sleep_start"}); set power.sleep to change it`);
  // round 15: how often a sleeping board wakes and for how long
  let wakes = prof.wakes_per_day;
  let awakeS = prof.awake_s;
  if (sleepMode !== "none") {
    if (wakes === undefined && opts.measured) {
      wakes = opts.measured.wakes_per_day;
      awakeS ??= opts.measured.awake_s;
      assumptions.push(`${wakes} wakes a day, ${awakeS} s awake each, measured from ${opts.measured.source}; set power.wakes_per_day / awake_s for the real pattern (button presses add wakes)`);
    }
    if (wakes === undefined) {
      const t = sleepTimerSeconds(src);
      wakes = t ? Math.round((86400 / t) * 10) / 10 : 24;
      assumptions.push(t ? `the board wakes on its ${t >= 3600 ? `${+(t / 3600).toFixed(2)} h` : `${t} s`} timer, ${wakes} times a day; set power.wakes_per_day to add the wakes a button or lid gives` : "the board wakes about once an hour (24 a day); set power.wakes_per_day to the real number");
    }
    if (awakeS === undefined) {
      awakeS = 1;
      assumptions.push("each wake takes about 1 s awake (boot, read, draw); set power.awake_s (an e-paper full refresh alone takes 2 s)");
    }
  }

  // Wi-Fi (ESP32 family): connected and idle vs bursts
  const usesNet = NET.test(src) && !!chip?.wifiBurst;
  let wifiDuty: Duty = "off";
  if (usesNet && chip) {
    const periodic = /WiFi\.mode\(\s*WIFI_OFF\s*\)|WiFi\.disconnect\(\s*true|esp_wifi_stop\(/.test(src) || sleepMode !== "none";
    wifiDuty = pick(["wifi"], periodic ? { on_s: 10, every_s: 600 } : "always", periodic ? "Wi-Fi is on about 10 s every 10 min (the firmware turns it off between uploads); set power.duty.wifi to your real pattern" : "Wi-Fi stays connected all the time (the firmware never turns it off); set power.duty.wifi, e.g. {\"on_s\": 10, \"every_s\": 3600}, if it only connects to upload");
    const d = dutyFraction(wifiDuty);
    // connected all the time: modem-sleep idle with bursts on top; periodic: a burst while on
    const always = wifiDuty === "always";
    const active = always ? chip.wifiIdle + 0.05 * (chip.wifiBurst - chip.wifiIdle) : chip.wifiBurst;
    loads.push({ load: "Wi-Fi", part: boardPart?.id, active_ma: round1(active), idle_ma: 0, duty: d, duty_text: dutyText(wifiDuty), avg_ma: active * d, source: always ? `${chip.source}; connected: modem-sleep idle plus 5 % of the time in bursts` : `${chip.source}; while on: connecting and uploading (RX ~95 mA, TX bursts)` });
  }

  // Camera(s): a camera part, or the board's own camera
  const cams = project.parts.filter((p) => spec(p.type)?.camera);
  for (const c of cams) {
    const cs = spec(c.type)!;
    const active = cs.camera?.activeMa ?? 40;
    const periodic = /esp_camera_deinit\(/.test(src) || sleepMode === "deep";
    const d = pick([c.id, "camera"], periodic ? { on_s: 2, every_s: 600 } : "always", periodic ? `the camera is on about 2 s per picture, every 10 min (the firmware powers it down between pictures); set power.duty.camera` : `the camera stays on all the time (the firmware never calls esp_camera_deinit); set power.duty.camera, e.g. {"on_s": 2, "every_s": 600}, if it powers it down between pictures`);
    loads.push({ load: `camera (${cs.camera?.sensor ?? "sensor"})`, part: c.id, active_ma: active, idle_ma: CAMERA_STANDBY_MA, duty: dutyFraction(d), duty_text: dutyText(d), avg_ma: 0, source: `${cs.camera?.note?.includes("datasheet") ? cs.camera.note : `${cs.camera?.sensor ?? "OV2640"} datasheet (125 mW active at UXGA 15 fps, about 40 mA at 3.3 V; 600 µA standby)`}` });
  }

  // Board CPU (the chip table, or the board's own typical current)
  if (boardPart && bspec) {
    const others = loads.map((l) => l.duty);
    const busy = sleepMode === "none" ? 1 : Math.max(0.01, ...others);
    const cpu = chip?.cpu ?? bspec.current_ma?.typ ?? 0;
    // round 15: the board's own sleep current (regulator, charger, LEDs) when its part data has one
    const boardSleep = (bspec.current_ma?.standby_ua ?? 0) / 1000;
    const idle = sleepMode === "deep" ? Math.max(chip?.deep ?? 0.05, boardSleep) : sleepMode === "light" ? Math.max(chip?.light ?? 1, boardSleep) : cpu;
    const byWakes = sleepMode !== "none" && duty.cpu === undefined && wakes !== undefined;
    const d: Duty = sleepMode === "none" ? "always" : (duty.cpu ?? (byWakes ? { on_s: Math.round(wakes! * awakeS! * 1000) / 1000, every_s: 86400 } : { on_s: Math.round(busy * 600), every_s: 600 }));
    const dText = byWakes ? `${wakes} wakes a day x ${awakeS} s awake` : dutyText(d);
    loads.push({ load: `board CPU (${bspec.mcu?.chip ?? bspec.name})`, part: boardPart.id, active_ma: cpu, idle_ma: round3(idle), duty: sleepMode === "none" ? 1 : dutyFraction(d), duty_text: sleepMode === "none" ? "always" : `${dText}, ${sleepMode} sleep otherwise`, avg_ma: 0, source: `${chip?.source ?? `${bspec.name} typical current (part data, current_ma.typ ${bspec.current_ma?.typ ?? "?"} mA)`}${boardSleep > (chip?.deep ?? 0) && sleepMode !== "none" ? `; the board itself draws ${bspec.current_ma!.standby_ua} µA asleep (part data)` : ""}` });
  }

  // Everything else with a current figure: screens, amplifiers, LEDs, sensors
  const skip = new Set(["lipo-battery", "battery-pack", "tp4056-charger", "charge-boost-5v", "boost-converter", "schottky-diode", "generic-diode", "slide-switch", "resistor", "capacitor", "speaker-20mm", "speaker-28mm", "speaker"]);
  const lipo = project.parts.find((p) => p.type === "lipo-battery");
  const vbat = CELL_V;
  for (const p of project.parts) {
    if (p === boardPart || cams.includes(p) || skip.has(p.type)) continue;
    const s = spec(p.type);
    if (!s || s.category === "board") continue;
    // round 17: a module whose power LED is off (prop powerLed false, the LED desoldered) draws without it
    const ledmA = typeof s.limits?.powerLedmA === "number" ? s.limits.powerLedmA : 0;
    const ledOff = ledmA > 0 && p.props?.powerLed === false;
    const typ = Math.max(0, (s.current_ma?.typ ?? 0) - (ledOff ? ledmA : 0));
    const isAmp = (s.tags ?? []).some((t) => /i2s|amplifier/.test(t)) || /amp|max98357/i.test(p.type);
    const isDisplay = s.category === "display" || /tft|oled|lcd|display/i.test(p.type);
    if (isAmp) {
      const spk = project.parts.find((x) => /speaker/.test(x.type));
      const ohms = Number(spk?.props?.ohms ?? spec(spk?.type ?? "")?.props?.find((x) => x.id === "ohms")?.default ?? 8);
      const rated = Number(spk?.props?.rated_w ?? spec(spk?.type ?? "")?.limits?.maxPowerW ?? 0.5);
      const peakW = Math.min((vbat * vbat) / (2 * ohms), rated);
      const playing = typ + ((peakW * SPEECH_AVG_OF_PEAK) / AMP_EFFICIENCY / vbat) * 1000;
      const d = pick([p.id, "audio", "speaker"], { on_s: 5, every_s: 600 }, `${p.id} plays about 5 s every 10 min; set power.duty.audio to how often the device speaks`);
      loads.push({ load: `audio amplifier (${s.name})`, part: p.id, active_ma: round1(playing), idle_ma: typ, duty: dutyFraction(d), duty_text: dutyText(d), avg_ma: 0, source: `${s.name} datasheet (2.4 mA quiescent, 92 % efficient); speech at about a tenth of full-scale power into ${ohms} Ω (${round1(peakW * 1000)} mW peak at ${vbat} V)` });
      continue;
    }
    // round 15: a part that draws typ only while it does one thing (an e-paper refresh), microamps otherwise
    const ev = s.current_ma?.event_ms;
    if (ev && typ) {
      const given = duty[p.id] ?? (isDisplay ? duty.display : undefined);
      const standby = (s.current_ma?.standby_ua ?? 0) / 1000;
      let frac: number;
      let text: string;
      if (given !== undefined) {
        frac = dutyFraction(given);
        text = dutyText(given);
      } else {
        const perDay = wakes ?? 96;
        if (wakes === undefined) assumptions.push(`${p.id} does its ${s.current_ma?.event ?? "update"} about every 15 min (96 a day); set power.duty.${p.id} or power.wakes_per_day`);
        frac = Math.min(1, (perDay * ev) / 86_400_000);
        text = `${perDay} ${s.current_ma?.event ?? "updates"} a day x ${ev} ms`;
      }
      loads.push({ load: isDisplay ? `screen (${s.name})` : s.name, part: p.id, active_ma: typ, idle_ma: round3(standby), duty: frac, duty_text: text, avg_ma: 0, source: `${s.name} part data (${typ} mA for ${ev} ms per ${s.current_ma?.event ?? "event"}, ${s.current_ma?.standby_ua ?? 0} µA otherwise)` });
      continue;
    }
    if (!typ) continue;
    const d = pick([p.id, ...(isDisplay ? ["display"] : [])], "always", `${p.id} (${s.name}) is on all the time${isDisplay ? " (screen and backlight)" : ""}; set power.duty.${isDisplay ? "display" : p.id} if the firmware turns it off`);
    loads.push({ load: isDisplay ? `screen (${s.name})` : s.name, part: p.id, active_ma: typ, idle_ma: 0, duty: dutyFraction(d), duty_text: dutyText(d), avg_ma: 0, source: `${s.name} part data (current_ma.typ ${s.current_ma?.typ ?? 0} mA${ledOff ? `, minus its ${ledmA} mA power LED: powerLed is false` : ledmA ? `, of which ${ledmA} mA is its power LED` : ""})` });
  }

  for (const l of loads) if (!l.avg_ma) l.avg_ma = l.active_ma * l.duty + l.idle_ma * (1 - l.duty);
  const avg = loads.reduce((a, l) => a + l.avg_ma, 0);
  const peak = loads.reduce((a, l) => a + l.active_ma, 0) + (usesNet && chip ? chip.wifiPeak - (loads.find((l) => l.load === "Wi-Fi")?.active_ma ?? 0) : 0);
  const out: PowerLoad[] = loads.map((l) => ({ ...l, avg_ma: round3(l.avg_ma), duty: round3(l.duty), share: avg > 0 ? Math.round((l.avg_ma / avg) * 100) : 0 })).sort((a, b) => b.avg_ma - a.avg_ma);

  const cap = lipo ? Number(lipo.props?.capacity ?? spec("lipo-battery")?.props?.find((x) => x.id === "capacity")?.default ?? 500) : undefined;
  const hours = cap !== undefined && avg > 0 ? round1((cap * USABLE) / avg) : undefined;
  const days = hours !== undefined ? round1(hours / 24) : undefined;
  const target = prof.target_hours;
  const suggestions: string[] = [];
  if (cap !== undefined && target !== undefined && hours !== undefined && hours < target) {
    const need = Math.ceil((target * avg) / USABLE);
    const cell = LIPO_CELLS.find((c) => c.mAh >= need);
    suggestions.push(cell ? `a ${cell.mAh} mAh cell (${cell.code}, ${cell.w} x ${cell.h} x ${cell.d} mm) lasts about ${round1((cell.mAh * USABLE) / avg)} h: set_part_property ${lipo!.id} capacity ${cell.mAh}` : `about ${need} mAh would last ${target} h, more than the biggest pouch cell Faber knows (1000 mAh, 523450): cut the average current instead`);
  }
  // round 17: a module's power LED that burns most of the budget (the ZS-042 DS3231's is 15x the clock)
  for (const l of opts.suggest === false || cap === undefined ? [] : out.slice(0, 3)) {
    const part = project.parts.find((x) => x.id === l.part);
    const ps = part ? spec(part.type) : undefined;
    const led = typeof ps?.limits?.powerLedmA === "number" ? ps.limits.powerLedmA : 0;
    if (!part || !led || part.props?.powerLed === false || l.share < 15) continue;
    const alt = powerBudget({ ...project, parts: project.parts.map((x) => (x === part ? { ...x, props: { ...x.props, powerLed: false } } : x)) }, registry, firmwareSource, prof, { suggest: false });
    const smaller = (registry.list?.() ?? []).filter((d) => d.spec.id !== ps!.id && (d.spec.tags ?? []).some((t) => (ps!.tags ?? []).includes(t) && /^(rtc|real time clock)$/.test(t)) && (d.spec.current_ma?.typ ?? Infinity) < ((ps!.current_ma?.typ ?? 0) - led) * 2).map((d) => d.spec.id);
    if (alt.hours !== undefined && hours !== undefined) suggestions.push(`${l.load} draws ${l.share} % of the average, ${led} mA of it its power LED: desolder the LED (or cut its jumper), then set_part_property ${part.id} powerLed false → about ${alt.hours} h on the same cell${smaller.length ? `; or use a module without one (${smaller.join(", ")})` : ""}`);
  }
  // what would help most: the biggest load that is on all the time and could be duty-cycled
  for (const l of opts.suggest === false ? [] : out.slice(0, 3)) {
    if (l.duty < 1 || l.share < 15) continue;
    const role = l.load.startsWith("camera") ? "camera" : l.load === "Wi-Fi" ? "wifi" : l.load.startsWith("screen") ? "display" : l.load.startsWith("board CPU") ? "sleep" : undefined;
    if (!role || cap === undefined) continue;
    const alt = role === "sleep" ? powerBudget(project, registry, firmwareSource, { ...prof, sleep: "light" }, { suggest: false }) : powerBudget(project, registry, firmwareSource, { ...prof, duty: { ...duty, [role]: role === "wifi" ? { on_s: 10, every_s: 3600 } : role === "camera" ? { on_s: 2, every_s: 600 } : { on_s: 30, every_s: 300 } } }, { suggest: false });
    const how = role === "camera" ? "power the camera down between pictures (esp_camera_deinit and the PWDN pin, or a sensor standby) and wake it 2 s before each one" : role === "wifi" ? "connect to Wi-Fi only to upload (queue offline, send every hour), then WiFi.mode(WIFI_OFF)" : role === "display" ? "turn the screen and its backlight off when nobody looks (30 s every 5 min on)" : "light-sleep between events (esp_light_sleep_start with a timer / button wake-up)";
    if (alt.hours !== undefined && hours !== undefined && alt.hours > hours * 1.15) suggestions.push(`${l.load} draws ${l.share} % of the average: ${how} → about ${alt.hours} h on the same cell`);
  }
  const summary =
    cap === undefined
      ? `About ${round1(avg)} mA on average (peaks ~${Math.round(peak)} mA); no LiPo cell in the project, so no battery life.`
      : `About ${hours! >= 72 ? `${round1(hours! / 24)} days (${hours} h)` : `${hours} h`} on ${cap} mAh (${avg < 1 ? `${round3(avg) * 1000} µA` : `${round1(avg)} mA`} average, peaks ~${Math.round(peak)} mA)${target !== undefined ? `; target ${target} h: ${hours! >= target ? "met" : "NOT met"}` : ""}. Estimate from datasheet typicals and duty cycles, not measured.`;
  return {
    ...(lipo && cap !== undefined ? { battery: { part: lipo.id, capacity_mah: cap, usable_mah: Math.round(cap * USABLE) } } : {}),
    avg_ma: round1(avg),
    peak_ma: Math.round(peak),
    ...(hours !== undefined ? { hours, days } : {}),
    ...(target !== undefined ? { target_hours: target } : {}),
    ...(wakes !== undefined && awakeS !== undefined ? { wakes: { per_day: wakes, awake_s: awakeS } } : {}),
    loads: out,
    assumptions,
    suggestions,
    summary,
  };
}

/** check_design: battery life against power.target_hours (only when the project states a target). */
export function powerChecks(project: Project, registry: PartRegistry, firmwareSource = ""): { severity: "warning" | "info"; code: string; message: string; parts: string[] }[] {
  const target = (project.power as PowerProfile | undefined)?.target_hours;
  if (target === undefined || !project.parts.some((p) => p.type === "lipo-battery")) return [];
  const b = powerBudget(project, registry, firmwareSource);
  if (b.hours === undefined) return [];
  const top = b.loads.slice(0, 3).map((l) => `${l.load} ${l.avg_ma} mA avg (${l.share} %, ${l.duty_text})`).join("; ");
  const guessed = b.assumptions.length ? ` Assumed: ${b.assumptions.join("; ")}.` : "";
  if (b.hours < target) {
    return [{ severity: "warning", code: "battery-life", message: `About ${b.hours} h on ${b.battery!.capacity_mah} mAh, short of the ${target} h target (power.target_hours): ${b.avg_ma} mA on average; biggest loads: ${top}.${guessed} Fix: ${b.suggestions.join("; or ") || "a bigger cell, or less time with the biggest loads on"}. estimate_power shows the whole budget and tries other duty cycles. (Datasheet typicals, not measured.)`, parts: [b.battery!.part] }];
  }
  return [{ severity: "info", code: "battery-life", message: `About ${b.hours} h on ${b.battery!.capacity_mah} mAh, which meets the ${target} h target: ${b.avg_ma} mA on average; biggest loads: ${top}.${guessed} (Datasheet typicals, not measured.)`, parts: [b.battery!.part] }];
}
