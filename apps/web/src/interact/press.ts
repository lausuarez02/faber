import { engine } from "../lib/app.ts";
import { MIN_PRESS_MS } from "./controls.ts";
import { setHeld, useInteract } from "./store.ts";

/**
 * Round 6 (canvas): pressing a running part. A press starts on pointer down; the release waits
 * until the button was down at least MIN_PRESS_MS of wall time (so the cap is seen pressed) and,
 * while the simulation runs, MIN_PRESS_MS of virtual time (so the firmware's debounce sees it). A
 * real click (~0-100 ms) therefore always registers. Paused: only the wall-time minimum applies.
 */

interface Down {
  wall: number;
  virt: number;
  raf: number;
}

const down = new Map<string, Down>();
/** Give up waiting for virtual time after this much wall time (a stalled sim must not hold a button forever). */
const MAX_WAIT_MS = 3000;

export function pressPart(id: string): void {
  const prev = down.get(id);
  if (prev) cancelAnimationFrame(prev.raf); // re-pressed during the minimum hold: stays down
  down.set(id, { wall: performance.now(), virt: engine.simTimeMs, raf: 0 });
  if (!prev || !useInteract.getState().held[id]) {
    setHeld(id, true);
    engine.interact(id, "press");
  }
}

export function releasePart(id: string): void {
  const d = down.get(id);
  if (!d) {
    if (useInteract.getState().held[id]) {
      setHeld(id, false);
      engine.interact(id, "release");
    }
    return;
  }
  const tryRelease = () => {
    const now = performance.now();
    const wallOk = now - d.wall >= MIN_PRESS_MS;
    const virtOk = !engine.isRunning || engine.simTimeMs - d.virt >= MIN_PRESS_MS || now - d.wall > MAX_WAIT_MS;
    if (!wallOk || !virtOk) {
      d.raf = requestAnimationFrame(tryRelease);
      return;
    }
    if (down.get(id) !== d) return;
    down.delete(id);
    setHeld(id, false);
    engine.interact(id, "release");
  };
  tryRelease();
}

/** Forget every held button (the simulation went away or another project opened). */
export function releaseAllNow(): void {
  for (const d of down.values()) cancelAnimationFrame(d.raf);
  down.clear();
}
