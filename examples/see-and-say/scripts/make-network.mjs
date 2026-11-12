// Writes the example's offline APIs: network/mocks.json (the vision API) and
// network/cassettes/speech.json (the speech API). Deterministic: run it again and nothing changes.
//   node examples/see-and-say/scripts/make-network.mjs
// Neither is a recording of a real provider. The vision answer is written by hand in the
// OpenAI-compatible chat-completions shape; the "speech" is a generated voice-like chirp (three
// syllables, 24 kHz 16-bit mono PCM, the format TTS APIs return for response_format "pcm").
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SAID = "Nice keyboard. Shame about the crumbs.";
export const RATE = 24000;

/** ~0.6 s: three syllables with gliding pitch and a soft envelope, peak 80 % of full scale. */
export function chirp() {
  const syl = [
    { f0: 220, f1: 300, ms: 160 },
    { f0: 300, f1: 240, ms: 140 },
    { f0: 260, f1: 180, ms: 200 },
  ];
  const gap = Math.round(RATE * 0.04);
  const parts = [];
  for (const s of syl) {
    const n = Math.round((RATE * s.ms) / 1000);
    const pcm = new Int16Array(n + gap);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const f = s.f0 + (s.f1 - s.f0) * t;
      ph += (2 * Math.PI * f) / RATE;
      const env = Math.sin(Math.PI * t);
      // a fundamental and two harmonics: buzzy, voice-ish
      const v = 0.6 * Math.sin(ph) + 0.25 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph);
      pcm[i] = Math.round(0.8 * 32767 * env * v);
    }
    parts.push(pcm);
  }
  const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return Buffer.from(out.buffer);
}

/** Exactly the body the firmware sends (ArduinoJson, keys in this order, no spaces). */
export const speechBody = (text) => JSON.stringify({ model: "your-tts-model", voice: "alloy", input: text, response_format: "pcm" });

const vision = {
  id: "chatcmpl-example",
  object: "chat.completion",
  model: "your-vision-model",
  choices: [{ index: 0, message: { role: "assistant", content: SAID }, finish_reason: "stop" }],
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(
    join(HERE, "network/mocks.json"),
    `${JSON.stringify(
      {
        mocks: [
          {
            host: "api.vision.example",
            method: "POST",
            path: "/v1/chat/completions",
            response: { status: 200, headers: { "content-type": "application/json" }, body: vision },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const body = Buffer.from(speechBody(SAID));
  const audio = chirp();
  writeFileSync(
    join(HERE, "network/cassettes/speech.json"),
    `${JSON.stringify(
      {
        version: 1,
        note: "Written by examples/see-and-say/scripts/make-network.mjs, not recorded from a real API: the answer a TTS API gives for response_format pcm (24 kHz 16-bit mono), with a generated voice-like chirp as the audio. Record a real one with network.record in internet mode.",
        interactions: [
          {
            request: { method: "POST", host: "api.speech.example", path: "/v1/audio/speech", body_sha256: createHash("sha256").update(body).digest("hex").slice(0, 32), header_names: ["content-length", "content-type", "host"] },
            response: { status: 200, headers: { "content-type": "audio/pcm" }, body_b64: audio.toString("base64") },
            recorded_at: "2026-11-12T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  console.log(`mocks.json + cassettes/speech.json written (${audio.length} bytes of audio)`);
}
