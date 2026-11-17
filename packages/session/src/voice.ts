/**
 * Round 7 (voice): what a talking device needs around the DFPlayer Mini part: design checks
 * (speaker wired, words for every clip the sketch plays), the microSD card's files for the factory
 * pack, and the BOM line for the card. The clips are text; turning them into MP3s happens on the
 * person's computer with an external text-to-speech tool they install (piper or espeak-ng, plus
 * ffmpeg), never shipped with Faber.
 */
import { buildNets, type PartInstance, type Project } from "@faber/project-format";
import { formatClips, parseClips } from "@faber/parts";
import type { PartRegistry } from "@faber/sim-core";
import type { DesignIssue } from "./drc.ts";

/** The speaker parts: "speaker" (28 mm) and the smaller "speaker-20mm" / "speaker-15mm" (round 8). */
export const isSpeakerType = (type: string) => /^speaker(-\d+mm)?$/.test(type);

/** Parts that talk: a clip table ("clips" prop). */
export function talkingParts(project: Project, registry: PartRegistry): PartInstance[] {
  return project.parts.filter((p) => registry.get(p.type)?.spec.props?.some((x) => x.id === "clips"));
}

export function clipsOf(p: PartInstance, registry: PartRegistry): Map<string, string> {
  const dflt = registry.get(p.type)?.spec.props?.find((x) => x.id === "clips")?.default;
  return parseClips(p.props?.clips ?? dflt ?? "").clips;
}

/** Track numbers a sketch plays, read from its text (dfSend(…, 0x03, N), play(N), playMp3Folder(N), playFolder(F, N)). */
export function tracksInSketch(src: string): string[] {
  const s = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Set<string>();
  for (const m of s.matchAll(/(?:0x0?3|0x12)\s*,\s*(\d{1,4})\s*\)/gi)) out.add(String(Number(m[1])));
  for (const m of s.matchAll(/\.\s*play(?:Mp3Folder)?\s*\(\s*(\d{1,4})\s*\)/g)) out.add(String(Number(m[1])));
  for (const m of s.matchAll(/\.\s*playFolder\s*\(\s*(\d{1,3})\s*,\s*(\d{1,4})\s*\)/g)) out.add(`${Number(m[1])}/${Number(m[2])}`);
  return [...out];
}

