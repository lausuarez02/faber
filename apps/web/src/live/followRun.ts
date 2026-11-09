import { engine, useJumper } from "../lib/app.ts";
import { useLive } from "./liveStore.ts";

/**
 * Round 5, live track: the page that follows an agent runs the device itself (decision 0003).
 * The firmware comes from the server's latest build (GET /api/firmware); a `firmware` event reloads
 * it (restarting a running device), an `auto-run` event after an agent build / run / run_tests
 * starts it so the person sees it alive (setting, on by default; `?autorun=0|1` overrides).
 */

export interface FollowFirmware {
  hash: string;
  hex: string;
  artifact: string;
  board: string;
  backend: string;
  builtAt: string;
  stale?: boolean;
}

let firmware: FollowFirmware | undefined;
let fetching: Promise<FollowFirmware | { error: string }> | undefined;

/** http://host:port of the followed server (from ?follow=ws://host:port/live). */
export function followBase(search = typeof location !== "undefined" ? location.search : ""): string | undefined {
  const follow = new URLSearchParams(search).get("follow");
  if (!follow) return undefined;
  try {
    const u = new URL(follow);
    return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
  } catch {
    return undefined;
  }
}

const AUTORUN_KEY = "jumper.autorun";

/** Auto-run after agent builds: ?autorun=0|1 wins, then the saved setting, default on. */
export function autoRunEnabled(): boolean {
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("autorun") : null;
  if (q === "0" || q === "1") return q === "1";
  try {
    return localStorage.getItem(AUTORUN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAutoRun(on: boolean): void {
  try {
    localStorage.setItem(AUTORUN_KEY, on ? "1" : "0");
  } catch {
    // private window: the setting lasts for this page only
  }
  useLive.getState().set({ autoRun: on });
}

export function currentFirmware(): FollowFirmware | undefined {
  return firmware;
}

/** Put the known firmware in the app store, if it belongs to this project (called on every project load). */
export function applyFirmwareToStore(): void {
  const s = useJumper.getState();
  const p = s.project;
  if (!p.firmware) {
    if (s.firmware.status !== "none") s.setFirmware({ status: "none" });
    return;
  }
  if (firmware && firmware.artifact === p.firmware.artifact) {
    if (s.firmware.status !== "ready" || s.firmware.hex !== firmware.hex) s.setFirmware({ status: "ready", hex: firmware.hex, name: p.firmware.sketch ?? firmware.artifact, source: "upload" });
  } else if (s.firmware.status !== "missing") {
    s.setFirmware({ status: "missing", reason: `${p.firmware.artifact} is not built yet (the agent's next run builds it)` });
  }
}

/** GET /api/firmware: the latest built hex, or the server's why / fix. */
export async function fetchFirmware(base = followBase()): Promise<FollowFirmware | { error: string }> {
  if (!base) return { error: "This page does not follow a Jumper server. Fix: open it from the `jumper serve` URL." };
  fetching ??= (async () => {
    try {
      const r = await fetch(`${base}/api/firmware`, { cache: "no-store" });
      const body = (await r.json().catch(() => ({}))) as Partial<FollowFirmware> & { error?: string };
      if (!r.ok || !body.hex || !body.hash) {
        if (r.status === 404 && /No endpoint/.test(body.error ?? "")) return { error: `The Jumper server at ${base} is older than this page (no /api/firmware). Fix: restart it with \`pnpm start\`, or use Run a copy.` };
        return { error: body.error ?? `GET ${base}/api/firmware answered ${r.status}.` };
      }
      firmware = body as FollowFirmware;
      useLive.getState().set({ firmwareHash: firmware.hash, firmwareStale: !!firmware.stale });
      applyFirmwareToStore();
      return firmware;
    } catch (err) {
      return { error: `Could not reach the Jumper server at ${base} (${(err as Error).message}). Why: it stopped, or this page lost its connection. Fix: start it again with \`pnpm start\` and reload.` };
    } finally {
      fetching = undefined;
    }
  })();
  return fetching;
}

function refuse(error: string): void {
  const s = useJumper.getState();
  s.setSimError(error);
  s.toast({ kind: "error", title: "Can't run yet", detail: error });
}

/** Run pressed on the followed page: latest firmware, then the simulation here. */
export async function runFollowed(): Promise<void> {
  const p = useJumper.getState().project;
  const needsFirmware = !!p.firmware || p.parts.length === 0;
  if (needsFirmware) {
    const fw = await fetchFirmware();
    if ("error" in fw) {
      refuse(fw.error);
      return;
    }
  }
  useJumper.getState().setSimError(undefined);
  engine.runLocal();
}

/** Stop and start again with the firmware in the store (new hex arrived). */
function restart(): void {
  engine.stop();
  engine.runLocal();
}

/** A `firmware` event: reload the hex; restart if the device was running here. */
export async function onFirmwareEvent(hash: string): Promise<void> {
  if (firmware?.hash === hash) return;
  const wasRunning = engine.isLocalRun && useJumper.getState().run === "running";
  const fw = await fetchFirmware();
  if ("error" in fw) return;
  if (wasRunning && engine.isLocalRun) {
    restart();
    useJumper.getState().toast({ kind: "info", title: "New firmware: restarted", detail: `The agent built ${fw.artifact}; the device here restarted with it.` });
  }
}

/** An `auto-run` event (an agent build / run / run_tests finished ok). */
export async function onAutoRun(hash?: string): Promise<void> {
  if (!autoRunEnabled()) return;
  const running = engine.isLocalRun && useJumper.getState().run === "running";
  if (running && hash && firmware?.hash === hash) return; // already alive with this firmware
  const fw = await fetchFirmware();
  if ("error" in fw) return; // nothing built (yet): stay quiet, Run explains when pressed
  if (engine.isLocalRun) restart();
  else engine.runLocal();
}

/** A write_file from the agent: the hex is now older than the sketch until the agent builds. */
export function onSketchWritten(): void {
  if (firmware) useLive.getState().set({ firmwareStale: true });
}
