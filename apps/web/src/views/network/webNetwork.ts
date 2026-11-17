// The sandbox network for the browser simulation. Mock answers run in the page (deterministic);
// Live forwards each pet question to the AI gateway on this computer, which uses the logged-in
// claude CLI or ANTHROPIC_API_KEY (the browser never sees a key).
//
// The canvas engine (lib/engine.ts) creates one per simulation for projects with a Wi-Fi part and
// the panel column shows <NetworkPanel> while it exists.
import { createSandboxNetwork, remoteProvider, type SandboxNet } from "@fabwright/ai-gateway";

export const DEFAULT_GATEWAY = "http://127.0.0.1:8787";
export const GATEWAY_COMMAND = "pnpm start (fabwright serve starts it), or node services/ai-gateway/bin/ai-gateway.mjs";

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

/**
 * Where the AI gateway runs: `fabwright serve` starts one and says where at GET /api/ai-gateway (same
 * origin); otherwise the default port. Never throws.
 */
export async function discoverGateway(fallback = DEFAULT_GATEWAY, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    const res = await fetchImpl("/api/ai-gateway", { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return fallback;
    const body = (await res.json()) as { url?: unknown };
    return typeof body.url === "string" && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(body.url) ? body.url : fallback;
  } catch {
    return fallback;
  }
}

/** Point the network's live mode at this gateway. */
export function useGateway(net: SandboxNet, url: string): void {
  net.ai.live = remoteProvider(url, "AI gateway");
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
