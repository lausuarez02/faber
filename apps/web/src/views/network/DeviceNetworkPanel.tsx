// Round 10 (network): the Network panel for boards on Fabwright's device network (ESP32 family in the
// emulator). Polls fabwright serve once a second while open: every request (method, host, path,
// status, who answered, time, bytes), WebSocket and MQTT sessions summarized (frame counts, bytes,
// a few samples), Wi-Fi joins / drops / DHCP / DNS, blocked attempts with why and fix. Secrets only
// ever appear as names ([secret:NAME]); the server redacts before anything reaches the page.
// Buttons rehearse a bad network (drop Wi-Fi, weak signal, clear), and a box tries one request
// from inside the sandbox.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Globe, KeyRound, Radio, Send, Wifi, WifiOff } from "lucide-react";
import { devnetApi, devnetRows, wifiSummary, type DevNetSnapshot, type TryResult } from "./devnet.ts";
import "./network.css";

export function DeviceNetworkBody({ pollMs = 1000 }: { pollMs?: number }) {
  const [snap, setSnap] = useState<DevNetSnapshot | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [events, setEvents] = useState(true);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [tried, setTried] = useState<TryResult | undefined>();

  const refresh = useCallback(async () => {
    try {
      setSnap(await devnetApi.read());
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  const rows = useMemo(() => devnetRows(snap?.entries ?? [], { events }), [snap, events]);
  const fault = async (f: Record<string, unknown>) => {
    setBusy(true);
    try {
      await devnetApi.fault(f);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const tryIt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setTried(undefined);
    try {
      setTried(await devnetApi.tryRequest(url.trim()));
      await refresh();
    } catch (err) {
      setTried({ ok: false, error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (error && !snap) return <p className="devnet-error" role="alert">{error}</p>;
  if (!snap) return <p className="panel-empty">Reading the device network…</p>;
  if (!snap.enabled) {
    return (
      <div className="panel-empty" data-testid="devnet-off">
        <p>No device network in this project yet.</p>
        <p>
          Ask the agent to <code>set_network {"{"}"mode": "mock"{"}"}</code> or <code>add_mock_api</code>: boards with Wi-Fi in the emulator (ESP32 family) then reach mocked APIs, and everything they do shows here.
        </p>
      </div>
    );
  }
  const wifi = wifiSummary(snap);
  const dropped = snap.faults?.some((f) => f.kind === "wifi_drop");
  const weak = snap.faults?.some((f) => f.kind === "weak_signal");
  return (
    <div className="devnet" data-testid="devnet">
      <div className="devnet-status">
        <span className={`devnet-chip tone-${wifi.tone}`} data-testid="devnet-wifi">
          {dropped ? <WifiOff size={13} aria-hidden /> : <Wifi size={13} aria-hidden />}
          {wifi.text}
        </span>
        <span className="devnet-chip" data-testid="devnet-mode" title={snap.mode === "internet" ? `internet: ${snap.allow?.map((a) => a.host).join(", ")}` : undefined}>
          <Globe size={13} aria-hidden />
          {snap.mode}
          {snap.mode === "internet" && snap.allow?.length ? ` · ${snap.allow.length} allowed` : ""}
        </span>
        {snap.mocks?.length ? <span className="devnet-chip">{snap.mocks.length} mock{snap.mocks.length > 1 ? "s" : ""}</span> : null}
      </div>

      <div className="devnet-faults" role="group" aria-label="Rehearse a bad network">
        <button type="button" onClick={() => void fault({ kind: "wifi_drop" })} disabled={busy || dropped} data-testid="devnet-drop">
          Drop Wi-Fi
        </button>
        <button type="button" onClick={() => void fault({ kind: "weak_signal", rssi: -85 })} disabled={busy || weak}>
          Weak signal
        </button>
        <button type="button" onClick={() => void fault({ kind: "clear" })} disabled={busy || !snap.faults?.length} data-testid="devnet-clear">
          Clear faults
        </button>
      </div>

      {snap.secrets?.length ? (
        <ul className="devnet-secrets" aria-label="Secrets">
          {snap.secrets.map((s) => (
            <li key={s.name} className={s.set ? "is-set" : "is-missing"}>
              <KeyRound size={12} aria-hidden />
              <code>{s.name}</code> {s.set ? "set on this machine" : "missing"}
              {s.hosts.length ? <span className="devnet-muted"> → {s.hosts.join(", ")}</span> : null}
            </li>
          ))}
          {snap.secrets_fix ? <li className="devnet-fix">Fix: {snap.secrets_fix}</li> : null}
        </ul>
      ) : null}

      <form className="devnet-try" onSubmit={(e) => void tryIt(e)} aria-label="Try a request in the sandbox">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/v1/now" aria-label="URL to request from inside the sandbox" data-testid="devnet-url" />
        <button type="submit" disabled={busy || !url.trim()} data-testid="devnet-try">
          <Send size={13} aria-hidden /> Try
        </button>
      </form>
      {tried ? (
        <p className={`devnet-tried ${tried.ok && (tried.status ?? 0) < 400 ? "tone-ok" : "tone-err"}`} data-testid="devnet-tried" role="status">
          {tried.ok ? `${tried.status} · ${tried.ms} ms · ${tried.body?.slice(0, 140) ?? ""}` : `${tried.error}${tried.why ? `. Why: ${tried.why}` : ""}${tried.fix ? `. Fix: ${tried.fix}` : ""}`}
        </p>
      ) : null}

      <div className="devnet-list-head">
        <span>Traffic</span>
        <label>
          <input type="checkbox" checked={events} onChange={(e) => setEvents(e.target.checked)} /> Wi-Fi, DHCP, DNS
        </label>
      </div>
      <ol className="devnet-list" data-testid="devnet-list">
        {rows.length === 0 ? (
          <li className="devnet-empty">
            <Radio size={16} aria-hidden />
            {snap.boards_note ?? "No traffic yet. Run the device: its requests show here."}
          </li>
        ) : null}
        {rows.map((r) => (
          <li key={r.key} className={`devnet-row tone-${r.tone} ${r.event ? "is-event" : ""}`} data-kind={r.label}>
            <div className="devnet-line">
              <span className="devnet-label">{r.label}</span>
              <span className="devnet-target" title={r.target}>
                {r.target}
              </span>
              {r.status ? <span className={`devnet-status tone-${r.tone}`}>{r.status}</span> : null}
            </div>
            <div className="devnet-meta">
              <span>{r.t}</span>
              {r.meta.map((m) => (
                <span key={m}>{m}</span>
              ))}
              {r.secrets?.map((s) => (
                <span key={s} className="devnet-secret" title="added at the sandbox edge; the value never reaches the device or this page">
                  [secret:{s}]
                </span>
              ))}
            </div>
            {r.frames ? <div className="devnet-frames">{r.frames}</div> : null}
            {r.samples?.length ? (
              <details className="devnet-samples">
                <summary>samples</summary>
                <pre>{r.samples.join("\n")}</pre>
              </details>
            ) : null}
            {r.why ? (
              <p className="devnet-why">
                Why: {r.why}
                {r.fix ? <><br />Fix: {r.fix}</> : null}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      {error ? <p className="devnet-error" role="alert">{error}</p> : null}
    </div>
  );
}
