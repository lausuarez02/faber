// Server-side backend factory (decision 0006): every backend, in-process (avr8js, rp2040js) and
// local-process (Espressif QEMU for the ESP32 family, Renode for STM32 / nRF52 boards). Node only:
// it spawns emulator processes / Docker containers. The browser imports "@fabwright/sim-backends"
// (in-process only) and follows the server's run for process boards.
import type { BackendFactory, McuBackend } from "@fabwright/sim-core";
import { backendFactory as inProcessFactory } from "./index.ts";
import { withPinMap } from "./pinmap.ts";
import { ESP_CHIPS, type EspChip } from "./qemu-esp/chips.ts";
import { QemuEspBackend, type QemuEspBackendOptions } from "./qemu-esp/backend.ts";
import { createRenodeBackend, type RenodeBackendOptions } from "./renode/backend.ts";
import { renodeBoardOf } from "./renode/boards.ts";

/** Process backends this factory adds to the in-process ones. */
export const PROCESS_BACKENDS = ["qemu-esp", "renode"] as const;

export interface NodeBackendOptions {
  /** Extra Docker labels for emulator containers (the local runner passes its session id). */
  labels?: Record<string, string>;
  /** QEMU options (tests: image, icount shift, timeouts; the session: the board's network card). */
  qemu?: Partial<Omit<QemuEspBackendOptions, "chip">>;
  /** Renode options (tests: runtime, timeouts, log file). */
  renode?: Partial<Omit<RenodeBackendOptions, "board">>;
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
        // Round 13: the board's PSRAM (camera frame buffers): QEMU's SPI PSRAM, octal on the S3 boards that have it
        ...(board.mcu.psram ? { psramMB: board.mcu.psram.sizeMB, ...(board.mcu.psram.mode === "octal" ? { extraArgs: ["-global", "driver=ssi_psram,property=is_octal,value=true"] } : {}) } : {}),
        ...opts.qemu,
        ...(opts.labels ? { labels: opts.labels } : {}),
      });
      opts.onProcess?.(be);
      return withPinMap(be, board.mcu.pinMap);
    }
    if (backend === "renode") {
      if (!renodeBoardOf(board.type)) {
        throw new Error(`board '${board.partId}' (${board.type}) asks for the Renode backend, but Renode has no board data for '${board.type}'. Fix: add it to packages/sim-backends/src/renode/boards.ts (pins, platform, console UART).`);
      }
      const be = createRenodeBackend({ board: board.type, ...opts.renode, ...(opts.labels ? { labels: opts.labels } : {}) });
      opts.onProcess?.(be);
      return withPinMap(be, board.mcu.pinMap);
    }
    return inProcessFactory(board);
  };
}

/** The default server-side factory (no labels). */
export const nodeBackendFactory: BackendFactory = createNodeBackendFactory();

export { QemuEspBackend, EmulatorError, explainEmulatorLog } from "./qemu-esp/backend.ts";
export { QEMU_ESP_IMAGE, EMULATOR_LABEL, OWNER_LABEL, boardMac, qemuImageAvailable, qemuPreflight, qemuRuntime } from "./qemu-esp/launcher.ts";
export type { QemuNetwork } from "./qemu-esp/launcher.ts";
export { RENODE_IMAGE, renodeRuntime, renodeUnavailable } from "./renode/launcher.ts";
export { fabwrightHome, runtimeSetting, probeDocker, resetDockerProbe, pickRuntime, dockerProbeMs, NATIVE_QEMU_TAG, RENODE_VERSION, nativeQemuDir, nativeQemuBinary, nativeQemuInstalled, nativeRenodeDir, nativeRenodeBinary, nativeRenodeInstalled, fabwrightRenodeBinary } from "./runtime.ts";
export type { Runtime, RuntimeSetting, DockerProbe } from "./runtime.ts";
