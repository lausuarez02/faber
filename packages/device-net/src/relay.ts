// Round 13, the API relay: what a REAL device uses to reach APIs without any key in its firmware,
// generated from the project's network config (fabwright.json "network": allow list, secrets by NAME,
// header templates, relay limits). Generic: nothing here knows which API or what the device does.
//
// - relaySpecFrom: the relay's config (no values), the same rules the simulator's sandbox relay uses.
// - relayPack: the files of relay/ (Node server, Cloudflare Worker, the shared core, README, the
//   firmware header), MIT, for the factory pack, the build kit and `fabwright relay init`.
// - device tokens: generated here, stored only in the person's .env (raw for flashing, hash for the
//   relay), burned into their own device build through fabwright_device.h.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NetworkConfig } from "./config.ts";
import { DEFAULT_LIMITS, SIM_DEVICE_TOKEN, SIM_RELAY_URL, type RelaySpec } from "./relay/relay-core.mjs";

export { DEFAULT_LIMITS, SIM_DEVICE_TOKEN, SIM_RELAY_HOST, SIM_RELAY_URL, TOKEN_HEADER, RelayError, RateLimiter, authorize, findAllow, parseTarget, handleRelay, sha256Hex, parseDeviceTokens, limitsOf } from "./relay/relay-core.mjs";
export type { RelaySpec, RelayAllow, RelayLimits, RelayTarget } from "./relay/relay-core.mjs";
export { startRelay, parseDotEnv as parseRelayDotEnv } from "./relay/node-server.mjs";

/** The .env names the relay and the device build use. */
export const RELAY_ENV = {
  /** "name:sha256,name:sha256": the devices the relay accepts (hashes only). */
  tokens: "RELAY_DEVICE_TOKENS",
  /** The relay's address, for the device build (https://<name>.<account>.workers.dev, or http://<computer>:8787). */
  url: "RELAY_URL",
  /** The raw token of the device being flashed next (only in .env and that device's flash). */
  deviceToken: "DEVICE_TOKEN",
  wifiSsid: "WIFI_SSID",
  wifiPassword: "WIFI_PASSWORD",
} as const;

/** The header file a device build includes; git-ignored, never compiled by Fabwright's own builds. */
export const DEVICE_HEADER = "fabwright_device.h";
export const RELAY_HEADER = "FabwrightRelay.h";

/** Does the project reach any API the relay could serve (inspect hosts)? */
export function relayUseful(config: NetworkConfig): boolean {
  return config.allow.some((a) => a.tls !== "passthrough");
}

/** The relay's config: allow list, secret names, header templates and limits. No values. */
export function relaySpecFrom(config: NetworkConfig, project: string): RelaySpec {
  const r = config.relay ?? {};
  return {
    version: 1,
    project,
    allow: config.allow
      .filter((a) => a.tls !== "passthrough")
      .map((a) => ({ host: a.host, ...(a.ports ? { ports: a.ports } : {}), ...(a.secrets?.length ? { secrets: a.secrets } : {}), ...(a.headers && Object.keys(a.headers).length ? { headers: a.headers } : {}), ...(a.to ? { to: a.to } : {}) })),
    secrets: [...config.secrets],
    limits: {
      requests_per_minute: r.requests_per_minute ?? DEFAULT_LIMITS.requests_per_minute,
      max_request_bytes: (r.max_request_kb ?? DEFAULT_LIMITS.max_request_bytes / 1024) * 1024,
      max_response_bytes: (r.max_response_kb ?? DEFAULT_LIMITS.max_response_bytes / 1024) * 1024,
      max_stream_seconds: r.max_stream_seconds ?? DEFAULT_LIMITS.max_stream_seconds,
    },
    direct: config.allow.filter((a) => a.tls === "passthrough").map((a) => ({ host: a.host, ...(a.ports ? { ports: a.ports } : {}) })),
  };
}

function own(rel: string): string {
  return readFileSync(new URL(`./relay/${rel}`, import.meta.url), "utf8");
}

