// Round 7 (voice): what a talking part (DFPlayer Mini) says, on the canvas and out loud.
//
// While a clip plays with a speaker wired (state.speaking), a speech bubble with its words sits
// next to the speaker the DFPlayer drives (found through the wires), in the editor, the followed
// Live page and replays alike (they all paint part states). The browser speaks the words with the
// Web Speech API, unless the person muted it (remembered in this browser), the tab is hidden, or a
// test drives the page (navigator.webdriver). The words are the clip's text; the voice is the
// browser's, not the MP3 that will be on the real card.
import { buildNets, type Project } from "@jumper/project-format";
import type { VisualState } from "@jumper/sim-core";
import "./voice.css";

const MUTE_KEY = "jumper.speech.muted";
const listeners = new Set<() => void>();

export function speechMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSpeechMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // storage blocked: the toggle still works for this page
  }
  memoryMuted = muted;
  if (muted) cancelSpeech();
  for (const l of listeners) l();
}

let memoryMuted: boolean | undefined;
const muted = () => memoryMuted ?? speechMuted();

export function subscribeSpeechMuted(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** May the page make a sound now? Never in automated tests, hidden tabs, or when muted. */
export function canSpeak(): boolean {
  try {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
    if (navigator.webdriver) return false;
    if (document.visibilityState !== "visible") return false;
    return !muted();
  } catch {
    return false;
  }
}

function speak(text: string): void {
  if (!canSpeak() || /^\(track .*no words set\)$/.test(text)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 1.25;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    // no voice available: the bubble still shows the words
  }
}

function cancelSpeech(): void {
  try {
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  } catch {
    // nothing to cancel
  }
}

/** The part a talking part's sound comes out of: a speaker on SPK_1 / SPK_2 / DAC, else the talker itself. */
export function speakerOf(project: Project, talkerId: string): string {
  const nets = buildNets(project);
  const typeOf = new Map(project.parts.map((p) => [p.id, p.type]));
  for (const pin of ["SPK_1", "SPK_2", "DAC_R", "DAC_L"]) {
    const net = nets.find((n) => n.pins.some((x) => x.part === talkerId && x.pin === pin));
    const spk = net?.pins.find((x) => x.part !== talkerId && typeOf.get(x.part) === "speaker");
    if (spk) return spk.part;
  }
  return talkerId;
}

export class VoiceLayer {
  private bubbles = new Map<string, { el: HTMLElement; host: string; text: string }>();
  private lastCount = new Map<string, number>();
  private unsub: () => void;

  constructor(
    private readonly project: () => Project,
    private readonly partEl: (id: string) => HTMLElement | undefined,
  ) {
    this.unsub = subscribeSpeechMuted(() => {
      for (const b of this.bubbles.values()) syncMuteButton(b.el);
    });
  }

  /** Called with every painted state; acts only on talking parts (they have a `saying` key). */
  update(id: string, state: VisualState): void {
    if (typeof state.saying !== "string") return;
    const speaking = state.speaking === true && state.saying !== "";
    const count = typeof state.saidCount === "number" ? state.saidCount : 0;
    if (!speaking) {
      this.hide(id);
      this.lastCount.set(id, count);
      return;
    }
    const host = speakerOf(this.project(), id);
    this.show(id, host, state.saying);
    if (this.lastCount.get(id) !== count) {
      this.lastCount.set(id, count);
      speak(state.saying);
    }
  }

  /** Simulation stopped / project switched: no bubbles, no voice. */
  clear(): void {
    for (const id of [...this.bubbles.keys()]) this.hide(id);
    this.lastCount.clear();
    cancelSpeech();
  }

  dispose(): void {
    this.clear();
    this.unsub();
  }

  private show(id: string, host: string, text: string): void {
    const parent = this.partEl(host);
    if (!parent) return;
    let b = this.bubbles.get(id);
    if (b && (b.host !== host || !parent.contains(b.el))) {
      b.el.remove();
      b = undefined;
    }
    if (!b) {
      const el = document.createElement("div");
      el.className = "speech-bubble nodrag nopan";
      el.dataset.testid = `speech-bubble-${host}`;
      el.setAttribute("data-testid", `speech-bubble-${host}`);
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      const words = document.createElement("span");
      words.className = "speech-words";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "speech-mute";
      btn.setAttribute("data-testid", "speech-mute");
      btn.addEventListener("pointerdown", (e) => e.stopPropagation());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        setSpeechMuted(!muted());
      });
      el.append(words, btn);
      syncMuteButton(el);
      parent.appendChild(el);
      b = { el, host, text: "" };
      this.bubbles.set(id, b);
    }
    if (b.text !== text) {
      b.text = text;
      b.el.querySelector(".speech-words")!.textContent = text;
      b.el.dataset.missing = String(/^\(track .*no words set\)$/.test(text));
    }
  }

  private hide(id: string): void {
    const b = this.bubbles.get(id);
    if (!b) return;
    b.el.remove();
    this.bubbles.delete(id);
  }
}

// Inline SVG icons (speaker with sound waves / crossed), same strokes as the app's line icons.
const ICON_ON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>';
const ICON_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>';

function syncMuteButton(bubble: HTMLElement): void {
  const btn = bubble.querySelector<HTMLButtonElement>(".speech-mute");
  if (!btn) return;
  const m = muted();
  btn.innerHTML = m ? ICON_OFF : ICON_ON;
  btn.setAttribute("aria-pressed", String(m));
  btn.setAttribute("aria-label", m ? "Unmute: let the browser read the words aloud" : "Mute: stop reading the words aloud");
  btn.title = m ? "Voice muted (click to hear the words)" : "Reading the words aloud (click to mute)";
}
