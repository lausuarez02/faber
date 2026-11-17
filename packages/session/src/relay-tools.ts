// Round 13: the API relay from a project: `fabwright relay init | serve | token | device-header`, the
// factory pack's relay/ folder and the build kit's Connect section use these. Device tokens and Wi-Fi
// credentials live only in the project's git-ignored .env and the person's own device build.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  DEVICE_HEADER,
  deviceHeader,
  deviceTokensWith,
  loadSecrets,
  newDeviceToken,
  parseDeviceTokens,
  parseDotEnv,
  RELAY_ENV,
  RELAY_HEADER,
  RELAY_HEADER_SOURCE,
  relayPack,
  relaySpecFrom,
  setEnvVar,
  startRelay,
  type NetworkConfig,
  type RelaySpec,
} from "@fabwright/device-net";
import type { Project } from "@fabwright/project-format";
import { networkConfigOf } from "./device-network.ts";
import { fail } from "./errors.ts";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export interface RelayProject {
  dir: string;
  project: Project;
}

function envFile(p: RelayProject): string {
  return join(p.dir, ".env");
}

function readEnv(p: RelayProject): { text: string; vars: Record<string, string> } {
  const f = envFile(p);
  const text = existsSync(f) ? readFileSync(f, "utf8") : "";
  return { text, vars: parseDotEnv(text) };
}

/** Make sure the project's .gitignore keeps .env and fabwright_device.h out of git. Returns what it added. */
export function ensureSecretsIgnored(dir: string): string[] {
  const f = join(dir, ".gitignore");
  const have = existsSync(f) ? readFileSync(f, "utf8") : "";
  const lines = new Set(have.split(/\r?\n/).map((l) => l.trim()));
  const want = [".env", DEVICE_HEADER].filter((w) => !lines.has(w) && !lines.has(`/${w}`) && !(w === DEVICE_HEADER && lines.has(`**/${w}`)));
  if (want.length) writeFileSync(f, `${have}${have && !have.endsWith("\n") ? "\n" : ""}# device secrets (relay token, Wi-Fi password, API keys): never committed\n${want.join("\n")}\n`);
  return want;
}

export function relayConfigOf(p: RelayProject): { config: NetworkConfig; spec: RelaySpec } {
  const config = networkConfigOf(p.project);
  return { config, spec: relaySpecFrom(config, p.project.name) };
}

/** Write relay/ (Node server, Cloudflare Worker, README, firmware header) into `out` (default <project>/relay). */
export function writeRelayFolder(p: RelayProject, out = join(p.dir, "relay")): { dir: string; files: string[] } {
  const { config } = relayConfigOf(p);
  if (!config.allow.length) {
    fail("no-relay-hosts", "There is nothing for a relay to call yet", "fabwright.json network.allow lists no host, and the relay only calls hosts on that list", 'set_network {"allow": [{"host": "api.example.com", "secrets": ["API_KEY"], "headers": {"Authorization": "Bearer {{secret:API_KEY}}"}}], "secrets": ["API_KEY"]} (names only), then fabwright relay init again');
  }
  const files = relayPack(config, p.project.name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), text);
  }
  return { dir: out, files: Object.keys(files).sort() };
}

/** Add (or replace) a device token: raw value → .env DEVICE_TOKEN (for flashing), hash → .env RELAY_DEVICE_TOKENS. */
export function relayTokenAdd(p: RelayProject, name: string): { name: string; token: string; devices: string[]; env: string; ignored: string[] } {
  if (!NAME_RE.test(name)) fail("bad-arg", `'${name}' is not a device name`, "device names are 1 to 40 letters, digits, '-', '_' or '.' (they show in the relay's logs)", "fabwright relay token add star-1");
  const { text, vars } = readEnv(p);
  const { token, hash } = newDeviceToken();
  let next = setEnvVar(text, RELAY_ENV.tokens, deviceTokensWith(vars[RELAY_ENV.tokens], name, hash));
  next = setEnvVar(next, RELAY_ENV.deviceToken, token);
  writeFileSync(envFile(p), next);
  const ignored = ensureSecretsIgnored(p.dir);
  return { name, token, devices: parseDeviceTokens(parseDotEnv(next)[RELAY_ENV.tokens]).map((d) => d.name), env: envFile(p), ignored };
}

export function relayTokenRevoke(p: RelayProject, name: string): { name: string; devices: string[]; removed: boolean } {
  const { text, vars } = readEnv(p);
  const before = parseDeviceTokens(vars[RELAY_ENV.tokens]);
  if (!before.some((d) => d.name === name)) fail("no-device", `No device token named '${name}'`, `the project's .env has ${before.length ? before.map((d) => d.name).join(", ") : "no device tokens"}`, "fabwright relay token list shows them");
  const v = deviceTokensWith(vars[RELAY_ENV.tokens], name, undefined);
  writeFileSync(envFile(p), setEnvVar(text, RELAY_ENV.tokens, v || undefined));
  return { name, devices: parseDeviceTokens(v).map((d) => d.name), removed: true };
}

