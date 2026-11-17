// The sandbox network simulated radios join: one Wi-Fi access point ("FabwrightNet", open by
// default), a DNS table and hosts that answer HTTP. ai.fabwright serves the pet AI. Everything is
// in virtual time; in mock mode the whole exchange is deterministic. Every event is logged for
// the network view and for agents (read_network_log).
//
// Structurally implements SandboxNetwork from @fabwright/sim-core (no import, so this package has
// no workspace dependency and runs in the browser too).
import { parseHttpRequest, httpResponse, type HttpRequest } from "./http.ts";
import { cleanMessage, PetRequestError, parsePetQuery } from "./protocol.ts";
import { PetAi, PROVIDER_LABELS, type PetAnswer, type ProviderId } from "./petAi.ts";
import { currentSandboxHost, SANDBOX_SSID, ssidMatches } from "@fabwright/project-format/legacy";

export interface AccessPoint {
  ssid: string;
  password: string;
  rssi: number;
  channel: number;
}

export type NetLogEntry =
  | { seq: number; t: number; kind: "wifi"; event: "join" | "join-failed" | "leave" | "drop" | "restore"; ssid?: string; partId?: string; code?: number; message: string }
  | { seq: number; t: number; kind: "dns"; host: string; ip?: string; message: string }
  | { seq: number; t: number; kind: "tcp"; event: "open" | "refused" | "close"; host: string; port: number; tls: boolean; partId: string; message: string }
  | {
      seq: number;
      t: number;
      kind: "http";
      id: number;
      method: string;
      host: string;
      path: string;
      query: string;
      tls: boolean;
      partId: string;
      status?: number;
      /** Virtual ms from the request to the response reaching the module. */
      latencyMs?: number;
      provider?: ProviderId;
      providerLabel?: string;
      pending: boolean;
      requestPreview: string;
      responseBody?: string;
      note?: string;
      message: string;
    };

/** A log entry before it gets its sequence number. */
export type NetLogDraft = NetLogEntry extends infer T ? (T extends unknown ? Omit<T, "seq"> : never) : never;
type HttpEntry = Extract<NetLogEntry, { kind: "http" }>;

export interface HostContext {
  t: number;
  tls: boolean;
  partId: string;
}

/** What a sandbox host returns for one request: a response now (after latencyMs virtual ms) or later (live). */
export type HostResult = { status: number; body: string; latencyMs: number; provider?: ProviderId; note?: string } | { later: Promise<PetAnswer>; provider: ProviderId };

export type HostHandler = (req: HttpRequest, ctx: HostContext) => HostResult;

export interface SandboxNetworkOptions {
  /** Default: one open network "FabwrightNet". */
  accessPoints?: AccessPoint[];
  ai?: PetAi;
  /** Extra hosts besides ai.fabwright (name → IP and handler). */
  hosts?: Record<string, { ip: string; handler: HostHandler }>;
  /**
   * Live AI only while this returns true (the host passes "the sim runs at <= 1x real time and
   * this is not a test"). Default: always.
   */
  liveAllowed?: () => boolean;
  /** Keep at most this many log entries. Default 500. */
  logLimit?: number;
}

const TCP_CONNECT_MS = 40;
const TLS_HANDSHAKE_MS = 950;
/** Minimum virtual delay of a live answer (the call itself takes wall-clock time on top). */
const LIVE_MIN_MS = 80;

