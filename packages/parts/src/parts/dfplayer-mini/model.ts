// DFPlayer Mini MP3 module (round 7, voice), emulated at the protocol level: the board sends it
// 10-byte frames at 9600 baud (see ../../lib/dfplayer.ts), it plays a clip from its microSD card
// and answers like the real module (0x3F online, 0x41 ACK when asked, 0x3D track finished,
// query replies). BUSY is LOW while a clip plays.
//
// The clips are TEXT: the "clips" prop maps track numbers to words. Playing a track logs an
// utterance (words, start, estimated length from the word count), shows the words while it plays
// (`saying`) and drives SPK_1 / SPK_2 (and the DAC pins) with an RMS level, so a speaker wired
// there sounds and the part knows a person would hear it (`audible`). Deterministic: virtual time.
import type { Diagnostic, PartModel, PartModelFactory, Utterance } from "@jumper/sim-core";
import { UartReceiver, UartTransmitter } from "../../lib/softUart.ts";
import { DF, DF_COMMAND_NAMES, DfFrameDecoder, clipKey, dfFrame, estimateClipMs, hex, parseClips } from "../../lib/dfplayer.ts";
import { clamp, round, truthy } from "../../lib/props.ts";

/** Typical figures for a DFPlayer Mini (YX5200 / MH2024K) with a class-D 8002 amplifier. */
export const DFPLAYER_TIMING = {
  /** Power-up (or reset) to the 0x3F "online" frame: card scan. */
  bootMs: 1000,
  /** Reply delay after a command / query. */
  replyMs: 20,
  /** Length shown for a clip with no words (a short beep-length placeholder). */
  noWordsMs: 1200,
};
const BAUD = 9600;
const VMIN = 3.0;
const VQUIET = 3.2;
const VMAX = 5.5;
const IDLE_MA = 20;
/** RMS volts across SPK_1-SPK_2 at volume 30 on 5 V (≈ 0.5 W into 8 Ω). */
const SPK_RMS_MAX = 2.0;
/** DAC (line out) RMS at volume 30. */
const DAC_RMS_MAX = 0.7;
const SPK_R_OUT = 0.5;
const DAC_R_OUT = 1000;
const MAX_LOG = 500;

