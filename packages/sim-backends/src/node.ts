// Backends for Node (jumper serve, MCP, CLI, tests): everything the browser has, plus the backends
// that run an emulator in another process (Renode, in Docker). Never import this from the browser.
import type { BackendFactory } from "@jumper/sim-core";
import { backendFactory } from "./index.ts";
import { createRenodeBackend, renodeBoardOf } from "./renode/index.ts";

/** Process backends this factory adds to the in-process ones. */
export const PROCESS_BACKENDS = ["renode"] as const;

export const nodeBackendFactory: BackendFactory = (board) => {
  if (board.mcu.backend === "renode") {
    if (!renodeBoardOf(board.type)) {
      throw new Error(`board '${board.partId}' (${board.type}) asks for the Renode backend, but Renode has no board data for '${board.type}'. Fix: add it to packages/sim-backends/src/renode/boards.ts (pins, platform, console UART).`);
    }
    return createRenodeBackend({ board: board.type });
  }
  return backendFactory(board);
};