/** A new device token: the raw value (for the device) and its SHA-256 (for the relay). */
export function newDeviceToken(): { token: string; hash: string } {
  const token = `jdt_${randomBytes(24).toString("base64url")}`;
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

/** RELAY_DEVICE_TOKENS with `name` set to `hash` (or removed when hash is undefined). */
export function deviceTokensWith(current: string | undefined, name: string, hash: string | undefined): string {
  const items = (current ?? "")
    .split(/[,\s]+/)
    .filter(Boolean)
    .filter((s) => s.slice(0, s.lastIndexOf(":")) !== name);
  if (hash) items.push(`${name}:${hash}`);
  return items.join(",");
}

/** .env text with KEY set (or removed when value is undefined); other lines and comments are kept. */
export function setEnvVar(text: string, key: string, value: string | undefined): string {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const i = lines.findIndex((l) => re.test(l));
  const line = value === undefined ? undefined : `${key}=${/[\s#"']/.test(value) ? JSON.stringify(value) : value}`;
  if (i >= 0) {
    if (line === undefined) lines.splice(i, 1);
    else lines[i] = line;
  } else if (line !== undefined) {
    if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, line);
    else lines.push(line);
  }
  let out = lines.join("\n");
  if (out && !out.endsWith("\n")) out += "\n";
  return out;
}

const cstr = (s: string) => JSON.stringify(s).replace(/\?\?/g, "?\\?");

/** fabwright_device.h for the simulation build: the sandbox relay and the simulation token. */
export function simDeviceHeader(config: NetworkConfig): string {
  return [
    "// Added by Fabwright to the simulation build only (not in your project): the simulator plays the relay.",
    `#define FABWRIGHT_RELAY_URL ${cstr(SIM_RELAY_URL)}`,
    `#define FABWRIGHT_DEVICE_TOKEN ${cstr(SIM_DEVICE_TOKEN)}`,
    `#define FABWRIGHT_WIFI_SSID ${cstr(config.wifi?.ssid ?? "FabwrightNet")}`,
    `#define FABWRIGHT_WIFI_PASSWORD ${cstr(config.wifi?.password ?? "")}`,
    "",
  ].join("\n");
}

/** fabwright_device.h for the person's own device: from their .env. Contains a token and a Wi-Fi password: git-ignored. */
export function deviceHeader(o: { relayUrl: string; token: string; ssid?: string; password?: string; rootCa?: string }): string {
  const ca = o.rootCa?.trim()
    ? `#define FABWRIGHT_RELAY_ROOT_CA \\\n${o.rootCa
        .trim()
        .split(/\r?\n/)
        .map((l) => `  ${cstr(`${l}\n`)}`)
        .join(" \\\n")}\n`
    : "";
  return [
    "// Your device's relay settings, written by `fabwright relay device-header` from the project's .env.",
    "// SECRET: it holds this device's token and your Wi-Fi password. It is git-ignored; never commit or",
    "// share it. Fabwright's own builds (simulator, factory pack, build kit) never compile it.",
    "#pragma once",
    `#define FABWRIGHT_RELAY_URL ${cstr(o.relayUrl.replace(/\/+$/, ""))}`,
    `#define FABWRIGHT_DEVICE_TOKEN ${cstr(o.token)}`,
    `#define FABWRIGHT_WIFI_SSID ${cstr(o.ssid ?? "")}`,
    `#define FABWRIGHT_WIFI_PASSWORD ${cstr(o.password ?? "")}`,
    ca,
  ].join("\n");
}

export const RELAY_HEADER_SOURCE = (): string => own(`firmware/${RELAY_HEADER}`);