export function voiceChecks(project: Project, registry: PartRegistry, firmwareSource = ""): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const talkers = talkingParts(project, registry);
  const nets = buildNets(project);
  const netOf = (part: string, pin: string) => nets.find((n) => n.pins.some((x) => x.part === part && x.pin === pin));
  const typeOf = (id: string) => project.parts.find((p) => p.id === id)?.type ?? "";
  const specOf = (id: string) => registry.get(typeOf(id))?.spec;

  for (const df of talkers) {
    const others = (pin: string) => netOf(df.id, pin)?.pins.filter((x) => x.part !== df.id) ?? [];
    const spk1 = others("SPK_1");
    const spk2 = others("SPK_2");
    const dac = [...others("DAC_R"), ...others("DAC_L")];
    const isSpeaker = (x: { part: string }) => isSpeakerType(typeOf(x.part)) || /speaker|amp/i.test(specOf(x.part)?.name ?? "");
    const bridged = spk1.some((a) => isSpeaker(a) && spk2.some((b) => b.part === a.part));
    const onDac = dac.some(isSpeaker) || dac.some((x) => specOf(x.part)?.category !== "board" && specOf(x.part)?.category !== "passive");
    if (!bridged && !onDac) {
      const loose = [...spk1, ...spk2].filter(isSpeaker);
      issues.push({
        severity: "warning",
        code: "dfplayer-no-speaker",
        message: `DFPlayer speaks but no speaker is wired. Why: ${df.id}'s words only become sound through a speaker across SPK_1 and SPK_2 (or an amplifier on DAC_L / DAC_R); ${loose.length ? `${loose.map((x) => `${x.part}.${x.pin}`).join(", ")} is on only one of them, so no current flows` : "nothing is on those pins"}, so the simulation shows no speech bubble and a real one stays silent. Fix: place_part speaker, then connect ${df.id}.SPK_1 → speaker + and ${df.id}.SPK_2 → speaker -.`,
        parts: [df.id],
        pins: [`${df.id}.SPK_1`, `${df.id}.SPK_2`],
      });
    }
    for (const pin of ["SPK_1", "SPK_2"]) {
      const n = netOf(df.id, pin);
      const bad = n?.pins.filter((x) => {
        const sp = specOf(x.part)?.pins.find((q) => q.id === x.pin);
        return x.part !== df.id && (sp?.type === "ground" || sp?.type === "power" || (specOf(x.part)?.category === "board" && sp?.type !== "passive"));
      });
      if (bad?.length) {
        issues.push({
          severity: "error",
          code: "dfplayer-spk-shorted",
          message: `${df.id}.${pin} is wired to ${bad.map((x) => `${x.part}.${x.pin}`).join(", ")}. Why: SPK_1 / SPK_2 are the two halves of a bridged amplifier, neither is ground, and tying one to GND, a supply or a board pin shorts the amplifier (it overheats or resets). Fix: disconnect it; the speaker goes across SPK_1 and SPK_2 only.`,
          parts: [df.id, ...new Set(bad.map((x) => x.part))],
          pins: [`${df.id}.${pin}`, ...bad.map((x) => `${x.part}.${x.pin}`)],
        });
      }
    }
    // Words for every clip.
    const clips = clipsOf(df, registry);
    const raw = String(df.props?.clips ?? "");
    const problems = raw ? parseClips(raw).problems : [];
    if (problems.length) {
      issues.push({ severity: "warning", code: "dfplayer-bad-clips", message: `${df.id}'s clips table has lines it cannot read: ${problems.slice(0, 3).join("; ")}. Why: each line must be "N: words" (or "F/N: words" for a folder), so these clips have no words. Fix: set_part_property ${df.id} clips with one "N: words" line per track.`, parts: [df.id] });
    }
    const empty = [...clips].filter(([, t]) => !t.trim()).map(([k]) => k);
    const played = tracksInSketch(firmwareSource).filter((k) => !clips.get(k)?.trim());
    const noWords = [...new Set([...empty, ...played])];
    if (noWords.length) {
      issues.push({
        severity: "warning",
        code: "dfplayer-no-words",
        message: `${df.id} has no words for ${noWords.map((k) => `track ${k}`).join(", ")}${played.length ? " (the sketch plays it)" : ""}. Why: what it says comes from its clips table, so the speech bubble would say "(track ${noWords[0]}: no words set)" and the microSD card would get no file for it. Fix: set_part_property ${df.id} clips "${formatClips(new Map([...clips, ...noWords.map((k) => [k, "…"] as [string, string])]))
          .split("\n")
          .join("\\n")}" with the real words.`,
        parts: [df.id],
      });
    } else if (clips.size === 0) {
      issues.push({ severity: "warning", code: "dfplayer-no-words", message: `${df.id} has an empty clips table. Why: it says nothing without words for its tracks. Fix: set_part_property ${df.id} clips "1: hello!\\n2: …".`, parts: [df.id] });
    }
  }

  // A speaker straight on a board pin or a supply.
  for (const spk of project.parts.filter((p) => isSpeakerType(p.type))) {
    for (const pin of ["+", "-"]) {
      const n = netOf(spk.id, pin);
      const hot = n?.pins.filter((x) => {
        const s = specOf(x.part);
        const sp = s?.pins.find((q) => q.id === x.pin);
        return x.part !== spk.id && ((s?.category === "board" && (sp?.type === "digital" || sp?.type === "analog" || sp?.type === "power")) || (s?.category === "power" && sp?.type === "power"));
      });
      if (hot?.length) {
        issues.push({ severity: "error", code: "speaker-on-pin", message: `${spk.id}.${pin} is wired straight to ${hot.map((x) => `${x.part}.${x.pin}`).join(", ")}. Why: an 8 Ω speaker on a pin or a supply pulls about 600 mA at 5 V: it kills a GPIO and overheats the speaker, and a pin cannot play speech anyway. Fix: drive it from an amplifier: place_part dfplayer-mini and wire ${spk.id}.+ → SPK_1, ${spk.id}.- → SPK_2.`, parts: [spk.id, ...new Set(hot.map((x) => x.part))], pins: [`${spk.id}.${pin}`] });
      }
    }
  }
  return issues;
}

