import type { BackendFactory, McuBackend } from "@fabwright/sim-core";
import { createAvrBackend } from "./avr.ts";
import { boardTypeOf, type BoardType } from "./pins.ts";
import { createRp2040Backend, rp2040BoardOf } from "./rp2040/index.ts";
import { withPinMap } from "./pinmap.ts";

export { AVR_BACKEND_FACTS, createAvrBackend } from "./avr.ts";
export type { AvrBackendOptions } from "./avr.ts";
export { boardPinMap, boardTypeOf } from "./pins.ts";
export type { BoardPin, BoardType } from "./pins.ts";
export * from "./rp2040/index.ts";
export { withPinMap } from "./pinmap.ts";

/** A ready backend for a known board ("uno"/"arduino-uno", "nano"/"arduino-nano"): ATmega328P, 16 MHz, 5 V. */
export function createBackend(boardType: BoardType | string): McuBackend {
  const board = boardTypeOf(boardType);
  if (!board) throw new Error(`no simulator backend for board type '${boardType}' (supported: uno, nano)`);
  return createAvrBackend({ chip: "atmega328p", clockHz: 16_000_000, vcc: 5, board });
}

/**
 * Picks an in-process backend from the board's part.json `mcu.backend` ("avr8js" → createAvrBackend,
 * "rp2040js" → createRp2040Backend). Safe in the browser. Process backends (qemu-esp, renode) need the
 * Fabwright server: use `nodeBackendFactory` from "@fabwright/sim-backends/node" there.
 */
export const backendFactory: BackendFactory = (board) => withPinMap(inProcessBackend(board), board.mcu.pinMap);

function inProcessBackend(board: Parameters<BackendFactory>[0]): McuBackend {
  if (board.mcu.backend === "avr8js") {
    if (board.mcu.chip.toLowerCase() !== "atmega328p") {
      throw new Error(`board '${board.partId}' (${board.type}) asks for chip '${board.mcu.chip}', but the avr8js backend only supports atmega328p in M0`);
    }
    return createAvrBackend({
      chip: "atmega328p",
      clockHz: board.mcu.clockHz,
      vcc: board.mcu.vcc,
      board: boardTypeOf(board.type) ?? "uno",
    });
  }
  if (board.mcu.backend === "rp2040js") {
    const rp = rp2040BoardOf(board.type);
    if (board.mcu.chip.toLowerCase() !== "rp2040" || !rp) {
      throw new Error(`board '${board.partId}' (${board.type}) asks for the rp2040js backend, but it only knows the RP2040 boards raspberry-pi-pico, seeed-xiao-rp2040 and waveshare-rp2040-zero (chip 'rp2040'). Fix: use one of those part types, or add the board to packages/sim-backends/src/rp2040/boards.ts.`);
    }
    return createRp2040Backend({ board: rp.type, clockHz: board.mcu.clockHz, vcc: board.mcu.vcc });
  }
  if (board.mcu.backend === "qemu-esp" || board.mcu.backend === "renode") {
    throw new Error(`board '${board.partId}' (${board.type}, ${board.mcu.chip}) runs in a local emulator (${board.mcu.backend === "qemu-esp" ? "Espressif QEMU" : "Renode"}) on your computer, not in the browser. Fix: open the project from \`fabwright serve\` (pnpm start) and press Run there (this page then shows that run), or ask your agent to run it.`);
  }
  throw new Error(`no simulator backend '${board.mcu.backend}' for board '${board.partId}' (${board.type})`);
}
