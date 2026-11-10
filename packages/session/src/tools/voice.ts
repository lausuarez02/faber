import { fail } from "../errors.ts";
import { talkingParts } from "../voice.ts";
import type { ToolModule } from "./types.ts";

/**
 * Round 7 (voice): read_speech, what a talking device (DFPlayer Mini + speaker) said in the
 * simulation, like read_serial for words. The clips are text (the DFPlayer's "clips" prop); timing
 * is estimated from the word count; the browser speaks them with its own voice.
 */
export const voiceTools: ToolModule = {
  name: "voice",
  tools: [
    {
      name: "read_speech",
      title: "Read what it said",
      description:
        'What the device said out loud in the simulation (DFPlayer Mini clips, whose words are its "clips" prop): {"since": 0} for everything. Returns {t_ms, next, said: [{part, t_ms, dur_ms, track, clip, text, heard, volume, missing_words?}], saying_now}. heard is false when no speaker is wired to SPK_1 / SPK_2 (or DAC), so a person would hear nothing and no speech bubble shows. Pass next as since to read only new ones. Length is estimated (2.6 words per second + 0.3 s). Test it in a scenario with {"said": "dizzy", "within_ms": 500}. Run the simulation first (run / run_tests); with nothing run yet it is empty.',
      inputSchema: { type: "object", properties: { since: { type: "number", description: "Index into the list, from a previous next (default 0)." }, part: { type: "string", description: "Only this talking part (e.g. df1)." } } },
      readOnly: true,
    },
  ],
  ops: {
    async read_speech(args, x) {
      const s = x.session;
      const talkers = talkingParts(s.project, s.registry);
      if (!talkers.length) fail("cannot-talk", "read_speech: nothing in this project can talk", "only a dfplayer-mini (with its clips) says words", 'place_part dfplayer-mini and a speaker (search_parts "voice"), wire SPK_1 / SPK_2 to the speaker and set its clips, e.g. "1: hello!"');
      const part = typeof args.part === "string" ? args.part : undefined;
      if (part && !talkers.some((t) => t.id === part)) fail("cannot-talk", `read_speech part ${part}`, `${part} is not a talking part`, `use one of: ${talkers.map((t) => t.id).join(", ")}`);
      const { t_ms, said } = await s.speech();
      const all = said.filter((u) => !part || u.partId === part);
      const since = Math.max(0, Math.min(Number(args.since ?? 0) || 0, all.length));
      const now = all.filter((u) => u.t_ms <= t_ms && t_ms < u.t_ms + u.dur_ms).pop();
      x.summary(`read what it said (${all.length - since} new)`);
      return {
        t_ms,
        since,
        next: all.length,
        said: all.slice(since).map((u) => ({ part: u.partId, t_ms: Math.round(u.t_ms * 10) / 10, dur_ms: u.dur_ms, track: u.track, clip: u.clip, text: u.text, heard: u.audible, volume: u.volume, ...(u.missing ? { missing_words: true } : {}) })),
        saying_now: now ? now.text : "",
        ...(all.some((u) => !u.audible) ? { note: "heard: false means no speaker is wired to SPK_1 / SPK_2 (or DAC), so nobody would hear it; check_design says how to wire one." } : {}),
      };
    },
  },
};
