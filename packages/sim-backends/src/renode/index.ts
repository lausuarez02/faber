// Renode backend (round 9 spike): STM32 / nRF52 boards run in Renode (MIT) inside the
// jumper/renode Docker image. Node-only (sockets, worker threads, docker): import it from
// "@jumper/sim-backends/renode", never from the browser bundle.
export { RENODE_BOARDS, renodeBoardOf } from "./boards.ts";
export type { RenodeBoard, RenodeBoardType, RenodePin } from "./boards.ts";
export { Command, ExternalControlClient, ExternalControlError } from "./external-control.ts";
export type { GpioEvent } from "./external-control.ts";
export { dockerAvailable, reapRenodeContainers, RENODE_IMAGE, RenodeMachine } from "./machine.ts";
export type { PinEdge, RenodeMachineOptions } from "./machine.ts";
export { RenodeMonitor } from "./monitor.ts";
export { createRenodeBackend } from "./backend.ts";
export type { RenodeBackend, RenodeBackendOptions } from "./backend.ts";