const MIT = (year: number) => `MIT License

Copyright (c) ${year} Fabwright Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

export function relaySlug(project: string): string {
  return (
    project
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "device"
  );
}

/** Worst case per device and day, from the rate limit: what a runaway device could cost. */
export function worstCaseCallsPerDay(spec: RelaySpec): number {
  return spec.limits.requests_per_minute * 60 * 24;
}

/** The relay/ folder: path (inside relay/) → text. Everything MIT; no secret values. */
export function relayPack(config: NetworkConfig, project: string): Record<string, string> {
  const spec = relaySpecFrom(config, project);
  const slug = relaySlug(project);
  const files: Record<string, string> = {};
  files["relay.config.mjs"] = `// Generated by Fabwright from fabwright.json "network" (${project}). Regenerate with: fabwright relay init\n// Names only: the values live on the relay (.env, or wrangler secret put NAME). MIT License.\nexport default ${JSON.stringify(spec, null, 2)};\n`;
  files["relay-core.mjs"] = own("relay-core.mjs");
  files["server.mjs"] = own("node-server.mjs");
  files["worker.js"] = own("worker.mjs");
  files["wrangler.toml"] = `# Cloudflare Worker for ${project}'s API relay. Deploy: npx wrangler deploy (see README.md).\nname = "${slug}-relay"\nmain = "worker.js"\ncompatibility_date = "2026-11-01"\n\n# No values here. Set each one as a secret (encrypted, never in this file):\n#   npx wrangler secret put ${RELAY_ENV.tokens}\n${spec.secrets.map((n) => `#   npx wrangler secret put ${n}\n`).join("")}`;
  files["package.json"] = `${JSON.stringify({ name: `${slug}-relay`, private: true, version: "1.0.0", license: "MIT", type: "module", description: `API relay for ${project}: devices call it with a device token; it adds the API keys and calls only the allowed hosts.`, engines: { node: ">=20" }, scripts: { start: "node server.mjs", deploy: "wrangler deploy" } }, null, 2)}\n`;
  files[".env.example"] = [
    "# Copy to .env (git-ignored) for `node server.mjs`. For Cloudflare use wrangler secret put instead.",
    `# ${RELAY_ENV.tokens}: from \`fabwright relay token add <device name>\` (hashes only, comma separated)`,
    `${RELAY_ENV.tokens}=`,
    ...spec.secrets.map((n) => `${n}=`),
    "",
  ].join("\n");
  files[".gitignore"] = ".env\n.dev.vars\nnode_modules/\n.wrangler/\n";
  files["LICENSE"] = MIT(new Date().getUTCFullYear());
  files["firmware/FabwrightRelay.h"] = own(`firmware/${RELAY_HEADER}`);
  files["firmware/fabwright_device.example.h"] = deviceHeader({ relayUrl: "https://<your relay>", token: "<from fabwright relay token add>", ssid: "<your Wi-Fi>", password: "<your Wi-Fi password>" }).replace("#pragma once", "#pragma once\n// EXAMPLE: copy to your sketch folder as fabwright_device.h, or run `fabwright relay device-header`.");
  files["README.md"] = relayReadme(spec, slug);
  return files;
}

