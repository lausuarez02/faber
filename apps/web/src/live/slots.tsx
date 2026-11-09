import type { ComponentType } from "react";
import { LiveControls } from "../interact/LiveControls.tsx";

/**
 * Round 5, track "live" (owner): components the app shell mounts (decision 0003, C8).
 * stage  = inside <main class="stage"> above the canvas (interaction overlays, IMU control, sliders)
 * chrome = top level, above the floating chrome (agent pill popovers, run-why messages)
 */
export const liveStage: ComponentType[] = [LiveControls];
export const liveChrome: ComponentType[] = [];
