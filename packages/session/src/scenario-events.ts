// Round 14: what happened when, for scenario checks that relate two events ("it said 'picture in 10
// seconds' 9 to 11 s before the camera took the picture"). Generic: utterances (a talking part's
// clips, or text the device sent to a speech API), serial text, camera pictures and requests, each
// with its virtual time.
import type { NetEvent, NetView } from "@jumper/device-net";
import type { SimHost } from "./sim.ts";

export interface Spoken {
  /** The part that talked, or "api:<host>" for text sent to a speech API. */
  partId: string;
  text: string;
  t_ms: number;
  dur_ms: number;
  audible: boolean;
  /** "clip" (a DFPlayer clip's words) or "speech-api" (the text of a text-to-speech request). */
  via: "clip" | "speech-api";
}

/** A request path that asks for speech (OpenAI /audio/speech, Google text:synthesize, ElevenLabs /text-to-speech, any /tts). */
const SPEECH_PATH = /(speech|tts|synthes|speak|\/say\b|voice)/i;
/** Fields that carry the words in common speech APIs. */
const SPEECH_FIELDS = ["input", "text", "input.text", "ssml", "input.ssml", "message"];

/** Words in a speech-API request body, or undefined. */
export function speechTextOf(e: NetEvent): string | undefined {
  if (e.kind !== "http" || !SPEECH_PATH.test(e.path ?? "")) return undefined;
  const f = e.body?.fields ?? {};
  for (const k of SPEECH_FIELDS) {
    const v = f[k];
    if (typeof v === "string" && v.trim()) return v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return undefined;
}

/** Everything said so far, in time order: clips and speech-API text (the network log since `sinceSeq`). */
export function spokenSoFar(host: SimHost, net?: { view: NetView; drain(): void }, sinceSeq = 0): Spoken[] {
  const out: Spoken[] = host.sim.speech().map((u) => ({ partId: u.partId, text: u.text, t_ms: u.t_ms, dur_ms: u.dur_ms, audible: u.audible !== false, via: "clip" as const }));
  if (net) {
    net.drain();
    for (const e of net.view.log.since(sinceSeq)) {
      const text = speechTextOf(e);
      if (text !== undefined) out.push({ partId: `api:${e.host}`, text, t_ms: e.t_ms, dur_ms: Math.max(500, text.length * 65), audible: true, via: "speech-api" });
    }
  }
  return out.sort((a, b) => a.t_ms - b.t_ms);
}

export type TextMatch = string | { contains?: string; regex?: string };

export function textMatcher(m: TextMatch, ci = true): { test: (s: string) => boolean; label: string } {
  if (typeof m === "object" && m.regex !== undefined) {
    const re = new RegExp(m.regex, ci ? "i" : "");
    return { test: (s) => re.test(s), label: `/${m.regex}/${ci ? "i" : ""}` };
  }
  const needle = typeof m === "string" ? m : (m.contains ?? "");
  return { test: (s) => (ci ? s.toLowerCase().includes(needle.toLowerCase()) : s.includes(needle)), label: JSON.stringify(needle) };
}

export interface PrecededBy {
  said?: TextMatch;
  serial?: TextMatch;
  capture?: string | true;
  request?: { host: string; path?: string; method?: string };
  min_ms?: number;
  max_ms?: number;
}

export interface EventContext {
  host: SimHost;
  net?: { view: NetView; drain(): void };
  netStartSeq: number;
}

/** The times (virtual ms) of the events a preceded_by names, oldest first, with a label for messages. */
export function eventTimes(p: PrecededBy, c: EventContext): { times: number[]; label: string; seen: string } {
  if (p.said !== undefined) {
    const m = textMatcher(p.said);
    const all = spokenSoFar(c.host, c.net, c.netStartSeq);
    const hits = all.filter((u) => u.audible && m.test(u.text));
    return { times: hits.map((u) => u.t_ms), label: `said ${m.label}`, seen: all.length ? all.slice(-4).map((u) => `${JSON.stringify(u.text)} at ${Math.round(u.t_ms)} ms`).join(", ") : "nothing was said" };
  }
  if (p.serial !== undefined) {
    const text = c.host.sim.serialText();
    const times: number[] = [];
    if (typeof p.serial === "object" && p.serial.regex !== undefined) {
      const re = new RegExp(p.serial.regex, "g");
      for (const mm of text.matchAll(re)) times.push(c.host.sim.serialTimeAt(mm.index ?? 0));
    } else {
      const needle = typeof p.serial === "string" ? p.serial : (p.serial.contains ?? "");
      for (let i = text.indexOf(needle); needle && i >= 0; i = text.indexOf(needle, i + 1)) times.push(c.host.sim.serialTimeAt(i));
    }
    return { times, label: `serial ${textMatcher(p.serial, false).label}`, seen: `serial tail ${JSON.stringify(text.slice(-120))}` };
  }
  if (p.capture !== undefined) {
    const caps = c.host.captures(p.capture === true ? undefined : p.capture);
    return { times: caps.map((x) => x.t_ms), label: `a picture${p.capture === true ? "" : ` from ${p.capture}`}`, seen: `${caps.length} picture(s) so far` };
  }
  const r = p.request!;
  c.net?.drain();
  const entries = (c.net?.view.log.since(c.netStartSeq) ?? []).filter((e) => (e.kind === "http" || e.kind === "ws") && e.host === r.host.toLowerCase() && (!r.path || (e.path ?? "").split("?")[0] === r.path || (r.path.endsWith("*") && (e.path ?? "").startsWith(r.path.slice(0, -1)))) && (!r.method || e.method === r.method.toUpperCase()));
  return { times: entries.map((e) => e.t_ms), label: `a ${r.method ?? ""} ${r.host}${r.path ?? ""} request`.replace("  ", " "), seen: `${entries.length} such request(s) so far` };
}

/**
 * Did the event a preceded_by names happen min_ms..max_ms before `t`? The last such event at or
 * before t decides. Returns undefined when it did, else why not (with what was seen).
 */
export function precededWhy(p: PrecededBy, t: number, c: EventContext, what: string): string | undefined {
  const { times, label, seen } = eventTimes(p, c);
  const before = times.filter((x) => x <= t + 1e-6);
  const min = p.min_ms ?? 0;
  const max = p.max_ms ?? Infinity;
  const range = `${min}${Number.isFinite(max) ? `..${max}` : "+"} ms before`;
  if (!before.length) return `${what} at ${Math.round(t)} ms was not preceded by ${label} (wanted ${range}); ${seen}`;
  // the closest earlier event that fits the window wins; otherwise report the last one
  const fits = before.filter((x) => t - x >= min && t - x <= max);
  if (fits.length) return undefined;
  const last = before[before.length - 1]!;
  return `${what} at ${Math.round(t)} ms came ${Math.round(t - last)} ms after ${label} (at ${Math.round(last)} ms), wanted ${range}`;
}
