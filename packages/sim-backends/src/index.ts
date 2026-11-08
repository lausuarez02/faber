import type { BackendFactory, McuBackend } from "@jumper/sim-core";
import { createAvrBackend } from "./avr.ts";
import { boardTypeOf, type BoardType } from "./pins.ts";

export { createAvrBackend } from "./avr.ts";
export type { AvrBackendOptions } from "./avr.ts";
export { boardPinMap, boardTypeOf } from "./pins.ts";
export type { BoardPin, BoardType } from "./pins.ts";

/** A ready backend for a known board ("uno"/"arduino-uno", "nano"/"arduino-nano"): ATmega328P, 16 MHz, 5 V. */
export function createBackend(boardType: BoardType | string): McuBackend {
  const board = boardTypeOf(boardType);
  if (!board) throw new Error(`no simulator backend for board type '${boardType}' (supported: uno, nano)`);
  return createAvrBackend({ chip: "atmega328p", clockHz: 16_000_000, vcc: 5, board });
}

/** Picks a backend from the board's part.json `mcu.backend` ("avr8js" → createAvrBackend). */
export const backendFactory: BackendFactory = (board) => {
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
  throw new Error(`no simulator backend '${board.mcu.backend}' for board '${board.partId}' (${board.type})`);
};
