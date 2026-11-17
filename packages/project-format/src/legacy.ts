// Fabwright was called Jumper until November 2026. Everything that still reads the old names is
// named here, so the rest of the code uses the new names only (docs/migrating-from-jumper.md).
// Browser-safe: no node imports (the file-system lookups are in ./node.ts).

/** The project file a new project gets. */
export const PROJECT_FILE = "fabwright.json";
/** The project file projects made before the rename have. Still read, and written back in place. */
export const LEGACY_PROJECT_FILE = "jumper.json";
/** A project's own state folder (action log, thumbnails, media, run audio). */
export const STATE_DIR = ".fabwright";
/** The state folder of projects made before the rename. Still used when it is the one there. */
export const LEGACY_STATE_DIR = ".jumper";
/** The per-user folder under the home directory (projects registry, native toolchains, emulators). */
export const HOME_DIR = ".fabwright";
/** The per-user folder before the rename (it holds gigabytes of installed toolchains: still used when it is the one there). */
export const LEGACY_HOME_DIR = ".jumper";
/** The `format` value of project files written before the rename; read as the current version. */
export const LEGACY_FORMAT_VERSIONS: readonly string[] = ["jumper/1"];

export const ENV_PREFIX = "FABWRIGHT_";
export const LEGACY_ENV_PREFIX = "JUMPER_";

/**
 * Copies every JUMPER_<NAME> variable to FABWRIGHT_<NAME> when FABWRIGHT_<NAME> is not set, so
 * scripts and shells that still export the old names keep working (the new name wins when both
 * are set). Child processes inherit the result. Returns the names it filled in.
 */
export function applyLegacyEnv(env: Record<string, string | undefined>): string[] {
  const filled: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX)) continue;
    const name = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
    if (env[name] !== undefined || env[key] === undefined) continue;
    env[name] = env[key];
    filled.push(name);
  }
  return filled;
}

/** A project file's content with a pre-rename `format` ("jumper/1") read as the current one. */
export function upgradeLegacyFormat<T>(data: T, current: string): T {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const format = (data as { format?: unknown }).format;
    if (typeof format === "string" && LEGACY_FORMAT_VERSIONS.includes(format)) return { ...data, format: current };
  }
  return data;
}

/** The simulated Wi-Fi network's default name. */
export const SANDBOX_SSID = "FabwrightNet";
/** Its name before the rename: firmware that joins "JumperNet" still joins the default network. */
export const LEGACY_SANDBOX_SSID = "JumperNet";

/** Sandbox host names firmware may still call by their pre-rename names → the current name. */
export const LEGACY_SANDBOX_HOSTS: Readonly<Record<string, string>> = {
  "ai.jumper": "ai.fabwright",
  "relay.sandbox.jumper": "relay.sandbox.fabwright",
};

/** A sandbox host name with a pre-rename name ("ai.jumper") read as the current one; others unchanged (lower case). */
export function currentSandboxHost(host: string): string {
  const h = host.toLowerCase();
  return LEGACY_SANDBOX_HOSTS[h] ?? h;
}

/** Does the SSID the firmware asked for name the access point `apSsid` (also "JumperNet" for the default network)? */
export function ssidMatches(asked: string, apSsid: string): boolean {
  return asked === apSsid || (asked === LEGACY_SANDBOX_SSID && apSsid === SANDBOX_SSID);
}