/** The microSD card's files for each talking part: relative path → text. */
export function sdCardFiles(project: Project, registry: PartRegistry): Record<string, string> {
  const talkers = talkingParts(project, registry);
  const out: Record<string, string> = {};
  for (const df of talkers) {
    const base = talkers.length > 1 ? `${df.id}/` : "";
    const clips = [...clipsOf(df, registry)].filter(([, t]) => t.trim());
    const rows: string[] = [];
    for (const [k, text] of clips) {
      const [a, b] = k.split("/");
      const file = b === undefined ? `mp3/${a!.padStart(4, "0")}` : `${a!.padStart(2, "0")}/${b.padStart(3, "0")}`;
      out[`${base}${file}.txt`] = `${text}\n`;
      rows.push(`| ${b === undefined ? a : `folder ${a}, file ${b}`} | /${file}.mp3 | ${b === undefined ? `0x12 (play mp3 folder) ${a}, or 0x03 ${a} when files are copied in order` : `0x0F (play folder) ${a}/${b}`} | ${text.replace(/\|/g, "\\|")} |`);
    }
    out[`${base}CLIPS.md`] = [
      `# microSD card for ${df.id} (${project.name})`,
      "",
      "What the DFPlayer Mini says, track by track. In Faber these are text; on the real device each one is an MP3 on the card.",
      "",
      "| Track | File on the card | Command that plays it | Words |",
      "| --- | --- | --- | --- |",
      ...rows,
      "",
      "## Make the card",
      "",
      "1. Format a microSD card (up to 32 GB) as **FAT32**.",
      "2. Make the MP3s from the texts: `sh make-clips.sh` (needs a text-to-speech tool you install yourself, see the script). Or record your own voice and save each clip as the file name above.",
      "3. Copy the folders to the card's root: `mp3/0001.mp3`, `mp3/0002.mp3` … (names must keep their 4 digits; folder plays use `01/001.mp3`).",
      "4. Copy the files **in track order** onto a freshly formatted card: command 0x03 plays by copy order, 0x12 by the file's number in /mp3.",
      "5. Eject cleanly (no hidden files from macOS: `dot_clean` or `mdutil -i off` on the card helps), put the card in the DFPlayer and power it.",
      "",
      "Note: the simulator estimates each clip's length from its words (2.6 words per second plus 0.3 s) and the browser speaks the words with its own voice; the real MP3 sets the real length and voice.",
      "",
    ].join("\n");
    out[`${base}make-clips.sh`] = makeClipsScript(clips.map(([k]) => {
      const [a, b] = k.split("/");
      return b === undefined ? `mp3/${a!.padStart(4, "0")}` : `${a!.padStart(2, "0")}/${b.padStart(3, "0")}`;
    }));
  }
  return out;
}

function makeClipsScript(files: string[]): string {
  return `#!/bin/sh
# Turn the clip texts (*.txt) into the MP3s the DFPlayer plays, next to them.
# External tools, NOT shipped with Faber; install one text-to-speech engine yourself:
#   piper    https://github.com/rhasspy/piper   (MIT; voices have their own licences)  + a voice .onnx file in PIPER_VOICE
#   espeak-ng https://github.com/espeak-ng/espeak-ng (GPL-3.0; run as a separate program)
# and ffmpeg (https://ffmpeg.org, LGPL/GPL builds) to encode MP3.
# Usage: sh make-clips.sh          (PIPER_VOICE=path/to/voice.onnx to use piper)
set -e
cd "$(dirname "$0")"
command -v ffmpeg >/dev/null 2>&1 || { echo "make-clips: ffmpeg is missing. Why: it encodes the MP3s. Fix: install ffmpeg (brew install ffmpeg / apt install ffmpeg)."; exit 1; }
say_to_wav() { # text-file wav-file
  if [ -n "$PIPER_VOICE" ] && command -v piper >/dev/null 2>&1; then
    piper --model "$PIPER_VOICE" --output_file "$2" < "$1"
  elif command -v espeak-ng >/dev/null 2>&1; then
    espeak-ng -v en-us -s 150 -w "$2" -f "$1"
  else
    echo "make-clips: no text-to-speech engine found. Why: the texts need a voice. Fix: install espeak-ng (brew install espeak-ng / apt install espeak-ng) or piper with PIPER_VOICE set."; exit 1
  fi
}
for f in ${files.map((f) => `"${f}"`).join(" ")}; do
  [ -f "$f.txt" ] || continue
  say_to_wav "$f.txt" "$f.wav"
  ffmpeg -loglevel error -y -i "$f.wav" -ac 1 -ar 44100 -b:a 128k "$f.mp3"
  rm -f "$f.wav"
  echo "made $f.mp3"
done
echo "Copy the folders (mp3/, 01/ ...) to a FAT32 microSD card, in track order."
`;
}