function preview(s: string, n = 120): string {
  const t = s.replace(/\r\n/g, "\\r\\n").replace(/\n/g, "\\n");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export class SandboxNet {
  readonly ai: PetAi;
  private aps: AccessPoint[];
  private hosts = new Map<string, { ip: string; handler: HostHandler }>();
  private _log: NetLogEntry[] = [];
  private seq = 0;
  private httpSeq = 0;
  private listeners = new Set<(e: NetLogEntry) => void>();
  private dropped = false;
  private joined = new Map<string, string>();
  private openSockets = new Set<{ pending: boolean }>();
  private readonly liveAllowed: () => boolean;
  private readonly logLimit: number;
  /** Virtual time of the last event (DNS lookups carry no time of their own). */
  private lastT = 0;
  /** What the person typed to the pet (say()), sent with the next pet request that has no m= of its own. */
  private said: string | undefined;

  constructor(opts: SandboxNetworkOptions = {}) {
    this.ai = opts.ai ?? new PetAi();
    this.aps = opts.accessPoints ?? [{ ssid: SANDBOX_SSID, password: "", rssi: -52, channel: 6 }];
    this.liveAllowed = opts.liveAllowed ?? (() => true);
    this.logLimit = opts.logLimit ?? 500;
    this.hosts.set("ai.fabwright", { ip: "10.0.0.2", handler: (req, ctx) => this.petHandler(req, ctx) });
    for (const [name, h] of Object.entries(opts.hosts ?? {})) this.hosts.set(name.toLowerCase(), h);
  }

  // ------------------------------------------------------------------ log

  get log(): readonly NetLogEntry[] {
    return this._log;
  }

  onLog(cb: (e: NetLogEntry) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** Entries after seq (for polling UIs and read_network_log {since}). */
  since(seq: number): NetLogEntry[] {
    return this._log.filter((e) => e.seq > seq);
  }

  private push(e: NetLogDraft): NetLogEntry {
    if (e.kind === "dns") (e as { t: number }).t = this.lastT;
    else this.lastT = e.t;
    const entry = { ...e, seq: ++this.seq } as NetLogEntry;
    this._log.push(entry);
    if (this._log.length > this.logLimit) this._log.splice(0, this._log.length - this.logLimit);
    for (const l of this.listeners) l(entry);
    return entry;
  }

  private update(entry: NetLogEntry): void {
    for (const l of this.listeners) l(entry);
  }

  // ------------------------------------------------------------------ state

  /** Live AI calls in flight (hosts may await settle() between simulation chunks). */
  get pending(): number {
    let n = 0;
    for (const s of this.openSockets) if (s.pending) n++;
    return n;
  }

  private waiters: Promise<unknown>[] = [];

  /** Resolves when every live call started so far has answered (or failed). */
  async settle(): Promise<void> {
    await Promise.allSettled(this.waiters);
  }

  /** Joined stations by part id → SSID. */
  stations(): Record<string, string> {
    return Object.fromEntries(this.joined);
  }

  get wifiDropped(): boolean {
    return this.dropped;
  }

  /** The "wifi_drop" fault: the access point disappears for every station (true) or comes back (false). */
  setWifiDrop(on: boolean, t = 0): void {
    if (on === this.dropped) return;
    this.dropped = on;
    this.push({ t, kind: "wifi", event: on ? "drop" : "restore", message: on ? "Wi-Fi dropped (fault injected): stations lose the AP" : "Wi-Fi restored: stations can reconnect" });
    if (on) this.joined.clear();
  }

  /**
   * The simulation restarted at t = 0: forget stations, sockets, the log and the mock's answer
   * counter (so a re-run gives the same replies), keep the mode and the Wi-Fi fault.
   */
  resetRun(): void {
    this.joined.clear();
    this.openSockets.clear();
    this.waiters = [];
    this._log = [];
    this.httpSeq = 0;
    this.lastT = 0;
    this.ai.reset();
    for (const l of this.listeners) l({ seq: this.seq, t: 0, kind: "wifi", event: "restore", message: "simulation reset" } as NetLogEntry);
  }

  setMode(mode: "mock" | "live"): void {
    this.ai.mode = mode;
  }

  /** What would answer a pet request right now. */
  status(): { mode: "mock" | "live"; provider: ProviderId; providerLabel: string; liveAvailable: boolean; liveLabel?: string; liveAllowed: boolean; wifiDropped: boolean; stations: Record<string, string> } {
    const allowed = this.liveAllowed();
    const provider = this.ai.provider(allowed);
    return {
      mode: this.ai.mode,
      provider,
      providerLabel: provider === "mock" ? PROVIDER_LABELS.mock : (this.ai.live?.label ?? PROVIDER_LABELS[provider]),
      liveAvailable: this.ai.live !== undefined,
      ...(this.ai.live ? { liveLabel: this.ai.live.label } : {}),
      liveAllowed: allowed,
      wifiDropped: this.dropped,
      stations: this.stations(),
    };
  }

  // ------------------------------------------------------------------ SandboxNetwork

  accessPoints() {
    if (this.dropped) return [];
    return this.aps.map((a) => ({ ssid: a.ssid, rssi: a.rssi, secured: a.password !== "", channel: a.channel }));
  }

  join(ssid: string, password: string, tMs: number, partId: string): 0 | 1 | 2 | 3 | 4 {
    const ap = this.dropped ? undefined : this.aps.find((a) => ssidMatches(ssid, a.ssid));
    let code: 0 | 2 | 3 = 0;
    if (!ap) code = 3;
    else if (ap.password !== "" && ap.password !== password) code = 2;
    if (code === 0) {
      this.joined.set(partId, ssid);
      this.push({ t: tMs, kind: "wifi", event: "join", ssid, partId, message: `${partId} joined ${ssid}` });
    } else {
      const known = this.aps.map((a) => a.ssid).join(", ");
      this.push({
        t: tMs,
        kind: "wifi",
        event: "join-failed",
        ssid,
        partId,
        code,
        message: code === 3 ? `${partId} cannot find '${ssid}' (+CWJAP:3). Networks in range: ${this.dropped ? "none (Wi-Fi drop fault)" : known}` : `${partId}: wrong password for '${ssid}' (+CWJAP:2)`,
      });
    }
    return code;
  }

  leave(tMs: number, partId: string): void {
    const ssid = this.joined.get(partId);
    if (!ssid) return;
    this.joined.delete(partId);
    this.push({ t: tMs, kind: "wifi", event: "leave", ssid, partId, message: `${partId} left ${ssid}` });
  }

  linkUp(): boolean {
    return !this.dropped;
  }

  resolve(host: string): string | undefined {
    const h = host.toLowerCase();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return [...this.hosts.values()].some((x) => x.ip === h) ? h : undefined;
    const ip = (this.hosts.get(h) ?? this.hosts.get(currentSandboxHost(h)))?.ip;
    this.push({ t: 0, kind: "dns", host, ...(ip ? { ip } : {}), message: ip ? `${host} → ${ip}` : `${host}: DNS Fail (sandbox hosts: ${[...this.hosts.keys()].join(", ")})` });
    return ip;
  }

  open(o: { host: string; ip: string; port: number; tls: boolean; tMs: number; partId: string }) {
    const entry = [...this.hosts.entries()].find(([name, h]) => name === o.host.toLowerCase() || name === currentSandboxHost(o.host) || h.ip === o.ip);
    const portOk = o.tls ? o.port === 443 : o.port === 80;
    if (!entry || !portOk || this.dropped) {
      this.push({ t: o.tMs, kind: "tcp", event: "refused", host: o.host, port: o.port, tls: o.tls, partId: o.partId, message: `${o.host}:${o.port} refused${entry && !portOk ? ` (${o.host} serves HTTP on 80 and HTTPS/SSL on 443)` : ""}` });
      return { error: "refused" as const };
    }
    this.push({ t: o.tMs, kind: "tcp", event: "open", host: o.host, port: o.port, tls: o.tls, partId: o.partId, message: `${o.partId} → ${o.host}:${o.port}${o.tls ? " (TLS)" : ""}` });
    return this.socket(entry[0], entry[1].handler, o);
  }

  // ------------------------------------------------------------------ sockets

  private socket(hostName: string, handler: HostHandler, o: { port: number; tls: boolean; partId: string }) {
    let inbuf = "";
    let out: { data: string; at: number; closeAt: number } | undefined;
    let delivered = false;
    let closed = false;
    let liveDone: { answer: PetAnswer } | undefined;
    let liveEntry: Extract<NetLogEntry, { kind: "http" }> | undefined;
    let liveStart = 0;
    const state = { pending: false };
    this.openSockets.add(state);
    const net = this;

    const finish = (entry: Extract<NetLogEntry, { kind: "http" }>, ans: { status: number; body: string; provider?: ProviderId; note?: string }, at: number, startT: number) => {
      out = { data: httpResponse(ans.status, ans.body), at, closeAt: at + 8 };
      entry.pending = false;
      entry.status = ans.status;
      entry.latencyMs = Math.round(at - startT);
      entry.responseBody = ans.body;
      if (ans.provider) {
        entry.provider = ans.provider;
        entry.providerLabel = ans.provider === "mock" ? PROVIDER_LABELS.mock : (net.ai.live?.label ?? PROVIDER_LABELS[ans.provider]);
      }
      if (ans.note) entry.note = ans.note;
      entry.message = `${entry.method} ${hostName}${entry.path} → ${ans.status} in ${entry.latencyMs} ms${entry.providerLabel ? ` (${entry.providerLabel})` : ""}`;
      net.update(entry);
    };

    return {
      connectMs: TCP_CONNECT_MS + (o.tls ? TLS_HANDSHAKE_MS : 0),
      get pending() {
        return state.pending;
      },
      write(data: string, tMs: number) {
        if (closed || out || liveEntry) return;
        inbuf += data;
        const p = parseHttpRequest(inbuf);
        if (!p.done) return;
        const id = ++net.httpSeq;
        if ("error" in p) {
          const entry = <HttpEntry>net.push({ t: tMs, kind: "http", id, method: "?", host: hostName, path: "?", query: "", tls: o.tls, partId: o.partId, pending: true, requestPreview: preview(inbuf), message: "" });
          finish(entry, { status: 400, body: `error|${p.error}` }, tMs + 5, tMs);
          return;
        }
        const req = p.request;
        const entry = <HttpEntry>net.push({
          t: tMs,
          kind: "http",
          id,
          method: req.method,
          host: hostName,
          path: req.path,
          query: req.query,
          tls: o.tls,
          partId: o.partId,
          pending: true,
          requestPreview: preview(inbuf),
          message: `${req.method} ${hostName}${req.path}${req.query ? `?${req.query}` : ""} …`,
        });
        const r = handler(req, { t: tMs, tls: o.tls, partId: o.partId });
        if ("later" in r) {
          state.pending = true;
          liveEntry = entry;
          liveStart = tMs;
          entry.provider = r.provider;
          entry.providerLabel = net.ai.live?.label ?? PROVIDER_LABELS[r.provider];
          net.update(entry);
          const w = r.later.then((answer) => {
            liveDone = { answer };
            state.pending = false;
          });
          net.waiters.push(w);
        } else {
          finish(entry, r, tMs + r.latencyMs, tMs);
        }
      },
      read(tMs: number) {
        if (closed) return { data: "", closed: true };
        if (!out && liveDone && liveEntry) {
          finish(liveEntry, liveDone.answer, Math.max(tMs, liveStart + LIVE_MIN_MS), liveStart);
        }
        if (!out || tMs < out.at) return { data: "", closed: false };
        if (!delivered) {
          delivered = true;
          return { data: out.data, closed: false };
        }
        if (tMs >= out.closeAt) {
          closed = true;
          net.openSockets.delete(state);
          return { data: "", closed: true };
        }
        return { data: "", closed: false };
      },
      close(tMs: number) {
        if (closed) return;
        closed = true;
        state.pending = false;
        net.openSockets.delete(state);
        if (liveEntry && !liveDone) {
          liveEntry.pending = false;
          liveEntry.note = "the device closed the link before the live answer arrived";
          net.update(liveEntry);
        }
        void tMs;
      },
    };
  }

  // ------------------------------------------------------------------ ai.fabwright

  /**
   * The person talks to the running pet (the canvas text box): the next request to /v1/pet that has
   * no m= of its own carries this message to the model, so a pet sketch that only knows TALK / FEED
   * still "hears" what was typed. Returns the cleaned message ("" clears a waiting one).
   */
  say(text: string): string {
    const m = cleanMessage(text);
    this.said = m || undefined;
    return m;
  }

  /** The message waiting for the pet's next request, if any. */
  get waitingMessage(): string | undefined {
    return this.said;
  }

  private petHandler(req: HttpRequest, ctx: HostContext): HostResult {
    if (req.path === "/" || req.path === "/health") return { status: 200, body: "ok|ai.fabwright pet gateway", latencyMs: 15 };
    if (req.path !== "/v1/pet") return { status: 404, body: `error|no ${req.path}; use GET /v1/pet?a=talk&f=50&j=50&e=50`, latencyMs: 15 };
    if (req.method !== "GET" && req.method !== "POST") return { status: 405, body: "error|use GET /v1/pet?a=talk&f=50&j=50&e=50", latencyMs: 15 };
    let pet;
    try {
      pet = parsePetQuery(req.method === "POST" && req.body ? req.body : req.query);
    } catch (e) {
      const err = e as PetRequestError;
      return { status: 400, body: `error|${err.message}; ${err.fix}`.slice(0, 120), latencyMs: 15 };
    }
    void ctx;
    let carried: string | undefined;
    if (!pet.message && this.said) {
      pet = { ...pet, message: this.said };
      carried = this.said;
      this.said = undefined;
    }
    const allowed = this.liveAllowed();
    const r = this.ai.answer(pet, { liveAllowed: allowed, why: "live AI paused: the simulation runs faster than real time or in a test, so the mock answered (deterministic)" });
    const heard = carried ? `with the person's message "${carried}"` : undefined;
    if (r.kind === "later") return { later: heard ? r.promise.then((a) => ({ ...a, note: a.note ? `${heard}; ${a.note}` : heard })) : r.promise, provider: r.provider };
    const note = [heard, r.answer.note].filter(Boolean).join("; ");
    return { status: r.answer.status, body: r.answer.body, latencyMs: r.latencyMs, provider: r.answer.provider, ...(note ? { note } : {}) };
  }
}

export function createSandboxNetwork(opts: SandboxNetworkOptions = {}): SandboxNet {
  return new SandboxNet(opts);
}
