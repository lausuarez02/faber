// Server-side backend factory (decision 0006): every backend, in-process (avr8js, rp2040js) and
// local-process (Espressif QEMU for the ESP32 family, Renode for Cortex-M boards). Node only: it
// spawns Docker containers. The browser imports "@jumper/sim-backends" (in-process only).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendFactory, McuBackend, McuCapability, PinState, Unsubscribe } from "@jumper/sim-core";
import { backendFactory as inProcessFactory } from "./index.ts";
import { withPinMap } from "./pinmap.ts";
import { ESP_CHIPS, type EspChip } from "./qemu-esp/chips.ts";
import { QemuEspBackend, type QemuEspBackendOptions } from "./qemu-esp/backend.ts";
import { createRenodeBackend } from "./renode/backend.ts";
import { renodeBoardOf } from "./renode/boards.ts";

export interface NodeBackendOptions {
  /** Extra Docker labels for emulator containers (the local runner passes its session id). */
  labels?: Record<string, string>;
  /** QEMU options for tests (image, icount shift, timeouts). */
  qemu?: Partial<Omit<QemuEspBackendOptions, "chip">>;
  /** Called with every process backend created, so the runner can dispose them all. */
  onProcess?: (backend: McuBackend) => void;
}

/** Every backend: in-process ones as in the browser, process ones as local emulators. */
export function createNodeBackendFactory(opts: NodeBackendOptions = {}): BackendFactory {
  return (board) => {
    const { backend, chip } = board.mcu;
    if (backend === "qemu-esp") {
      const c = chip.toLowerCase() as EspChip;
      if (!ESP_CHIPS[c]) {
        throw new Error(`board '${board.partId}' (${board.type}) asks for ESP chip '${chip}', which the QEMU backend does not run (it runs ${Object.keys(ESP_CHIPS).join(", ")}). Fix: correct mcu.chip in the board's part.json.`);
      }
      const be = new QemuEspBackend({
        chip: c,
        vcc: board.mcu.vcc,
        network: false,
        ...(board.mcu.flash?.sizeMB ? { flashSizeMB: board.mcu.flash.sizeMB } : {}),
        ...opts.qemu,
        ...(opts.labels ? { labels: opts.labels } : {}),
      });
      opts.onProcess?.(be);
      return withPinMap(be, board.mcu.pinMap);
    }
    if (backend === "renode") {
      const be = new RenodeElfBackend(board.type, board.mcu.clockHz, board.mcu.vcc);
      opts.onProcess?.(be);
      return withPinMap(be, board.mcu.pinMap);
    }
    return inProcessFactory(board);
  };
}

/** The default server-side factory (no labels). */
export const nodeBackendFactory: BackendFactory = createNodeBackendFactory();

/**
 * Renode boards take their ELF when the emulator starts (the round 9 backend cannot swap it), so
 * this adapter starts Renode on load() / prepare() and forwards everything else.
 * Gap: Renode's start still blocks the thread for its 2 to 3 s (round 9 backend), prepare() included.
 */
class RenodeElfBackend implements McuBackend {
  readonly kind = "process" as const;
  readonly cyclesPerSecond: number;
  readonly vcc: number;
  readonly pinIds: readonly string[];
  readonly capabilities: readonly McuCapability[] = ["gpio", "uart", "spi"];
  private inner: ReturnType<typeof createRenodeBackend> | undefined;
  private dir: string | undefined;
  private pinCbs = new Set<(pinId: string, state: PinState, cycle: number) => void>();
  private serialCbs = new Set<(byte: number, cycle: number) => void>();
  private unsubs: Unsubscribe[] = [];
  private readonly type: string;

  constructor(type: string, clockHz: number, vcc: number) {
    const board = renodeBoardOf(type);
    if (!board) throw new Error(`board '${type}' asks for the Renode backend, but packages/sim-backends/src/renode/boards.ts has no entry for it. Fix: add its platform, console UART and pin map there.`);
    this.type = type;
    this.cyclesPerSecond = clockHz || board.clockHz;
    this.vcc = vcc || board.vcc;
    this.pinIds = Object.keys(board.pins);
  }

  get cycles(): number {
    return this.inner?.cycles ?? 0;
  }

  async prepare(firmware: Uint8Array | string): Promise<void> {
    this.load(firmware);
  }

  load(firmware: Uint8Array | string): void {
    if (typeof firmware === "string") throw new Error("Renode boards load an ELF file (bytes), not Intel HEX. Fix: build for this board's FQBN; the build writes firmware/<sketch>.elf.");
    this.dispose();
    this.dir = mkdtempSync(join(tmpdir(), "jumper-renode-fw-"));
    const elf = join(this.dir, "firmware.elf");
    writeFileSync(elf, firmware);
    this.inner = createRenodeBackend({ board: this.type, elf });
    this.unsubs.push(
      this.inner.onPinChange((p, s, c) => this.pinCbs.forEach((cb) => cb(p, s, c))),
      this.inner.onSerial((b, c) => this.serialCbs.forEach((cb) => cb(b, c))),
    );
  }

  step(cycles: number): void {
    if (!this.inner) throw new Error("Renode is not running (no firmware loaded). Fix: build, then run.");
    this.inner.step(cycles);
  }

  readPin(pinId: string): PinState {
    return this.inner?.readPin(pinId) ?? { mode: "input", value: 0 };
  }

  setPinInput(pinId: string, volts: number): void {
    this.inner?.setPinInput(pinId, volts);
  }

  onPinChange(cb: (pinId: string, state: PinState, cycle: number) => void): Unsubscribe {
    this.pinCbs.add(cb);
    return () => this.pinCbs.delete(cb);
  }

  onSerial(cb: (byte: number, cycle: number) => void): Unsubscribe {
    this.serialCbs.add(cb);
    return () => this.serialCbs.delete(cb);
  }

  reset(): void {
    this.inner?.reset();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.inner?.dispose();
    this.inner = undefined;
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
  }
}

export { QemuEspBackend, EmulatorError, explainEmulatorLog } from "./qemu-esp/backend.ts";
export { QEMU_ESP_IMAGE, EMULATOR_LABEL, OWNER_LABEL, qemuImageAvailable } from "./qemu-esp/launcher.ts";
export { RENODE_IMAGE } from "./renode/machine.ts";