function relayReadme(spec: RelaySpec, slug: string): string {
  const hosts = spec.allow.map((a) => `| ${a.host} | ${(a.ports ?? [443, 80]).join(", ")} | ${a.secrets?.join(", ") || "none"} | ${Object.keys(a.headers ?? {}).join(", ") || "none"} | ${a.to ? `\`${a.to}\`` : "the host itself"} |`);
  const routed = spec.allow.filter((a) => a.to);
  const l = spec.limits;
  const perDay = worstCaseCallsPerDay(spec);
  return `# API relay: ${spec.project}

Your device never holds an API key. It calls this relay with its own **device token**; the relay checks
the token, calls only the hosts below, adds the keys it holds, and streams the answer back.

\`\`\`
device ── https://<relay>/<api host>/<path> + X-Device-Token ──▶ relay ── + API key ──▶ https://<api host>/<path>
\`\`\`

- A device token reaches only this relay, and the relay reaches only these hosts. Lose a device: revoke
  its token (\`fabwright relay token revoke <name>\`, then update ${RELAY_ENV.tokens} on the relay). The API
  keys stay where they are.
- The relay keeps only SHA-256 hashes of device tokens. Logs (one JSON line per request) never contain a
  key, a token or query values: secrets show as \`[secret:NAME]\`.
- Same rules as Fabwright's simulator, which plays this relay at \`${SIM_RELAY_URL}\`: firmware that works
  there gets the same answers (and the same refusals) here.

| Host | Ports | Keys it receives | Headers the relay adds | Sent to |
| --- | --- | --- | --- | --- |
${hosts.join("\n") || "| (none: add hosts to network.allow in fabwright.json, then fabwright relay init) | | | | |"}
${routed.length ? `\n**Sent to**: the device keeps calling ${routed.map((a) => a.host).join(", ")}; the relay sends those requests to the address in the last column (\`to\` in relay.config.mjs, from fabwright.json). An address on 127.0.0.1 or your home network works only when the relay runs on that computer or network (2a); a relay in the cloud (2b) needs the service's public https URL there instead.\n` : ""}${spec.direct?.length ? `\nNot relayed (TLS passthrough; the device calls them directly): ${spec.direct.map((d) => d.host).join(", ")}.\n` : ""}
Limits per device: ${l.requests_per_minute} requests a minute, requests up to ${Math.round(l.max_request_bytes / 1024)} KiB,
answers and WebSocket streams up to ${Math.round(l.max_response_bytes / 1024)} KiB and ${l.max_stream_seconds} s
(fabwright.json \`network.relay\`; regenerate after changing them).

## 1. Make a device token

In the Fabwright project:

\`\`\`sh
fabwright relay token add ${slug}-1        # prints the token once; writes DEVICE_TOKEN and ${RELAY_ENV.tokens} to .env
\`\`\`

One token per device. \`fabwright relay token list\` shows them (names only); \`revoke\` removes one.

## 2a. Run it on a computer (home, a Raspberry Pi, any server)

Needs Node 20 or newer, nothing to install:

\`\`\`sh
cp .env.example .env     # fill in ${[RELAY_ENV.tokens, ...spec.secrets].join(", ")}
node server.mjs          # http://<this computer>:8787, PORT=... to change
\`\`\`

From the project you can also run \`fabwright relay serve\` (it reads the project's .env directly).
Plain \`http://\` is fine on your own Wi-Fi for trying it out; anything reachable from the internet
must be HTTPS (a reverse proxy with a certificate, or the Cloudflare option below).

## 2b. Deploy it to Cloudflare Workers

Free for hobby traffic (check Cloudflare's current plan limits). Needs a Cloudflare account:

\`\`\`sh
npx wrangler login
npx wrangler secret put ${RELAY_ENV.tokens}     # paste the value from the project's .env
${spec.secrets.map((n) => `npx wrangler secret put ${n}`).join("\n")}
npx wrangler deploy                    # prints https://${slug}-relay.<your account>.workers.dev
\`\`\`

Logs: \`npx wrangler tail\`. The rate limit is kept per Worker instance, so it is a guard against a
runaway device, not an exact quota.

## 3. Point the firmware at it

\`\`\`sh
# in the project's .env: RELAY_URL=https://${slug}-relay.<account>.workers.dev  WIFI_SSID=...  WIFI_PASSWORD=...
fabwright relay device-header [--ca relay-root.pem]
\`\`\`

That writes \`fabwright_device.h\` (git-ignored: it holds the token and the Wi-Fi password) and
\`FabwrightRelay.h\` into the sketch folder. Build and flash from that folder (Arduino IDE or
\`arduino-cli compile --upload\`). In the sketch:

\`\`\`cpp
#include "FabwrightRelay.h"
WiFi.begin(FABWRIGHT_WIFI_SSID, FABWRIGHT_WIFI_PASSWORD);
http.begin(client, fabwrightRelayUrl("${spec.allow[0]?.host ?? "api.example.com"}", "/v1/..."));
http.addHeader(FABWRIGHT_TOKEN_HEADER, FABWRIGHT_DEVICE_TOKEN);
\`\`\`

WebSocket clients take the relay apart with \`fabwrightRelayEndpoint(host, path)\` (host, port, tls, path).
HTTPS: set the relay's root CA (\`client.setCACert(FABWRIGHT_RELAY_ROOT_CA)\`, from \`--ca\`); never
\`setInsecure()\` outside a quick test.

The firmware file in Fabwright's factory pack and build kit has **no** token and no Wi-Fi password
(\`fabwrightRelayReady()\` is false there), so it is safe to share.

## What it costs

Each device request is one relay request plus one API call. The API's own price per call is usually
what matters: calls an hour x hours on x the provider's price per call. The rate limit caps the worst
case at ${perDay.toLocaleString("en-US")} calls a day per device (${l.requests_per_minute} a minute); lower
\`network.relay.requests_per_minute\` if that would be too expensive, and set a spending limit with the
API provider too.

## Not covered

- MQTT and other raw TCP protocols are not relayed (HTTP, chunked streams and WebSocket are); MQTT over
  WebSocket goes through like any WebSocket.
- Keys in a URL query or a request body are not filled in; use a header (\`{{secret:NAME}}\`).
- Secrets echoed back by an API are masked in HTTP answers, not inside WebSocket frames.
`;
}
