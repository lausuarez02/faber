/**
 * Round 13: the kit's Connect section, for any project that reaches the network: the API keys (by
 * name, set or missing on this machine, never values), the relay that holds them (on a computer or on
 * Cloudflare Workers), one token per device, Wi-Fi and the relay address on the device, a check, and
 * what calls cost in general. Generic: it reads jumper.json "network" only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSecrets, parseDeviceTokens, parseDotEnv, RELAY_ENV, relaySlug, relaySpecFrom, relayUseful, worstCaseCallsPerDay } from "@jumper/device-net";
import { boardSupportOf } from "@jumper/parts";
import type { Project } from "@jumper/project-format";
import type { PartRegistry } from "@jumper/sim-core";
import { networkConfigOf } from "../device-network.ts";
import type { ConnectPlan } from "./types.ts";

export function connectPlan(project: Project, registry: PartRegistry, dir: string): ConnectPlan | undefined {
  if (!project.network) return undefined;
  let config;
  try {
    config = networkConfigOf(project);
  } catch {
    return undefined;
  }
  if (!config.allow.length && !config.secrets.length) return undefined;
  const spec = relaySpecFrom(config, project.name);
  const slug = relaySlug(project.name);
  const envPath = join(dir, ".env");
  const env = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf8")) : {};
  const loaded = loadSecrets(config.secrets, { envFile: envPath });
  const devices = parseDeviceTokens(env[RELAY_ENV.tokens] ?? process.env[RELAY_ENV.tokens]).map((d) => d.name);
  const needsRelay = relayUseful(config) && config.secrets.length > 0;
  const board = project.parts.find((p) => p.id === project.firmware?.board);
  const fqbn = board ? registry.get(board.type)?.spec.mcu?.fqbn : undefined;
  const sketchDir = project.firmware?.sketch ? `firmware/${project.firmware.sketch.split("/").slice(0, -1).join("/")}`.replace(/\/$/, "") : "firmware";
  const hosts = config.allow.map((a) => ({ host: a.host, secrets: a.secrets ?? [], relayed: a.tls !== "passthrough" }));
  const secrets = config.secrets.map((n) => ({ name: n, hosts: config.allow.filter((a) => a.secrets?.includes(n)).map((a) => a.host), set: loaded.values.has(n) }));
  const steps: ConnectPlan["steps"] = [];
  if (secrets.length) {
    steps.push({
      title: "Your API keys",
      do: [
        ...secrets.map((s) => `${s.name}${s.hosts.length ? ` (for ${s.hosts.join(", ")})` : ""}: get it from the provider's dashboard and put ${s.name}=... in the project's .env file.${s.set ? " It is already set on this computer." : " It is not set on this computer yet."}`),
        "The keys go to the relay only. The device never holds one, so nobody can read a key out of it.",
      ],
    });
  }
  if (needsRelay) {
    steps.push({
      title: "Set up the relay",
      do: [
        "The relay is a small program that holds your keys, calls only the hosts this project allows, and adds the keys on the way. The kit's relay/ folder has it (MIT).",
        "On a computer that stays on (home, a Raspberry Pi): run it there. Fine on your own Wi-Fi for trying it out; anything reachable from the internet must be HTTPS.",
        "Or on Cloudflare Workers (free for hobby traffic; check their current limits): deploy it once, it runs without your computer.",
      ],
      commands: [
        { label: "On this computer (from the project)", cmd: "jumper relay serve        # http://<this computer>:8787" },
        { label: "Or without Jumper (Node 20+)", cmd: "cd relay && cp .env.example .env && node server.mjs" },
        { label: "Or on Cloudflare Workers", cmd: ["cd relay", "npx wrangler login", `npx wrangler secret put ${RELAY_ENV.tokens}`, ...spec.secrets.map((n) => `npx wrangler secret put ${n}`), `npx wrangler deploy        # https://${slug}-relay.<your account>.workers.dev`].join("\n") },
      ],
    });
    steps.push({
      title: "A token for each device",
      do: [
        "Each device gets its own token. It only opens your relay, and the relay only calls this project's hosts.",
        devices.length ? `Devices with a token on this computer: ${devices.join(", ")}.` : "No device has a token yet.",
        "Lost or gave away a device? Revoke its token and give the relay the new list; the keys stay as they are.",
      ],
      commands: [
        { label: "Make one", cmd: `jumper relay token add ${slug}-1` },
        { label: "Revoke one", cmd: `jumper relay token revoke ${slug}-1` },
      ],
    });
  }
  steps.push({
    title: "Wi-Fi and the relay address on the device",
    do: [
      `Put these in the project's .env: ${needsRelay ? "RELAY_URL=<the relay's address>, " : ""}WIFI_SSID=<your Wi-Fi> and WIFI_PASSWORD=<its password>. The board needs 2.4 GHz Wi-Fi.`,
      "jumper relay device-header writes them, with the device token, into jumper_device.h next to the sketch. That file is git-ignored; never share it.",
      "Build and flash from the sketch folder (Arduino IDE, or the command below). The firmware file in this kit has no token and no Wi-Fi password, so it is safe to share, but it cannot connect until you build your own.",
    ],
    commands: [
      { label: "Write the device header", cmd: "jumper relay device-header" },
      ...(fqbn ? [{ label: "Build and flash your device", cmd: `arduino-cli compile --fqbn ${fqbn} --upload -p <port> ${sketchDir}` }] : []),
    ],
  });
  steps.push({
    title: "Check it",
    do: [
      "Open the serial monitor: the firmware says when Wi-Fi is up and what each call answered. jumperRelayReady() is false (and the firmware says why) when jumper_device.h was missing at build time.",
      needsRelay ? "The relay logs one line per call (device, host, path, status, time; never a key, a token or query values): in the terminal running it, or npx wrangler tail on Cloudflare." : "Watch the serial monitor for each call's status.",
      "401 means the token is wrong or revoked, 403 a host or key the project does not allow (the answer says which and how to fix it), 429 too many calls a minute.",
    ],
  });
  const perDay = worstCaseCallsPerDay(spec);
  const cost = [
    "Each call the device makes is one relay request plus one API call. The API's own price per call is usually what matters: calls an hour x hours on x the provider's price per call (see the provider's pricing page).",
    ...(needsRelay ? [`The relay caps one device at ${spec.limits.requests_per_minute} calls a minute, so ${perDay.toLocaleString("en-US")} a day at worst. Lower network.relay.requests_per_minute if that would cost too much, and set a spending limit with the provider too.`, "The relay itself: free on your own computer; Cloudflare Workers' free plan covers hobby use (check their current limits)."] : []),
  ];
  // a board with no network of its own (an RP2040, an AVR) cannot reach anything on the real device
  const net = board ? boardSupportOf(board.type)?.areas.net : undefined;
  const boardName = board ? (registry.get(board.type)?.spec.name ?? board.type) : "the board";
  const noRadio = net?.status === "no" && !project.parts.some((p) => /esp-?01|wifi|wi-fi/i.test(p.type));
  const notes = [
    ...(noRadio ? [`${boardName} has no Wi-Fi, so the real device cannot reach the network with it. Use a board with Wi-Fi (an ESP32-family board, e.g. a XIAO ESP32-S3), or add a Wi-Fi module.`] : []),
    ...(spec.direct?.length ? [`Not through the relay (end-to-end TLS): ${spec.direct.map((d) => d.host).join(", ")}; the device calls them directly and they get no key.`] : []),
    "Relayed: HTTP(S) requests, streamed answers and WebSockets. Not relayed: MQTT and other raw TCP (MQTT over WebSocket works).",
    "In Jumper's simulator the same firmware calls a sandbox relay with the same rules, so what worked there works here.",
  ];
  return {
    ...(noRadio ? { warning: notes[0] } : {}),
    summary: needsRelay
      ? `The device reaches ${hosts.map((h) => h.host).join(", ")} through your relay, which holds the API keys (${config.secrets.join(", ")}); the device holds only its own revocable token.`
      : `The device reaches ${hosts.map((h) => h.host).join(", ") || "the network"} directly; no API keys are needed.`,
    needs_relay: needsRelay,
    hosts,
    secrets,
    devices,
    steps,
    cost,
    notes,
  };
}
