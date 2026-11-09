// The deterministic pet: canned replies picked by a hash of the request and a per-network
// counter, with a latency that is a pure function of the same inputs. Used in every test, in CI,
// in scenarios and whenever the simulation runs faster than real time.
import { moodFromStats, type Mood, type PetAction, type PetReply, type PetRequest } from "./protocol.ts";

const LINES: Record<PetAction, Partial<Record<Mood, string[]>> & { any: string[] }> = {
  talk: {
    happy: ["Hi friend! I feel great today", "I like it when you visit me", "Tell me a story? I am all ears"],
    hungry: ["My tummy is rumbling... snack?", "I could eat a whole pixel pie", "Feed me and I will sing for you"],
    sleepy: ["Yawn... my eyes keep closing", "Five more minutes of nap please", "So sleepy. Talk softly, ok?"],
    sad: ["I missed you. Stay a little?", "It was quiet in here all day", "Can we play? I feel a bit blue"],
    excited: ["Wheee! Best day in my toy ever", "I did three spins while you were away", "You are here! Let's do stuff!"],
    any: ["Beep boop, that is pet for hello"],
  },
  feed: {
    hungry: ["Yum! That hit the spot", "Nom nom nom. More later?", "Crunchy! My favourite pixels"],
    any: ["Thank you! I was a little peckish", "Tasty. I feel stronger already", "Mmm, still full but ok!"],
  },
  play: {
    sleepy: ["Play now? Ok... but slowly", "One game, then a nap"],
    any: ["Again! Again! That was fun", "I win! Or did you let me win?", "Bouncy bouncy, I love this game"],
  },
  sleep: { any: ["Goodnight. Dream of snacks", "Tuck me in, I am so cozy", "Zzz... see you in the morning"] },
  lonely: {
    hungry: ["Hello? Anyone? I am hungry...", "Is it snack time yet? Hellooo"],
    any: ["Hey! Are you still there?", "Psst. I am bored. Come play", "I drew you a heart. Come see"],
  },
  hello: { any: ["Hello world! I just woke up", "Good morning! What do we do today?"] },
};

/** cyrb53-style 32-bit hash; stable across Node and browsers. */
export function hash32(s: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  return h1 >>> 0;
}

/** Virtual latency of a mock answer: 400..799 ms, from the request alone. */
export function mockLatencyMs(req: PetRequest, counter: number): number {
  return 400 + (hash32(`lat:${req.action}:${req.food}:${req.joy}:${req.energy}:${counter}`) % 400);
}

/** Mock answers to something the person typed (m=): canned, but they show the words arrived. */
const HEARD = ["Ooh, \"%s\"? Tell me more!", "You said \"%s\"! I love that", "Hmm, \"%s\"... let me think!"];

export function mockReply(req: PetRequest, counter: number): PetReply {
  if (req.message) {
    const words = req.message.length > 22 ? `${req.message.slice(0, 20).trimEnd()}..` : req.message;
    const line = HEARD[hash32(`m:${req.message}:${req.seed}:${counter}`) % HEARD.length]!.replace("%s", words.replace(/\|/g, "/"));
    return { mood: moodFromStats(req) === "sad" ? "sad" : "happy", text: line };
  }
  const mood: Mood =
    req.action === "feed" ? (req.food < 60 ? "hungry" : "happy") : req.action === "play" ? (req.energy < 25 ? "sleepy" : "excited") : req.action === "sleep" ? "sleepy" : req.action === "lonely" ? (req.food < 30 ? "hungry" : "sad") : moodFromStats(req);
  const table = LINES[req.action];
  const lines = table[mood] ?? table.any;
  const pick = hash32(`${req.action}:${mood}:${req.seed}:${counter}`) % lines.length;
  const outMood: Mood = req.action === "feed" ? "happy" : mood;
  return { mood: outMood, text: lines[pick]! };
}
