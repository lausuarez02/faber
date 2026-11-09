// The sandbox network (Wi-Fi + the pet AI at ai.jumper) for session simulations, and the agent
// operations on it: set_ai_mode, read_network_log, run_live, and the wifi_drop fault. Kept in its
// own file so the session engine only needs a few hooks (SimHost in sim.ts, the ops in session.ts).
//
// Determinism: every simulation gets the deterministic mock AI. A live answer (claude CLI or
// Anthropic API) is only used inside runLive(), which paces the simulation at real time and waits
// for the call; plain `run` and scenario tests always use the mock, even with ai mode "live".
import { createSandboxNetwork, type NetLogEntry, type SandboxNet } from "@jumper/ai-gateway";
import { chooseProvider } from "@jumper/ai-gateway/node";
import type { ToolDef } from "./catalog.ts";
import { fail } from "./errors.ts";

/** A sandbox network with a "live window" switch (only runLive opens it). */
export interface SessionNetwork extends SandboxNet {
  liveWindow: boolean;
  /** Why the live provider is or is not available (from the provider chain). */
  liveReason: string;
}

export function createSessionNetwork(): SessionNetwork {
  const state = { liveWindow: false };
  const net = createSandboxNetwork({ liveAllowed: () => state.liveWindow }) as SessionNetwork;
  Object.defineProperty(net, "liveWindow", { get: () => state.liveWindow, set: (v: boolean) => (state.liveWindow = v) });
  net.liveReason = "mock mode";
  return net;
}

/** set_ai_mode: "mock" (deterministic, default) or "live" (the provider chain: ANTHROPIC_API_KEY → claude CLI). */
export function setAiMode(net: SessionNetwork, mode: string): Record<string, unknown> {
  if (mode !== "mock" && mode !== "live") fail("bad-value", `set_ai_mode: unknown mode '${mode}'`, "modes are mock and live", 'pass { "mode": "mock" } or { "mode": "live" }');
  if (mode === "live" && !net.ai.live) {
    const choice = chooseProvider({ prefer: process.env.JUMPER_AI_PROVIDER === "mock" ? "" : (process.env.JUMPER_AI_PROVIDER ?? "") });
    net.liveReason = choice.reason;
    if (!choice.provider) {
      fail("no-live-ai", "set_ai_mode live: no live AI provider", choice.reason, "set ANTHROPIC_API_KEY, or install Claude Code and log in with `claude`, then call set_ai_mode live again (the mock stays active meanwhile)");
    }
    net.ai.live = choice.provider;
  }
  net.setMode(mode);
  const s = net.status();
  return {
    mode,
    provider: mode === "live" ? s.liveLabel : "Mock",
    note:
      mode === "live"
        ? "Live answers are used by run_live only (it paces the simulation at real time and waits for the model). run and run_tests keep the deterministic mock so tests stay reproducible."
        : "Deterministic canned replies with a fixed virtual latency (400 to 800 ms).",
    ...(mode === "live" ? { why: net.liveReason } : {}),
  };
}

function compactEntry(e: NetLogEntry): Record<string, unknown> {
  if (e.kind === "http") {
    return {
      seq: e.seq,
      t_ms: Math.round(e.t),
      http: `${e.method} ${e.host}${e.path}${e.query ? `?${e.query}` : ""}`,
      status: e.status ?? (e.pending ? "pending" : undefined),
      latency_ms: e.latencyMs,
      provider: e.providerLabel,
      response: e.responseBody,
      ...(e.note ? { note: e.note } : {}),
    };
  }
  return { seq: e.seq, t_ms: Math.round(e.t), [e.kind]: e.message };
}

/** read_network_log: what the device did on the network (Wi-Fi joins, DNS, TCP, HTTP with provider and latency). */
export function readNetworkLog(net: SessionNetwork, args: { since?: number; limit?: number } = {}): Record<string, unknown> {
  const entries = net.since(args.since ?? 0);
  const limit = Math.max(1, Math.min(200, args.limit ?? 50));
  const shown = entries.slice(-limit);
  const s = net.status();
  return {
    mode: s.mode,
    answering: s.providerLabel,
    wifi: s.wifiDropped ? "dropped (fault)" : "up",
    stations: s.stations,
    entries: shown.map(compactEntry),
    ...(entries.length > shown.length ? { truncated: `${entries.length - shown.length} older entries; pass since=${shown[0]!.seq - 1} or a larger limit` } : {}),
    last_seq: entries.length ? entries[entries.length - 1]!.seq : (args.since ?? 0),
    ...(entries.length === 0 ? { hint: "no network activity yet: the firmware has not joined Wi-Fi or made a request. Check the ESP-01 wiring (TX → board RX pin, RX ← board TX pin) and run longer (joining takes ~2.5 s)." } : {}),
  };
}

