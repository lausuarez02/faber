// Floating "Network" panel: the sandbox Wi-Fi the simulated device joined, every request it made
// (method, path, status, latency, who answered, the body), and the Mock / Live switch for the AI.
import { useEffect, useMemo, useReducer, useState } from "react";
import { Bot, Globe, Radio, Send, Wifi, WifiOff, X } from "lucide-react";
import type { SandboxNet } from "@fabwright/ai-gateway";
import { toRows } from "./model.ts";
import { DEFAULT_GATEWAY, discoverGateway, GATEWAY_COMMAND, probeGateway, useGateway } from "./webNetwork.ts";
import "./network.css";

export interface NetworkPanelProps {
  net: SandboxNet;
  gatewayUrl?: string;
  onClose?: () => void;
  /** Show Wi-Fi / DNS / TCP events between requests. Default true. */
  showEvents?: boolean;
}

/** The person's message to the pet; it rides on the pet's next question to the AI (SandboxNet.say). */
export function PetTalkBox({ net, onSent }: { net: SandboxNet; onSent?: () => void }) {
  const [text, setText] = useState("");
  const waiting = net.waitingMessage;
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    net.say(text);
    setText("");
    onSent?.();
  };
  return (
    <form className="netp-talk" onSubmit={send} aria-label="Talk to the pet">
      <label className="netp-talk-label" htmlFor="netp-talk-input">
        Say something to the pet
      </label>
      <div className="netp-talk-row">
        <input id="netp-talk-input" value={text} maxLength={60} placeholder="What is your favourite food?" onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={!text.trim()} aria-label="Send to the pet">
          <Send size={14} aria-hidden /> Send
        </button>
      </div>
      <p className="netp-talk-hint" role="status">
        {waiting ? `"${waiting}" goes with the pet's next question to the AI. Press TALK on the device.` : "It goes with the pet's next question to the AI (press TALK). Mock answers are canned; Live asks Claude."}
      </p>
    </form>
  );
}

export function NetworkPanel({ net, gatewayUrl, onClose, showEvents = true }: NetworkPanelProps) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [liveError, setLiveError] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [events, setEvents] = useState(showEvents);

  useEffect(() => {
    let raf = 0;
    const off = net.onLog(() => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), bump()));
    });
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [net]);

  const status = net.status();
  const rows = useMemo(() => toRows(net.log, { showEvents: events }), [net, net.log.length, events, status.mode, net.pending]); // eslint-disable-line react-hooks/exhaustive-deps
  const stations = Object.entries(status.stations);
  const joined = stations.length > 0;

  const setMode = async (mode: "mock" | "live") => {
    setLiveError(undefined);
    if (mode === "mock") {
      net.setMode("mock");
      bump();
      return;
    }
    setChecking(true);
    const url = gatewayUrl ?? (await discoverGateway(DEFAULT_GATEWAY));
    const p = await probeGateway(url);
    setChecking(false);
    if (!p.ok) {
      setLiveError(`${p.error}. Fix: ${GATEWAY_COMMAND}`);
      return;
    }
    useGateway(net, url);
    net.setMode("live");
    bump();
  };

  return (
    <section className="netp" aria-label="Network">
      <header className="netp-head">
        <Globe size={15} aria-hidden />
        <h2>Network</h2>
        <span className={`netp-chip ${status.wifiDropped ? "err" : joined ? "ok" : "muted"}`}>
          {status.wifiDropped ? <WifiOff size={13} aria-hidden /> : <Wifi size={13} aria-hidden />}
          {status.wifiDropped ? "Wi-Fi dropped" : joined ? `FabwrightNet · ${stations.map(([p]) => p).join(", ")}` : "FabwrightNet · nobody joined"}
        </span>
        {onClose && (
          <button className="netp-icon" onClick={onClose} aria-label="Close network panel">
            <X size={15} />
          </button>
        )}
      </header>

      <div className="netp-ai">
        <div className="netp-ai-label">
          <Bot size={14} aria-hidden />
          <span>Pet AI</span>
          <span className="netp-muted">ai.fabwright</span>
        </div>
        <div className="netp-seg" role="radiogroup" aria-label="AI mode">
          <button role="radio" aria-checked={status.mode === "mock"} className={status.mode === "mock" ? "on" : ""} onClick={() => void setMode("mock")}>
            Mock
          </button>
          <button role="radio" aria-checked={status.mode === "live"} className={status.mode === "live" ? "on" : ""} onClick={() => void setMode("live")} disabled={checking}>
            {checking ? "Checking…" : "Live"}
          </button>
        </div>
      </div>
      <p className="netp-provider">
        Answering: <strong>{status.mode === "live" ? (status.liveAllowed ? "Claude via the AI gateway" : "Mock (live pauses while the sim runs faster than real time)") : "Mock (deterministic)"}</strong>
      </p>
      {liveError && (
        <p className="netp-error" role="alert">
          Live AI is not available: {liveError}
        </p>
      )}

      <PetTalkBox net={net} onSent={bump} />

      <div className="netp-list-head">
        <span>Requests</span>
        <label className="netp-toggle">
          <input type="checkbox" checked={events} onChange={(e) => setEvents(e.target.checked)} /> Wi-Fi events
        </label>
      </div>
      <ol className="netp-list">
        {rows.length === 0 && (
          <li className="netp-empty">
            <Radio size={16} aria-hidden />
            No traffic yet. Run the simulation: a Wi-Fi module joins FabwrightNet in about 2.5 s, then its requests show here.
          </li>
        )}
        {rows.map((r) =>
          r.type === "request" ? (
            <li key={r.key} className={`netp-req ${r.tone}`}>
              <div className="netp-req-line">
                <span className="netp-method">{r.method}</span>
                <span className="netp-target" title={r.target}>
                  {r.target}
                </span>
                <span className={`netp-status ${r.tone}`}>{r.status}</span>
              </div>
              <div className="netp-req-meta">
                <span>{r.t}</span>
                {r.latency && <span>{r.latency}</span>}
                {r.provider && <span className="netp-prov">{r.provider}</span>}
              </div>
              {r.body && <pre className="netp-body">{r.body}</pre>}
              {r.note && <p className="netp-note">{r.note}</p>}
            </li>
          ) : (
            <li key={r.key} className={`netp-evt ${r.tone}`}>
              <span className="netp-evt-t">{r.t}</span>
              <span className="netp-evt-kind">{r.kind}</span>
              <span className="netp-evt-text">{r.text}</span>
            </li>
          ),
        )}
      </ol>
    </section>
  );
}