export const create: PartModelFactory = (ctx): PartModel => {
  let clipsText = String(ctx.props.clips ?? "");
  let clips = parseClips(clipsText).clips;
  let card = ctx.props.sd_card === undefined ? true : truthy(ctx.props.sd_card);
  let vcc = 0;
  let powered = false;
  let online = false;
  let volume = 30;
  let playing = false;
  let paused = false;
  let track = 0;
  let current: Utterance | undefined;
  let endAt = -1;
  let remainingMs = 0;
  let audible = false;
  let spkAmps = 0;
  let dacAmps = 0;
  let els: { spk: string; dacr: string; dacl: string } | undefined;
  let rxBytes = 0;
  let frames = 0;
  let badFrames = 0;
  let lastBad = "";
  let lastCommand = "";
  let earlyCommands = 0;
  let firstEarlyAt = -1;
  const said: Utterance[] = [];
  const missing = new Set<string>();
  const silentPlays: number[] = [];
  const timers = new Set<() => void>();
  let endTimer: (() => void) | undefined;
  const decoder = new DfFrameDecoder();

  const tx = new UartTransmitter(ctx, () => BAUD, () => ctx.requestSolve());
  const rx = new UartReceiver(ctx, "RX", () => BAUD, (b) => onByte(b));

  const at = (ms: number, fn: () => void): (() => void) => {
    if (!ctx.schedule) return () => {};
    let cancel: () => void = () => {};
    cancel = ctx.schedule(ms, () => {
      timers.delete(cancel);
      fn();
    });
    timers.add(cancel);
    return cancel;
  };
  const reply = (cmd: number, param = 0, delay = DFPLAYER_TIMING.replyMs) =>
    at(delay, () => tx.send(String.fromCharCode(...dfFrame(cmd, param))));

  const stopPlayback = () => {
    endTimer?.();
    endTimer = undefined;
    if (current && playing) current.dur_ms = Math.max(0, Math.round(ctx.now() - current.t_ms));
    playing = false;
    paused = false;
    endAt = -1;
    current = undefined;
  };

  const shutDown = () => {
    for (const c of timers) c();
    timers.clear();
    stopPlayback();
    tx.clear();
    decoder.reset();
    online = false;
  };

  const boot = () => {
    shutDown();
    volume = 30;
    track = 0;
    at(DFPLAYER_TIMING.bootMs, () => {
      online = true;
      // Param 0x0002: a microSD (TF) card is online. Without a card the module reports nothing usable.
      if (card) tx.send(String.fromCharCode(...dfFrame(DF.ONLINE, 0x0002)));
      else tx.send(String.fromCharCode(...dfFrame(DF.ERROR, 0x0001)));
    });
  };

  /** Track numbers that have words, in order (next / previous walk them). */
  const tracks = () =>
    [...clips.keys()]
      .filter((k) => !k.includes("/"))
      .map(Number)
      .sort((a, b) => a - b);

  const finish = () => {
    if (!current) return;
    const done = current.track;
    playing = false;
    paused = false;
    current = undefined;
    endAt = -1;
    ctx.requestSolve();
    tx.send(String.fromCharCode(...dfFrame(DF.TRACK_DONE, done)));
  };

  const play = (n: number, folder?: number) => {
    if (!card) return;
    stopPlayback();
    const key = clipKey(n, folder);
    const words = clips.get(key)?.trim() ?? "";
    const isMissing = words === "";
    if (isMissing) missing.add(key);
    const text = isMissing ? `(track ${folder === undefined ? n : `${folder}/${n}`}: no words set)` : words;
    const dur = isMissing ? DFPLAYER_TIMING.noWordsMs : estimateClipMs(words);
    track = n;
    playing = true;
    paused = false;
    audible = false;
    const u: Utterance = { t_ms: round(ctx.now(), 3), dur_ms: dur, track: n, clip: key, text, ...(isMissing ? { missing: true } : {}), audible: false, volume };
    current = u;
    said.push(u);
    if (said.length > MAX_LOG) said.shift();
    endAt = ctx.now() + dur;
    endTimer = at(dur, finish);
    ctx.requestSolve();
    // A speaker on the outputs draws current now; if not, the person would hear nothing.
    if (!u.audible && volume > 0) silentPlays.push(u.t_ms);
  };

  const command = (cmd: number, param: number, feedback: boolean) => {
    frames++;
    lastCommand = `${DF_COMMAND_NAMES[cmd] ?? `0x${hex(cmd)}`}${param ? ` ${param}` : ""}`;
    if (!online) {
      earlyCommands++;
      if (firstEarlyAt < 0) firstEarlyAt = round(ctx.now(), 1);
      return; // still scanning the card: the real module ignores commands
    }
    if (feedback) reply(DF.ACK, 0, 2);
    switch (cmd) {
      case DF.PLAY_TRACK:
      case DF.PLAY_MP3:
        return play(param);
      case DF.PLAY_FOLDER:
        return play(param & 0xff, (param >> 8) & 0xff);
      case DF.NEXT: {
        const t = tracks();
        return play(t.find((x) => x > track) ?? t[0] ?? track + 1);
      }
      case DF.PREV: {
        const t = tracks();
        return play([...t].reverse().find((x) => x < track) ?? t[t.length - 1] ?? Math.max(1, track - 1));
      }
      case DF.VOLUME:
        volume = clamp(param, 0, 30);
        ctx.requestSolve();
        return;
      case DF.VOL_UP:
        volume = Math.min(30, volume + 1);
        ctx.requestSolve();
        return;
      case DF.VOL_DOWN:
        volume = Math.max(0, volume - 1);
        ctx.requestSolve();
        return;
      case DF.PAUSE:
        if (playing && !paused && current) {
          remainingMs = Math.max(0, endAt - ctx.now());
          endTimer?.();
          endTimer = undefined;
          paused = true;
          ctx.requestSolve();
        }
        return;
      case DF.RESUME:
        if (paused && current) {
          paused = false;
          endAt = ctx.now() + remainingMs;
          endTimer = at(remainingMs, finish);
          ctx.requestSolve();
        } else if (!playing && track > 0) play(track);
        return;
      case DF.STOP:
      case DF.SLEEP:
        stopPlayback();
        ctx.requestSolve();
        return;
      case DF.RESET:
        boot();
        ctx.requestSolve();
        return;
      case DF.Q_STATUS:
        return reply(DF.Q_STATUS, 0x0200 | (playing ? (paused ? 2 : 1) : 0));
      case DF.Q_VOLUME:
        return reply(DF.Q_VOLUME, volume);
      case DF.Q_FILES:
        return reply(DF.Q_FILES, [...clips.keys()].length);
      case DF.Q_TRACK:
        return reply(DF.Q_TRACK, track);
      default:
        return; // EQ, source, loop, advert…: accepted, nothing to simulate
    }
  };

  const onByte = (b: number) => {
    if (!powered) return;
    rxBytes++;
    const r = decoder.push(b);
    if (!r) return;
    if (!r.ok) {
      badFrames++;
      lastBad = r.error;
      return;
    }
    command(r.frame.cmd, r.frame.param, r.frame.feedback);
  };

  const level = (max: number) => (playing && !paused ? max * (volume / 30) * Math.min(1, vcc / 5) : 0);

  return {
    stamp(c) {
      const v = ctx.node("VCC");
      if (powered) {
        // Idle draw plus what the amplifier delivers (≈ 80 % efficient).
        const audioW = spkAmps * spkAmps * 8;
        const mA = IDLE_MA + (vcc > 0 ? (audioW / 0.8 / vcc) * 1000 : 0);
        c.resistor(v, ctx.node("GND.1"), Math.max(10, vcc / (mA / 1000)), { id: "load" });
        const io = Math.min(vcc, 3.3);
        c.voltageSource(ctx.node("TX"), "0", tx.level ? io : 0, 100, { id: "tx" });
        c.voltageSource(ctx.node("BUSY"), "0", playing && !paused ? 0 : io, 1000, { id: "busy" });
        els = {
          spk: c.voltageSource(ctx.node("SPK_1"), ctx.node("SPK_2"), level(SPK_RMS_MAX), SPK_R_OUT, { id: "spk" }),
          dacr: c.voltageSource(ctx.node("DAC_R"), "0", level(DAC_RMS_MAX), DAC_R_OUT, { id: "dacr" }),
          dacl: c.voltageSource(ctx.node("DAC_L"), "0", level(DAC_RMS_MAX), DAC_R_OUT, { id: "dacl" }),
        };
      } else {
        els = undefined;
      }
    },
    onSolved(r) {
      vcc = r.voltage(ctx.node("VCC")) - r.voltage(ctx.node("GND.1"));
      const nowPowered = vcc >= VMIN && vcc <= VMAX + 1;
      if (nowPowered && !powered) {
        powered = true;
        boot();
        return;
      }
      if (!nowPowered && powered) {
        powered = false;
        shutDown();
        return;
      }
      if (!powered) return;
      if (!els) return;
      spkAmps = Math.abs(r.current(els.spk));
      dacAmps = Math.max(Math.abs(r.current(els.dacr)), Math.abs(r.current(els.dacl)));
      if (playing && !paused && level(1) > 0) {
        const heard = spkAmps > 0.001 || dacAmps > 0.00005;
        if (heard && current && !current.audible) {
          current.audible = true;
          const i = silentPlays.indexOf(current.t_ms);
          if (i >= 0) silentPlays.splice(i, 1);
        }
        audible = heard;
      }
    },
    visualState() {
      const speaking = playing && !paused && audible && volume > 0;
      const last = said[said.length - 1];
      return {
        powered,
        online,
        playing: playing && !paused,
        paused,
        track,
        volume,
        saying: playing && current ? current.text : "",
        speaking,
        audible: playing ? audible : false,
        lastSaid: last ? last.text : "",
        saidCount: said.length,
        clipsSet: [...clips.values()].filter((t) => t.trim()).length,
        busy: playing && !paused,
        lastCommand,
        frames,
        badFrames,
        rxBytes,
        txBytes: tx.bytes,
        framingErrors: rx.framingErrors,
        spkmA: round(spkAmps * 1000, 1),
        playOpacity: speaking ? 1 : playing && !paused ? 0.45 : 0,
        powerOpacity: powered ? 1 : 0,
        label: !powered ? "off" : !online ? "starting" : playing && !paused ? `▶ ${String(track).padStart(4, "0")}` : paused ? `❚❚ ${String(track).padStart(4, "0")}` : "ready",
      };
    },
    setProp(id, value) {
      if (id === "clips") {
        clipsText = String(value ?? "");
        clips = parseClips(clipsText).clips;
      }
      if (id === "sd_card") card = truthy(value);
    },
    interact(e) {
      // A person can play a clip by hand from the inspector: set track = N.
      if (e.kind === "set" && (e.key === "track" || e.key === undefined) && powered && online) {
        const n = Number(e.value);
        if (Number.isInteger(n) && n > 0 && n < 3000) play(n);
      }
    },
    diagnostics(): Diagnostic[] {
      const out: Diagnostic[] = [];
      if (vcc > VMAX + 0.3) out.push({ severity: "error", code: "dfplayer-overvoltage", pin: "VCC", message: `DFPlayer VCC is ${vcc.toFixed(1)} V. Why: the module is rated 3.2 to 5 V and more burns its amplifier. Fix: feed VCC from the board's 5V / VBUS or a 1S LiPo, never a 7.4 V pack.` });
      else if (vcc > 0.3 && vcc < VMIN) out.push({ severity: "warning", code: "dfplayer-undervoltage", pin: "VCC", message: `DFPlayer VCC is only ${vcc.toFixed(2)} V, so it stays off. Why: it needs 3.2 to 5 V. Fix: wire VCC to the board's 5V / VBUS (or the battery after its switch).` });
      else if (powered && vcc < VQUIET) out.push({ severity: "info", code: "dfplayer-low-supply", pin: "VCC", message: `DFPlayer runs on ${vcc.toFixed(2)} V: it works but plays quieter and may reset on loud clips. Why: the amplifier's output swing follows VCC. Fix: feed it 5 V (VBUS) for full volume.` });
      if (badFrames > 0) out.push({ severity: "warning", code: "dfplayer-bad-frame", pin: "RX", message: `DFPlayer ignored ${badFrames} malformed frame${badFrames > 1 ? "s" : ""} (last: ${lastBad}). Why: a frame is 7E FF 06 CMD FB PH PL CHK_H CHK_L EF with CHK = 0 - (FF + 06 + CMD + FB + PH + PL) as 16 bits, and the module drops anything else. Fix: build the 10 bytes with that checksum (get_part dfplayer-mini shows a helper), at 9600 baud.` });
      if (powered && rx.framingErrors > 4 && frames === 0) out.push({ severity: "warning", code: "dfplayer-baud", pin: "RX", message: `DFPlayer receives garbage (${rx.framingErrors} framing errors, no valid frame). Why: the module only talks at 9600 baud 8N1. Fix: begin(9600) on the serial port wired to its RX.` });
      if (earlyCommands > 0) out.push({ severity: "warning", code: "dfplayer-not-ready", pin: "RX", message: `DFPlayer ignored ${earlyCommands} command${earlyCommands > 1 ? "s" : ""} sent before it finished starting (first at ${firstEarlyAt} ms). Why: after power-up or a reset it scans the card for about ${DFPLAYER_TIMING.bootMs} ms and drops commands meanwhile. Fix: delay(1500) after power-up / reset, or wait for its 0x3F "online" reply.` });
      if (missing.size) {
        const list = [...missing].slice(0, 6);
        out.push({ severity: "warning", code: "dfplayer-no-words", message: `DFPlayer played ${list.map((k) => `track ${k}`).join(", ")} but has no words for ${missing.size > 1 ? "them" : "it"}. Why: what it says comes from its "clips" table (track: words), and ${missing.size > 1 ? "these are" : "this one is"} missing, so the speech bubble says "no words set" and the SD card would have no file. Fix: set_part_property ${ctx.id} clips "${list.map((k) => `${k}: …`).join("\\n")}" (one "N: words" line per track).` });
      }
      if (powered && silentPlays.length > 0) out.push({ severity: "warning", code: "dfplayer-silent", pin: "SPK_1", message: `DFPlayer played ${silentPlays.length} clip${silentPlays.length > 1 ? "s" : ""} that nobody could hear. Why: nothing is wired to SPK_1 / SPK_2 (or DAC_L / DAC_R), so no current flows. Fix: wire a speaker: speaker + to ${ctx.id}.SPK_1 and speaker - to ${ctx.id}.SPK_2.` });
      if (!card) out.push({ severity: "info", code: "dfplayer-no-card", message: `DFPlayer has no microSD card (sd_card = false), so it plays nothing. Fix: set_part_property ${ctx.id} sd_card true; export_manufacturing writes the card's files to sd-card/.` });
      if (powered && ctx.node("RX") === `${ctx.id}:RX`) out.push({ severity: "info", code: "dfplayer-rx-unwired", pin: "RX", message: `DFPlayer RX is not wired, so it never hears a command. Fix: wire the board's serial TX pin to ${ctx.id}.RX through a 1 kΩ resistor (Uno/Nano: the SoftwareSerial TX pin, e.g. D11; XIAO RP2040: D6 = Serial1 TX).` });
      return out;
    },
    speech() {
      return said;
    },
    dispose() {
      for (const c of timers) c();
      timers.clear();
      rx.dispose();
    },
  };
};
