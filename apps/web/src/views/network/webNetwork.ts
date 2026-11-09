// The sandbox network for the browser simulation. Mock answers run in the page (deterministic);
// Live forwards each pet question to the AI gateway on this computer, which uses the logged-in
// claude CLI or ANTHROPIC_API_KEY (the browser never sees a key).
//
// The canvas engine (lib/engine.ts) creates one per simulation for projects with a Wi-Fi part and
// the panel column shows <NetworkPanel> while it exists.
import { createSandboxNetwork, remoteProvider, type SandboxNet } from "@jumper/ai-gateway";

export const DEFAULT_GATEWAY = "http://127.0.0.1:8787";
export const GATEWAY_COMMAND = "node services/ai-gateway/bin/ai-gateway.mjs";

export interface WebNetworkOptions {
  gatewayUrl?: string;
  /** Live answers only while this holds (the sim runs at real time or slower). Default: always. */
  liveAllowed?: () => boolean;
}

export function createWebNetwork(opts: WebNetworkOptions = {}): SandboxNet {
  const net = createSandboxNetwork(opts.liveAllowed ? { liveAllowed: opts.liveAllowed } : {});
  net.ai.live = remoteProvider(opts.gatewayUrl ?? DEFAULT_GATEWAY, "AI gateway");
  return net;
}

export interface GatewayProbe {
  ok: boolean;
  /** e.g. "Claude CLI" / "Anthropic API" / "Mock" as the gateway reports it. */
  provider?: string;
  error?: string;
}

/** Ask the gateway who would answer; never throws. */
export async function probeGateway(url = DEFAULT_GATEWAY, fetchImpl: typeof fetch = fetch): Promise<GatewayProbe> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetchImpl(`${url}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    const body = await res.text();
    const p = /provider (\S+)/.exec(body)?.[1] ?? "";
    const provider = p === "claude-cli" ? "Claude CLI" : p === "anthropic-api" ? "Anthropic API" : p === "mock" ? "Mock" : p || undefined;
    if (!res.ok) return { ok: false, error: `the gateway answered ${res.status}` };
    if (provider === "Mock") return { ok: false, provider, error: "the gateway runs but has no live model (no ANTHROPIC_API_KEY and no claude CLI where it runs)" };
    return { ok: true, ...(provider ? { provider } : {}) };
  } catch {
    return { ok: false, error: `no AI gateway at ${url}` };
  }
}

/** Parts that join the sandbox Wi-Fi. */
export const WIFI_PART_TYPES = ["esp01-wifi"];

export function hasWifiPart(project: { parts: { type: string }[] }): boolean {
  return project.parts.some((p) => WIFI_PART_TYPES.includes(p.type));
}
