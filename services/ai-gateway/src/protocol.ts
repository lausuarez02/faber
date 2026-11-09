// The pet protocol: what a 2 KB-RAM board sends and gets back. Designed so a sketch can build the
// request with a few Serial.print calls and parse the reply with strchr():
//
//   GET /v1/pet?a=talk&f=40&j=70&e=80&n=Pip HTTP/1.0\r\nHost: ai.jumper\r\n\r\n
//   HTTP/1.0 200 OK\r\nContent-Length: 28\r\nConnection: close\r\n\r\nhappy|Yum! That hit the spot
//
// Query: a = action (talk | feed | play | sleep | lonely | hello), f = food, j = joy, e = energy
// (0..100), n = the pet's name (optional, max 10 chars), s = a seed the board may pass (optional).
// Reply body: <mood>|<text>, mood in MOODS, text <= 60 printable ASCII characters, no '|'.

export const MOODS = ["happy", "hungry", "sleepy", "sad", "excited"] as const;
export type Mood = (typeof MOODS)[number];
export const ACTIONS = ["talk", "feed", "play", "sleep", "lonely", "hello"] as const;
export type PetAction = (typeof ACTIONS)[number];
export const MAX_TEXT = 60;

export interface PetRequest {
  action: PetAction;
  food: number;
  joy: number;
  energy: number;
  name: string;
  seed: number;
}

export interface PetReply {
  mood: Mood;
  text: string;
}

export class PetRequestError extends Error {
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

const clampStat = (v: string | null, key: string): number => {
  if (v === null || v === "") return 50;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new PetRequestError(`query '${key}=${v}' is not a number`, `send ${key} as a whole number 0..100, e.g. ${key}=40`);
  return Math.max(0, Math.min(100, Math.round(n)));
};

/** Parse the query string of /v1/pet. Throws PetRequestError with a fix for bad input. */
export function parsePetQuery(query: string): PetRequest {
  const q = new URLSearchParams(query);
  const a = (q.get("a") ?? "talk").toLowerCase();
  if (!(ACTIONS as readonly string[]).includes(a)) {
    throw new PetRequestError(`unknown action a=${a}`, `use one of ${ACTIONS.join(", ")}`);
  }
  const name = (q.get("n") ?? "Pip").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 10) || "Pip";
  return {
    action: a as PetAction,
    food: clampStat(q.get("f"), "f"),
    joy: clampStat(q.get("j"), "j"),
    energy: clampStat(q.get("e"), "e"),
    name,
    seed: Number(q.get("s") ?? 0) | 0,
  };
}

/** The mood the stats suggest (used when a model forgets the tag, and by the mock). */
export function moodFromStats(r: Pick<PetRequest, "food" | "joy" | "energy">): Mood {
  if (r.food < 30) return "hungry";
  if (r.energy < 25) return "sleepy";
  if (r.joy < 30) return "sad";
  if (r.joy > 85 && r.energy > 50) return "excited";
  return "happy";
}

/** The persona prompt. Short on purpose: it runs on the smallest current model. */
export function personaPrompt(name: string): string {
  return [
    `You are ${name}, a tiny cute creature living inside a handheld toy with a small colour screen.`,
    "Answer with one short line in exactly this format: mood|what you say.",
    "Example: happy|Yay, you came back! I missed you.",
    `The mood is one word from: ${MOODS.join(", ")}.`,
    `What you say is under ${MAX_TEXT - 15} characters, plain ASCII, no emoji, first person, playful, reacting to the event and your stats.`,
  ].join(" ");
}

/** The user turn sent to the model. */
export function eventPrompt(r: PetRequest): string {
  const what: Record<PetAction, string> = {
    talk: "Your owner pressed TALK and wants to hear from you.",
    feed: "Your owner just fed you.",
    play: "Your owner just played with you.",
    sleep: "Your owner is putting you to bed.",
    lonely: "Nobody has paid attention to you for a while.",
    hello: "You just woke up in your toy.",
  };
  return `${what[r.action]} Food ${r.food}/100, joy ${r.joy}/100, energy ${r.energy}/100.`;
}

/** Make any model output safe for the board: one line, ASCII, <= 60 chars, a known mood. */
export function sanitizeReply(raw: string, req: Pick<PetRequest, "food" | "joy" | "energy">): PetReply {
  const lines = raw.replace(/\r/g, "").split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  const line = lines[0] ?? "";
  let mood: Mood = moodFromStats(req);
  let text = line;
  const bar = line.indexOf("|");
  if (bar >= 0) {
    const tag = line.slice(0, bar).trim().toLowerCase().replace(/[^a-z]/g, "");
    if ((MOODS as readonly string[]).includes(tag)) mood = tag as Mood;
    text = line.slice(bar + 1);
    // "happy|" with the words on the next line (seen from claude-haiku via the CLI): use that line.
    if (!text.trim() && lines[1]) text = lines[1];
  }
  text = text
    .replace(/[‘’]/g, "'")
    .replace(/[“”"]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\|/g, "/")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > MAX_TEXT) {
    const cut = text.slice(0, MAX_TEXT + 1);
    const sp = cut.lastIndexOf(" ");
    text = (sp > 30 ? cut.slice(0, sp) : cut.slice(0, MAX_TEXT)).replace(/[ ,;:-]+$/, "");
  }
  if (text.length === 0) text = "...";
  return { mood, text };
}

export function formatReply(r: PetReply): string {
  return `${r.mood}|${r.text}`;
}