export function relayTokenList(p: RelayProject): string[] {
  return parseDeviceTokens(readEnv(p).vars[RELAY_ENV.tokens]).map((d) => d.name);
}

/** The sketch folder (where fabwright_device.h goes). */
export function sketchDirOf(p: RelayProject): string {
  const sketch = p.project.firmware?.sketch;
  if (!sketch) fail("no-sketch", "The project has no sketch yet", "fabwright_device.h goes next to the sketch, and firmware.sketch is not set", 'write the sketch first (write_file "firmware/main.ino")');
  // firmware.sketch is relative to firmware/ (session.firmwareInfo does the same)
  return dirname(join(p.dir, "firmware", sketch));
}

/** Write <sketch folder>/fabwright_device.h from .env (RELAY_URL, DEVICE_TOKEN, WIFI_SSID, WIFI_PASSWORD), and FabwrightRelay.h when missing. */
export function writeDeviceHeader(p: RelayProject, o: { ca?: string } = {}): { file: string; relay_url: string; wifi_ssid: string; added_header: boolean; ignored: string[] } {
  const { vars } = readEnv(p);
  const env = { ...vars, ...process.env } as Record<string, string | undefined>;
  const missing = [RELAY_ENV.url, RELAY_ENV.deviceToken, RELAY_ENV.wifiSsid].filter((k) => !env[k]);
  if (missing.length) {
    fail(
      "relay-env-missing",
      `Cannot write ${DEVICE_HEADER}: ${missing.join(", ")} not set`,
      `the device header is made from the project's .env (${envFile(p)}), and it has no ${missing.join(", ")}`,
      [
        missing.includes(RELAY_ENV.deviceToken) ? "fabwright relay token add <device name> (writes DEVICE_TOKEN)" : "",
        missing.includes(RELAY_ENV.url) ? "RELAY_URL=https://<your relay> in .env (the Worker's workers.dev address, or http://<computer>:8787 for fabwright relay serve)" : "",
        missing.includes(RELAY_ENV.wifiSsid) ? "WIFI_SSID=... and WIFI_PASSWORD=... in .env (your 2.4 GHz Wi-Fi)" : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
  let rootCa: string | undefined;
  if (o.ca) {
    if (!existsSync(o.ca)) fail("bad-arg", `--ca ${o.ca} does not exist`, "it should be the PEM file of the relay's root certificate", "export it from the browser (padlock → certificate → root → export PEM), or leave --ca out to use the bundled public roots");
    rootCa = readFileSync(o.ca, "utf8");
    if (!rootCa.includes("BEGIN CERTIFICATE")) fail("bad-arg", `--ca ${o.ca} is not a PEM certificate`, "it has no -----BEGIN CERTIFICATE----- block", "pass the root certificate as PEM text");
  }
  const dir = sketchDirOf(p);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, DEVICE_HEADER);
  writeFileSync(file, deviceHeader({ relayUrl: env[RELAY_ENV.url]!, token: env[RELAY_ENV.deviceToken]!, ssid: env[RELAY_ENV.wifiSsid]!, password: env[RELAY_ENV.wifiPassword] ?? "", ...(rootCa ? { rootCa } : {}) }));
  let added = false;
  if (!existsSync(join(dir, RELAY_HEADER))) {
    writeFileSync(join(dir, RELAY_HEADER), RELAY_HEADER_SOURCE());
    added = true;
  }
  return { file, relay_url: env[RELAY_ENV.url]!, wifi_ssid: env[RELAY_ENV.wifiSsid]!, added_header: added, ignored: ensureSecretsIgnored(p.dir) };
}

/** Run the relay on this computer with the project's config and .env. */
export async function serveRelay(p: RelayProject, o: { port?: number; host?: string; log?: (e: Record<string, unknown>) => void } = {}) {
  const { config, spec } = relayConfigOf(p);
  if (!config.allow.length) fail("no-relay-hosts", "There is nothing for a relay to call yet", "fabwright.json network.allow lists no host", 'set_network {"allow": [{"host": "api.example.com"}]}, then try again');
  const { vars } = readEnv(p);
  const env = { ...vars, ...process.env } as Record<string, string | undefined>;
  const secrets = loadSecrets(config.secrets, { envFile: envFile(p) });
  const server = await startRelay({ spec, env, port: o.port ?? 8787, host: o.host ?? "0.0.0.0", ...(o.log ? { log: o.log } : {}) });
  return { ...server, spec, missing_secrets: secrets.missing, devices: parseDeviceTokens(env[RELAY_ENV.tokens]).map((d) => d.name) };
}

export function relativeTo(dir: string, file: string): string {
  return relative(dir, file) || ".";
}
