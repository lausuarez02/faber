// Round 13: what a build adds for the API relay. A sketch that includes FabwrightRelay.h gets the header
// (when its folder has none) and, in a simulation build, a fabwright_device.h that points at the sandbox
// relay with the simulation token. The person's own fabwright_device.h (their relay token and Wi-Fi
// password) is never compiled by Fabwright (the runner drops it), so the factory pack and the build kit
// firmware never carry it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_HEADER, LEGACY_DEVICE_HEADER, LEGACY_RELAY_HEADER, LEGACY_RELAY_HEADER_SOURCE, parseNetworkConfig, RELAY_HEADER, RELAY_HEADER_SOURCE, simDeviceHeader, simLegacyDeviceHeader, type NetworkConfig } from "@fabwright/device-net";
import type { Project } from "@fabwright/project-format";

const INCLUDES_RELAY = /#\s*include\s*[<"]FabwrightRelay\.h[>"]/;
/** A sketch written before the rename from Jumper includes the relay header by its old name. */
const INCLUDES_LEGACY_RELAY = /#\s*include\s*[<"]JumperRelay\.h[>"]/;
const OWN_HEADERS = new Set([RELAY_HEADER, DEVICE_HEADER, LEGACY_RELAY_HEADER, LEGACY_DEVICE_HEADER]);

/** Which relay header names the sketch includes (none: it does not use the relay). */
export function relayIncludes(sketchDir: string): { current: boolean; legacy: boolean } {
  const out = { current: false, legacy: false };
  if (!existsSync(sketchDir)) return out;
  for (const f of readdirSync(sketchDir)) {
    if (!/\.(ino|cpp|c|h|hpp)$/.test(f) || OWN_HEADERS.has(f)) continue;
    try {
      const text = readFileSync(join(sketchDir, f), "utf8");
      if (INCLUDES_RELAY.test(text)) out.current = true;
      if (INCLUDES_LEGACY_RELAY.test(text)) out.legacy = true;
    } catch {
      // unreadable file: not ours to judge
    }
  }
  return out;
}

export function sketchUsesRelay(sketchDir: string): boolean {
  const i = relayIncludes(sketchDir);
  return i.current || i.legacy;
}

function configOf(project: Project): NetworkConfig {
  try {
    return parseNetworkConfig(project.network ?? {});
  } catch {
    return parseNetworkConfig({});
  }
}

export function relayBuildSources(project: Project, sketchDir: string, purpose: "simulator" | "device"): { extraSources?: Record<string, string> } {
  const uses = relayIncludes(sketchDir);
  if (!uses.current && !uses.legacy) return {};
  const extra: Record<string, string> = {};
  // A pre-rename sketch's JumperRelay.h is its own copy when the folder has one, else the forwarding header.
  if (uses.legacy && !existsSync(join(sketchDir, LEGACY_RELAY_HEADER))) extra[LEGACY_RELAY_HEADER] = LEGACY_RELAY_HEADER_SOURCE();
  if (!existsSync(join(sketchDir, RELAY_HEADER))) extra[RELAY_HEADER] = RELAY_HEADER_SOURCE();
  if (purpose === "simulator") {
    extra[DEVICE_HEADER] = simDeviceHeader(configOf(project));
    // An old copy of JumperRelay.h in the folder reads jumper_device.h: give it the simulation's values too.
    if (uses.legacy) extra[LEGACY_DEVICE_HEADER] = simLegacyDeviceHeader(configOf(project));
  }
  return Object.keys(extra).length ? { extraSources: extra } : {};
}
