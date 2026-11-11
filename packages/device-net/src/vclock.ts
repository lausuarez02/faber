// The gateway's clock on the simulation's virtual time. The simulation (main thread) writes its
// virtual ms into a SharedArrayBuffer after each step (DeviceNetHost.setVirtualTime); the network
// thread reads it, so mock delays (delay_ms, streamed chunks, WebSocket frames), latency faults and
// the log's t_ms follow the device's clock at any simulation speed. Until a simulation drives it
// (NaN), it is wall time since start. A sleep waits for virtual time to pass, so a paused
// simulation also pauses its mocks.
import type { Clock } from "./gateway.ts";

export function newVirtualTimeBuffer(): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(8);
  new Float64Array(sab)[0] = Number.NaN;
  return sab;
}

export function sharedClock(sab: SharedArrayBuffer, pollMs = 1): Clock {
  const f = new Float64Array(sab);
  const t0 = Date.now();
  const driven = () => Number.isFinite(f[0]!);
  const now = () => (driven() ? f[0]! : Date.now() - t0);
  return {
    now,
    wallMs: () => Date.now(),
    sleep(ms: number) {
      if (ms <= 0) return Promise.resolve();
      if (!driven()) return new Promise((r) => setTimeout(r, ms));
      const target = now() + ms;
      return new Promise<void>((resolve) => {
        const tick = () => {
          if (!driven() || now() >= target) resolve();
          else setTimeout(tick, pollMs);
        };
        tick();
      });
    },
  };
}
