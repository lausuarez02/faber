// Boards as data (decision 0006): a board part may name its pins differently from the backend
// ("D13" on the board, "P0.13" in Renode). `mcu.pinMap` maps board pin id → backend pin id, and
// this wrapper makes the backend speak the board's pin ids, so sim-core never needs to know.
import type { McuBackend, McuBusPins, PinState, Unsubscribe } from "@fabwright/sim-core";

export function withPinMap<T extends McuBackend>(backend: T, pinMap: Record<string, string> | undefined): McuBackend {
  if (!pinMap || Object.keys(pinMap).length === 0) return backend;
  const toBackend = new Map(Object.entries(pinMap));
  const toBoard = new Map<string, string>();
  for (const [board, be] of toBackend) {
    if (toBoard.has(be)) throw new Error(`mcu.pinMap maps two board pins (${toBoard.get(be)}, ${board}) to the same backend pin ${be}. Fix: give every board pin its own backend pin.`);
    toBoard.set(be, board);
  }
  for (const be of toBackend.values()) {
    if (!backend.pinIds.includes(be)) throw new Error(`mcu.pinMap names backend pin '${be}', which this backend does not have (it has ${backend.pinIds.slice(0, 12).join(", ")}…). Fix: correct the board's part.json mcu.pinMap.`);
  }
  const board = (be: string) => toBoard.get(be) ?? be;
  const be = (b: string) => toBackend.get(b) ?? b;
  const mapBus = (bp: McuBusPins | undefined): McuBusPins | undefined => {
    if (!bp) return undefined;
    const out: Record<string, Record<string, string>> = {};
    for (const [bus, pins] of Object.entries(bp)) {
      if (!pins) continue;
      out[bus] = Object.fromEntries(Object.entries(pins as Record<string, string>).map(([k, v]) => [k, board(v)]));
    }
    return out as McuBusPins;
  };
  const pinIds = backend.pinIds.map(board);
  // A Proxy keeps every optional method (prepare, dispose, attachI2c, stopAt…) and getter (cycles).
  return new Proxy(backend, {
    get(target, prop, receiver) {
      switch (prop) {
        case "pinIds":
          return pinIds;
        case "busPins":
          return mapBus(target.busPins);
        case "readPin":
          return (pin: string): PinState => target.readPin(be(pin));
        case "setPinInput":
          return (pin: string, volts: number) => target.setPinInput(be(pin), volts);
        case "pinWatched":
          return target.pinWatched ? (pin: string) => target.pinWatched!(be(pin)) : undefined;
        case "onPinChange":
          return (cb: (pinId: string, state: PinState, cycle: number) => void): Unsubscribe => target.onPinChange((pin, s, c) => cb(board(pin), s, c));
        default: {
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        }
      }
    },
  });
}
