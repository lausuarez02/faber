// Who answers the pet: the deterministic mock, or a live provider (the logged-in claude CLI or
// the Anthropic API, chosen in src/node/providers.ts). Live calls are rate limited and briefly
// cached; any failure is reported as such (HTTP 502/504 with a pet-readable body), never
// silently replaced by a mock answer.
import { mockLatencyMs, mockReply } from "./mock.ts";
import { formatReply, type PetReply, type PetRequest } from "./protocol.ts";

export type ProviderId = "mock" | "claude-cli" | "anthropic-api" | "remote";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  mock: "Mock",
  "claude-cli": "Claude CLI",
  "anthropic-api": "Anthropic API",
  remote: "AI gateway",
};

export interface LiveProvider {
  id: ProviderId;
  /** Human label, e.g. "Claude CLI (claude-haiku-5-5)". */
  label: string;
  model?: string;
  ask(req: PetRequest): Promise<PetReply>;
}

export interface PetAnswer {
  status: number;
  body: string;
  provider: ProviderId;
  /** Why it is not a plain answer: "cached", "rate limited", "live AI off while the sim runs faster than real time"… */
  note?: string;
}

export type PetResult = { kind: "now"; answer: PetAnswer; latencyMs: number } | { kind: "later"; promise: Promise<PetAnswer>; provider: ProviderId };

export interface PetAiOptions {
  mode?: "mock" | "live";
  live?: LiveProvider;
  /** Minimum wall-clock gap between live calls. Default 1500 ms. */
  minIntervalMs?: number;
  /** Live calls per wall-clock minute. Default 20. */
  perMinute?: number;
  /** Seconds a live answer for the same request is reused. Default 15. */
  cacheSeconds?: number;
  /** Wall clock for rate limiting (live mode only). */
  wallNow?: () => number;
}

export class PetAi {
  mode: "mock" | "live";
  live: LiveProvider | undefined;
  private counter = 0;
  private recent: number[] = [];
  private cache = new Map<string, { at: number; body: string }>();
  private readonly o: Required<Omit<PetAiOptions, "live" | "mode">>;

  constructor(opts: PetAiOptions = {}) {
    this.mode = opts.mode ?? "mock";
    this.live = opts.live;
    this.o = {
      minIntervalMs: opts.minIntervalMs ?? 1500,
      perMinute: opts.perMinute ?? 20,
      cacheSeconds: opts.cacheSeconds ?? 15,
      wallNow: opts.wallNow ?? (() => Date.now()),
    };
  }

  /** Back to the first answer (a simulation restarted at t = 0): same requests, same mock replies. */
  reset(): void {
    this.counter = 0;
    this.cache.clear();
  }

  /** Which provider would answer now. */
  provider(liveAllowed = true): ProviderId {
    return this.mode === "live" && this.live && liveAllowed ? this.live.id : "mock";
  }

  answer(req: PetRequest, opts: { liveAllowed?: boolean; why?: string } = {}): PetResult {
    const n = this.counter++;
    const liveWanted = this.mode === "live";
    if (!liveWanted || !this.live || opts.liveAllowed === false) {
      const note = liveWanted ? (!this.live ? "live AI requested but no provider is available (no ANTHROPIC_API_KEY and no claude CLI): mock answered" : (opts.why ?? "live AI paused: mock answered")) : undefined;
      return { kind: "now", answer: { status: 200, body: formatReply(mockReply(req, n)), provider: "mock", ...(note ? { note } : {}) }, latencyMs: mockLatencyMs(req, n) };
    }
    const live = this.live;
    const key = `${req.action}:${req.name}:${Math.round(req.food / 10)}:${Math.round(req.joy / 10)}:${Math.round(req.energy / 10)}:${req.message ?? ""}`;
    const now = this.o.wallNow();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.o.cacheSeconds * 1000) {
      return { kind: "now", answer: { status: 200, body: hit.body, provider: live.id, note: "cached" }, latencyMs: 30 };
    }
    this.recent = this.recent.filter((t) => now - t < 60_000);
    const last = this.recent[this.recent.length - 1];
    if ((last !== undefined && now - last < this.o.minIntervalMs) || this.recent.length >= this.o.perMinute) {
      return { kind: "now", answer: { status: 429, body: "sleepy|Too many questions! Ask me again soon", provider: live.id, note: `rate limited (max one call per ${this.o.minIntervalMs} ms and ${this.o.perMinute} per minute)` }, latencyMs: 30 };
    }
    this.recent.push(now);
    const promise = live.ask(req).then(
      (reply): PetAnswer => {
        const body = formatReply(reply);
        this.cache.set(key, { at: this.o.wallNow(), body });
        return { status: 200, body, provider: live.id };
      },
      (err: unknown): PetAnswer => {
        const msg = err instanceof Error ? err.message : String(err);
        const timeout = /timed out|timeout/i.test(msg);
        return { status: timeout ? 504 : 502, body: "sad|My thinking cloud is offline. Try later", provider: live.id, note: `${live.label} failed: ${msg}` };
      },
    );
    return { kind: "later", promise, provider: live.id };
  }
}
