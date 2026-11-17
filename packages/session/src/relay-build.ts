// Round 13: what a build adds for the API relay. A sketch that includes FabwrightRelay.h gets the header
// (when its folder has none) and, in a simulation build, a fabwright_device.h that points at the sandbox
// relay with the simulation token. The person's own fabwright_device.h (their relay token and Wi-Fi
// password) is never compiled by Fabwright (the runner drops it), so the factory pack and the build kit
// firmware never carry it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_HEADER, parseNetworkConfig, RELAY_HEADER, RELAY_HEADER_SOURCE, simDeviceHeader, type NetworkConfig } from "@fabwright/device-net";
import type { Project } from "@fabwright/project-format";

const INCLUDES_RELAY = /#\s*include\s*[<"]FabwrightRelay\.h[>"]/;

export function sketchUsesRelay(sketchDir: string): boolean {
  if (!existsSync(sketchDir)) return false;
  for (const f of readdirSync(sketchDir)) {
    if (!/\.(ino|cpp|c|h|hpp)$/.test(f) || f === RELAY_HEADER || f === DEVICE_HEADER) continue;
    try {
      if (INCLUDES_RELAY.test(readFileSync(join(sketchDir, f), "utf8"))) return true;
    } catch {
      // unreadable file: not ours to judge
    }
  }
  return false;
}

function configOf(project: Project): NetworkConfig {
  try {
    return parseNetworkConfig(project.network ?? {});
  } catch {
    return parseNetworkConfig({});
  }
}

export function relayBuildSources(project: Project, sketchDir: string, purpose: "simulator" | "device"): { extraSources?: Record<string, string> } {
  if (!sketchUsesRelay(sketchDir)) return {};
  const extra: Record<string, string> = {};
  if (!existsSync(join(sketchDir, RELAY_HEADER))) extra[RELAY_HEADER] = RELAY_HEADER_SOURCE();
  if (purpose === "simulator") extra[DEVICE_HEADER] = simDeviceHeader(configOf(project));
  return Object.keys(extra).length ? { extraSources: extra } : {};
}
