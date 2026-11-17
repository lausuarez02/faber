// Renode backend (round 10): STM32 and nRF52840 boards run in Renode (MIT) inside the faber/renode
// Docker image, bridged to Faber's parts by platforms/FaberBridge.cs. Node-only (sockets, worker
// threads, docker): import it from "@faber/sim-backends/renode", never from the browser bundle.
export { RENODE_BOARDS, renodeBoardOf, renodeBusPins } from "./boards.ts";
export type { RenodeBoard, RenodeBoardType, RenodePin } from "./boards.ts";
export { bundleCSharp, createRenodeBackend, RENODE_CAPABILITIES, RenodeBackend } from "./backend.ts";
export type { RenodeBackendOptions } from "./backend.ts";
export { launchRenode, PLATFORMS_DIR, reapRenodeContainers, RENODE_IMAGE, renodeAvailable, renodeUnavailable } from "./launcher.ts";
export { Command, ExternalControlClient, ExternalControlError } from "./external-control.ts";
export type { GpioEvent } from "./external-control.ts";
export { RenodeMonitor } from "./monitor.ts";