/** The wifi_drop fault (network-wide, survives run {reset: true}); "clear" restores it. */
export function setWifiDrop(net: SessionNetwork, on: boolean, tMs: number): string {
  net.setWifiDrop(on, tMs);
  return on ? "Wi-Fi dropped: the access point is gone; joined modules print WIFI DISCONNECT and their links CLOSED. inject_fault kind clear restores it (modules reconnect by themselves after ~2.5 s)." : "Wi-Fi restored";
}

/**
 * run_live: simulate `ms` at no more than real time, letting a live AI answer arrive while the
 * firmware waits for it (so the virtual latency is the real call's latency). `step` runs the
 * simulation for a slice (SimHost.run); returns what the network did meanwhile.
 */
export async function runLive(net: SessionNetwork, step: (ms: number) => void, ms: number, nowMs: () => number = () => Date.now()): Promise<Record<string, unknown>> {
  const sliceMs = 50;
  const start = nowMs();
  const fromSeq = net.log.length ? net.log[net.log.length - 1]!.seq : 0;
  net.liveWindow = true;
  try {
    for (let done = 0; done < ms; done += sliceMs) {
      step(Math.min(sliceMs, ms - done));
      const ahead = done + sliceMs - (nowMs() - start);
      if (ahead > 0) await new Promise((r) => setTimeout(r, ahead));
    }
  } finally {
    net.liveWindow = false;
  }
  const http = net.since(fromSeq).filter((e) => e.kind === "http");
  return {
    ran_ms: ms,
    wall_ms: nowMs() - start,
    requests: http.map(compactEntry),
    ...(net.pending ? { pending: `${net.pending} live answer(s) still on the way; run_live again to receive them` } : {}),
  };
}

/** Tool definitions, appended to TOOLS in catalog.ts; session.ts routes them (setAiMode, readNetworkLog, runLive). */
export const NETWORK_TOOLS: ToolDef[] = [
  {
    name: "set_ai_mode",
    title: "Mock or live pet AI",
    description:
      'Choose who answers the sandbox AI host (http://ai.jumper/v1/pet) that an ESP-01 Wi-Fi module reaches: "mock" (default; deterministic canned pet replies, 400 to 800 ms virtual latency, always used by run and run_tests) or "live" (a real model, claude-haiku-5-5, through ANTHROPIC_API_KEY or the logged-in claude CLI; used only by run_live, which runs the simulation at real time). Returns the provider that will answer. Fails with the reason when no live provider exists.',
    inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["mock", "live"] } }, required: ["mode"] },
  },
  {
    name: "read_network_log",
    title: "Network activity",
    description:
      "What the simulated device did on the sandbox network: Wi-Fi joins and drops, DNS lookups, TCP connections and every HTTP request with status, virtual latency, the provider that answered (Mock / Claude CLI / Anthropic API) and the response body. Pass since (a seq from a previous call) to get only new entries. Use it when a Wi-Fi sketch does not get its answer: an empty log means the module never joined.",
    inputSchema: { type: "object", properties: { since: { type: "number", description: "Return entries after this seq." }, limit: { type: "number", description: "Max entries (default 50, max 200)." } } },
    readOnly: true,
  },
  {
    name: "run_live",
    title: "Run at real time with the live AI",
    description:
      "Run the simulation for ms at no more than real time with the live AI allowed (set_ai_mode live first), so a real model answers the device's HTTP requests and the virtual latency is the real one. Not deterministic; use run / run_tests for tests. Returns the requests made meanwhile. Press buttons with interact before it (e.g. the pet's TALK button) and read the screen with screenshot after.",
    inputSchema: { type: "object", properties: { ms: { type: "number", description: "Virtual (= wall) milliseconds, max 60000." } }, required: ["ms"] },
  },
];

