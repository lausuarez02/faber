/**
 * Round 12, kit track: the Build it panel. Everything a person needs to make the device themselves,
 * in four tabs: Buy (the shopping list with store links, totals and tools), Print (each part of the
 * case with material, orientation, grams and time, or a print service), Assemble (step by step into
 * the case, with pictures, wires and checks, then troubleshooting) and Flash (how to put the program
 * on the board), plus Connect (round 13) for a device that reaches APIs: its keys by name, the relay
 * that holds them, a token per device, Wi-Fi, and what calls cost. Ticks are remembered in this browser. Downloads: the whole kit as a zip, a PDF, or
 * one page. Esc closes.
 */
import "./kit.css";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ClipboardCopy, Cpu, Wifi, Download, ExternalLink, FileText, Loader2, Package, Printer, ShoppingCart, Wrench, X } from "lucide-react";
import { kitApi, loadRegion, loadTicks, saveRegion, saveTicks, type BuildKit, type KitFiles, type ShopLine } from "../../kit/api.ts";
import { useKit } from "../../kit/store.ts";

type Tab = "buy" | "print" | "assemble" | "flash" | "connect";
const TABS: { id: Tab; label: string; icon: typeof ShoppingCart }[] = [
  { id: "buy", label: "Buy", icon: ShoppingCart },
  { id: "print", label: "Print", icon: Printer },
  { id: "assemble", label: "Assemble", icon: Wrench },
  { id: "flash", label: "Flash", icon: Cpu },
  { id: "connect", label: "Connect", icon: Wifi },
];
const REGIONS: { id: string; label: string }[] = [
  { id: "global", label: "Anywhere" },
  { id: "us", label: "US" },
  { id: "eu", label: "Europe" },
  { id: "uk", label: "UK" },
];
const SECTION: Record<ShopLine["section"], string> = { electronics: "Electronics", build: "For the build", case: "For the case" };
const usd = (n: number | null) => (n === null ? "–" : `$${n.toFixed(2)}`);
const fmtMin = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`);

export function BuildKitView({ onClose }: { onClose(): void }) {
  const epoch = useKit((s) => s.epoch);
  const [kit, setKit] = useState<BuildKit | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>("buy");
  const [region, setRegion] = useState<string>(() => loadRegion());
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [files, setFiles] = useState<KitFiles | undefined>();
  const [making, setMaking] = useState<string | undefined>();
  const [fileError, setFileError] = useState<string | undefined>();
  const [copied, setCopied] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    setKit(undefined);
    setError(undefined);
    setFiles(undefined);
    kitApi
      .get(region)
      .then((k) => {
        if (!live) return;
        setKit(k);
        setTicks(loadTicks(k.project));
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [epoch, region]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tick = (id: string, on: boolean) => {
    if (!kit) return;
    const next = { ...ticks, [id]: on };
    if (!on) delete next[id];
    setTicks(next);
    saveTicks(kit.project, next);
  };
  const toBuy = useMemo(() => (kit ? kit.shopping.lines.filter((l) => !l.may_have && !ticks[`buy:${l.id}`]).reduce((a, l) => a + (l.ext_usd ?? 0), 0) : 0), [kit, ticks]);
  const progress = (prefix: string, total: number) => `${Object.keys(ticks).filter((k) => k.startsWith(prefix) && ticks[k]).length}/${total}`;

  const download = async (kind: "zip" | "pdf" | "html") => {
    setFileError(undefined);
    let f = files;
    if (!f) {
      setMaking(kind);
      try {
        f = await kitApi.files(region);
        setFiles(f);
      } catch (e) {
        setFileError((e as Error).message);
        setMaking(undefined);
        return;
      }
      setMaking(undefined);
    }
    const url = kind === "zip" ? f.zip_url : kind === "pdf" ? f.pdf_url : f.html_url;
    if (!url) {
      const why = f.missing.find((m) => (kind === "pdf" ? m.item === "kit.pdf" : false));
      setFileError(kind === "pdf" ? `The PDF could not be made. Why: ${why?.why ?? "no PDF printer on this computer"}. Fix: open the page and print it to PDF from the browser.` : "That file was not made. Fix: try again.");
      return;
    }
    if (kind === "html") window.open(url, "_blank", "noopener");
    else {
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(undefined), 1500);
    } catch {
      setCopied(undefined);
    }
  };

  return (
    <div className="kit-view" data-testid="kit-view" role="dialog" aria-modal="true" aria-label="Build it">
      <header className="kv-head">
        <div className="kv-head-text">
          <div className="kv-title">Build it yourself</div>
          <div className="kv-sub">{kit?.project ?? "…"}</div>
        </div>
        <div className="kv-head-actions">
          <label className="kv-region" title="Where you shop: store links follow it">
            <span className="sr-only">Where you shop</span>
            <select value={region} data-testid="kit-region" onChange={(e) => (setRegion(e.target.value), saveRegion(e.target.value))}>
              {REGIONS.map((r) => (
                <option key={r.id} value={r.id}>
                  Shop: {r.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="kv-btn" disabled={!kit || !!making} onClick={() => void download("zip")} data-testid="kit-download-zip" title="Everything: the page, the PDF, the files to print and the file to flash">
            {making === "zip" ? <Loader2 size={14} className="spin" aria-hidden /> : <Package size={14} aria-hidden />} <span>Zip</span>
          </button>
          <button type="button" className="kv-btn" disabled={!kit || !!making} onClick={() => void download("pdf")} data-testid="kit-download-pdf">
            {making === "pdf" ? <Loader2 size={14} className="spin" aria-hidden /> : <FileText size={14} aria-hidden />} <span>PDF</span>
          </button>
          <button type="button" className="kv-btn" disabled={!kit || !!making} onClick={() => void download("html")} data-testid="kit-download-html" title="One page you can keep, print or send">
            {making === "html" ? <Loader2 size={14} className="spin" aria-hidden /> : <ExternalLink size={14} aria-hidden />} <span>Page</span>
          </button>
          <button type="button" className="icon-btn kv-close" aria-label="Close Build it" data-testid="kit-close" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>
      </header>
      {fileError ? (
        <div className="kv-alert" role="alert" data-testid="kit-file-error">
          <AlertTriangle size={14} aria-hidden /> {fileError}
        </div>
      ) : null}

      {!kit ? (
        <div className="kv-empty" data-testid="kit-loading">
          {error ? (
            <>
              <AlertTriangle size={28} aria-hidden />
              <div className="kv-empty-title">The build kit could not load</div>
              <div className="kv-empty-sub">{error}</div>
            </>
          ) : (
            <>
              <Loader2 size={24} className="spin" aria-hidden />
              <div className="kv-empty-sub">Working out what to buy, print and wire…</div>
            </>
          )}
        </div>
      ) : (
        <>
          <p className="kv-summary" data-testid="kit-summary">
            {kit.summary}
          </p>
          {kit.missing.length ? (
            <div className="kv-missing" data-testid="kit-missing">
              <b>Not ready yet:</b>
              <ul>
                {kit.missing.map((m) => (
                  <li key={m.item}>
                    {m.item}: {m.why}. To fix it: {m.say}.
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {kit.check_first?.length ? (
            <div className="kv-missing" data-testid="kit-check-first">
              <b>Check before you buy:</b> Jumper's design check found these in the circuit. Fix them first (ask your agent), or buy knowing why.
              <ul>
                {kit.check_first.map((c) => (
                  <li key={c.code}>
                    <b>{c.problem}</b>: {c.why} Fix: {c.fix}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="kv-tabs" role="tablist" aria-label="Build it">
            {TABS.filter((t) => t.id !== "connect" || kit.connect).map((t) => {
              const count = t.id === "buy" ? progress("buy:", kit.shopping.lines.length) : t.id === "print" ? progress("print:", kit.print.items.length) : t.id === "assemble" ? progress("step:", kit.steps.length) : "";
              return (
                <button key={t.id} type="button" role="tab" id={`kv-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="kv-pane" className={tab === t.id ? "is-on" : ""} data-testid={`kit-tab-${t.id}`} onClick={() => setTab(t.id)}>
                  <t.icon size={14} aria-hidden /> {t.label}
                  {count ? <span className="kv-count">{count}</span> : null}
                </button>
              );
            })}
          </div>
          <div id="kv-pane" role="tabpanel" aria-labelledby={`kv-tab-${tab}`} className="kv-pane">
            {tab === "buy" ? <BuyTab kit={kit} ticks={ticks} tick={tick} toBuy={toBuy} /> : null}
            {tab === "print" ? <PrintTab kit={kit} ticks={ticks} tick={tick} /> : null}
            {tab === "assemble" ? <AssembleTab kit={kit} ticks={ticks} tick={tick} /> : null}
            {tab === "flash" ? <FlashTab kit={kit} copy={copy} copied={copied} /> : null}
            {tab === "connect" && kit.connect ? <ConnectTab plan={kit.connect} copy={copy} copied={copied} /> : null}
          </div>
        </>
      )}
    </div>
  );
}

interface TabProps {
  kit: BuildKit;
  ticks: Record<string, boolean>;
  tick(id: string, on: boolean): void;
}

function Tick({ id, ticks, tick, label }: { id: string; ticks: Record<string, boolean>; tick(id: string, on: boolean): void; label: string }) {
  return <input type="checkbox" className="kv-tick" checked={!!ticks[id]} onChange={(e) => tick(id, e.target.checked)} aria-label={label} data-testid="kit-tick" />;
}

function BuyTab({ kit, ticks, tick, toBuy }: TabProps & { toBuy: number }) {
  return (
    <div>
      <div className="kv-totals" data-testid="kit-totals">
        <div className="kv-total-main">
          <span>Still to buy</span>
          <b data-testid="kit-total-to-buy">{usd(Math.round(toBuy * 100) / 100)}</b>
        </div>
        {kit.shopping.stores.map((s) => (
          <div key={s.store} className="kv-store">
            <span>{s.store}</span> <b>{usd(s.total_usd)}</b> <span className="kv-faint">{s.lines} {s.lines === 1 ? "thing" : "things"}</span>
          </div>
        ))}
        <div className="kv-store kv-faint">With what you may already have: {usd(kit.shopping.grand_total_usd)}</div>
      </div>
      {(["electronics", "build", "case"] as const).map((sec) => {
        const lines = kit.shopping.lines.filter((l) => l.section === sec);
        if (!lines.length) return null;
        return (
          <section key={sec}>
            <h3 className="kv-h">{SECTION[sec]}</h3>
            <ul className="kv-list">
              {lines.map((l) => (
                <li key={l.id} className={`kv-card ${ticks[`buy:${l.id}`] ? "is-done" : ""}`} data-testid="kit-buy-line">
                  <Tick id={`buy:${l.id}`} ticks={ticks} tick={tick} label={`Got ${l.name}`} />
                  <div className="kv-card-body">
                    <div className="kv-line-top">
                      <span className="kv-qty">{l.qty} ×</span>
                      <b>{l.name}</b>
                      {l.refs ? <span className="kv-faint"> ({l.refs})</span> : null}
                      {l.may_have ? <span className="kv-tag">you may have it</span> : null}
                      <span className="kv-price">{usd(l.ext_usd)}</span>
                    </div>
                    <div className="kv-variant">{l.variant || l.ask_for}</div>
                    {l.why ? <div className="kv-why">{l.why}</div> : null}
                    <div className="kv-links">
                      {l.links.map((k) => (
                        <a key={k.url} href={k.url} target="_blank" rel="noopener noreferrer" className="kv-link" title={`${k.store} (${k.region})${k.kind === "search" ? ": a store search" : ""}`}>
                          {k.store}
                          {k.kind === "search" ? <span className="kv-faint"> search</span> : null}
                        </a>
                      ))}
                    </div>
                    {l.no_link ? <div className="kv-why">{l.no_link}</div> : null}
                    {l.alternatives.length ? (
                      <details className="kv-alts">
                        <summary>Alternatives</summary>
                        <ul>
                          {l.alternatives.map((a) => (
                            <li key={a}>{a}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {kit.shopping.notes.map((n) => (
        <p key={n} className="kv-note">
          {n}
        </p>
      ))}
      <section data-testid="kit-tools">
        <h3 className="kv-h">Tools</h3>
        <p className="kv-meta">
          <b>{kit.tools.skill_why}</b> {kit.tools.time.note}
        </p>
        <ul className="kv-list">
          {kit.tools.items.map((t) => (
            <li key={t.name} className={`kv-card kv-card-slim ${ticks[`tool:${t.name}`] ? "is-done" : ""}`}>
              <Tick id={`tool:${t.name}`} ticks={ticks} tick={tick} label={`Have ${t.name}`} />
              <div className="kv-card-body">
                <b>{t.name}</b> <span className={`kv-tag is-${t.need}`}>{t.need}</span>
                <div className="kv-why">{t.why}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function PrintTab({ kit, ticks, tick }: TabProps) {
  const p = kit.print;
  if (!p.items.length)
    return (
      <p className="kv-note" data-testid="kit-print-empty">
        Nothing to print yet: the project has no case. Open the Case view, pick a shape and press Design case.
      </p>
    );
  return (
    <div>
      {p.stale ? <div className="kv-missing">{p.stale}</div> : null}
      <div className="kv-totals">
        <div className="kv-total-main">
          <span>About</span>
          <b>
            {Math.round(p.total_grams)} g · {fmtMin(p.total_minutes)}
          </b>
        </div>
        {p.plate ? (
          <a className="kv-btn" href={`/api/case/file?path=${encodeURIComponent(p.plate)}`} download data-testid="kit-plate">
            <Download size={14} aria-hidden /> Build plate (3MF, every part laid out)
          </a>
        ) : null}
      </div>
      <ul className="kv-list">
        {p.items.map((i) => (
          <li key={i.file} className={`kv-card ${ticks[`print:${i.file}`] ? "is-done" : ""}`} data-testid="kit-print-item">
            <Tick id={`print:${i.file}`} ticks={ticks} tick={tick} label={`Printed ${i.label}`} />
            <div className="kv-card-body">
              <div className="kv-line-top">
                <b>{i.label}</b>
                <span className="kv-price">
                  {i.grams} g · {fmtMin(i.minutes)}
                </span>
              </div>
              <div className="kv-variant">
                {i.color_hex ? <span className="kv-swatch" style={{ background: i.color_hex }} aria-hidden /> : null}
                {i.size_mm ? <span data-testid="kit-print-size">{i.size_mm.join(" × ")} mm · </span> : null}
                {i.material}, {i.color} · {i.layer_mm} mm layers · {i.infill_pct} % infill · {i.supports ? "with supports" : "no supports"}
              </div>
              <div className="kv-why">Lay it: {i.orientation}</div>
              {i.note ? <div className="kv-why">{i.note}</div> : null}
              <a className="kv-link" href={`/api/case/file?path=${encodeURIComponent(i.file)}`} download>
                <Download size={12} aria-hidden /> {i.file.split("/").pop()}
              </a>
            </div>
          </li>
        ))}
      </ul>
      <p className="kv-note">{p.method}</p>
      {p.slicer.why ? <p className="kv-note">{p.slicer.why}</p> : null}
      <h3 className="kv-h">Settings</h3>
      <ul className="kv-bullets">
        {p.settings.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <h3 className="kv-h">No printer? Send it to a print service</h3>
      <ul className="kv-bullets" data-testid="kit-print-service">
        {p.service.say.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

function AssembleTab({ kit, ticks, tick }: TabProps) {
  const groups: [string, (s: string) => boolean][] = [
    ["Common problems", (s) => s === "general" || s === "part" || s === "case"],
    ["What Jumper's checks said", (s) => s === "check_design"],
    ["Check on the real device", (s) => s === "fidelity"],
  ];
  return (
    <div>
      <p className="kv-meta">{kit.tools.time.note}</p>
      <ol className="kv-steps">
        {kit.steps.map((s) => {
          const img = s.image ? kitApi.imageUrl(s.image) : undefined;
          return (
            <li key={s.n} className={`kv-step ${ticks[`step:${s.n}`] ? "is-done" : ""}`} data-testid="kit-step">
              <div className="kv-step-head">
                <Tick id={`step:${s.n}`} ticks={ticks} tick={tick} label={`Done step ${s.n}`} />
                <h3>
                  {s.n}. {s.title}
                </h3>
                {s.minutes ? <span className="kv-tag">about {s.minutes} min</span> : null}
              </div>
              {img ? <img className="kv-step-img" src={img} alt={s.image_alt ?? s.title} loading="lazy" /> : null}
              <ul className="kv-bullets">
                {s.do.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
              {s.wires.length ? (
                <ul className="kv-wires" aria-label="Wires">
                  {s.wires.map((w) => (
                    <li key={w.wire} className={ticks[`wire:${s.n}:${w.wire}`] ? "is-done" : ""}>
                      <Tick id={`wire:${s.n}:${w.wire}`} ticks={ticks} tick={tick} label={`Done wire ${w.wire}`} />
                      <span className="kv-wire-color" style={{ background: wireColor(w.color) }} aria-hidden />
                      <span className="kv-wire-main">
                        <b>{w.wire}</b> {w.from_label} <span className="kv-faint">→</span> {w.to_label}
                      </span>
                      <span className="kv-wire-cut">
                        {w.color}, {w.length_mm} mm, {w.gauge_awg} AWG
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {s.cautions.map((c) => (
                <div key={c} className="kv-caution">
                  <AlertTriangle size={13} aria-hidden /> {c}
                </div>
              ))}
              {s.check ? (
                <div className="kv-check">
                  <CheckCircle2 size={13} aria-hidden /> <b>Check before going on:</b> {s.check}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <section data-testid="kit-trouble">
        <h3 className="kv-h">If something does not work</h3>
        {groups.map(([title, f]) => {
          const rows = kit.troubleshooting.filter((t) => f(t.source));
          if (!rows.length) return null;
          return (
            <details key={title} className="kv-trouble" open={title === "Common problems"}>
              <summary>
                {title} <span className="kv-faint">({rows.length})</span>
              </summary>
              <ul>
                {rows.map((t, i) => (
                  <li key={i}>
                    <b>{t.problem}</b>
                    <div className="kv-why">Why: {t.why}</div>
                    <div>Fix: {t.fix}</div>
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </section>
    </div>
  );
}

function FlashTab({ kit, copy, copied }: { kit: BuildKit; copy(t: string): void; copied?: string }) {
  const f = kit.flash;
  return (
    <div data-testid="kit-flash">
      <p className="kv-meta">
        Board: <b>{f.board}</b>
        {f.cable ? <> · Cable: {f.cable}</> : null}
        {f.kit_file ? (
          <>
            {" "}
            · File: <code>{f.kit_file}</code> in the zip (made from <code>{f.file}</code> in the project)
          </>
        ) : null}
      </p>
      {f.why_missing ? <div className="kv-missing">{f.why_missing}.</div> : null}
      <ol className="kv-bullets kv-ol">
        {f.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {f.commands.map((c) => (
        <div key={c.cmd} className="kv-cmd">
          <div className="kv-cmd-label">{c.label}</div>
          <pre>{c.cmd}</pre>
          <button type="button" className="kv-btn kv-copy" onClick={() => copy(c.cmd)} aria-label={`Copy: ${c.label}`}>
            <ClipboardCopy size={13} aria-hidden /> {copied === c.cmd ? "Copied" : "Copy"}
          </button>
        </div>
      ))}
      {f.needs.length ? <p className="kv-note">You need: {f.needs.map((n) => n.replace(/\.$/, "")).join("; ")}.</p> : null}
    </div>
  );
}

function ConnectTab({ plan, copy, copied }: { plan: NonNullable<BuildKit["connect"]>; copy(t: string): void; copied?: string }) {
  return (
    <div data-testid="kit-connect">
      {plan.warning ? <div className="kv-missing">{plan.warning}</div> : null}
      <p className="kv-meta">{plan.summary}</p>
      {plan.secrets.length ? (
        <ul className="kv-bullets" aria-label="API keys">
          {plan.secrets.map((x) => (
            <li key={x.name}>
              <code>{x.name}</code> {x.hosts.length ? <>for {x.hosts.join(", ")}: </> : ": "}
              {x.set ? <span className="kv-ok">set on this computer</span> : <span className="kv-warn">not set yet (add it to the project's .env)</span>}
            </li>
          ))}
        </ul>
      ) : null}
      {plan.steps.map((st, i) => (
        <section key={st.title} className="kv-connect-step">
          <h3>
            {i + 1}. {st.title}
          </h3>
          <ul className="kv-bullets">
            {st.do.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          {(st.commands ?? []).map((c) => (
            <div key={c.cmd} className="kv-cmd">
              <div className="kv-cmd-label">{c.label}</div>
              <pre>{c.cmd}</pre>
              <button type="button" className="kv-btn kv-copy" onClick={() => copy(c.cmd)} aria-label={`Copy: ${c.label}`}>
                <ClipboardCopy size={13} aria-hidden /> {copied === c.cmd ? "Copied" : "Copy"}
              </button>
            </div>
          ))}
        </section>
      ))}
      <h3>What it costs</h3>
      <ul className="kv-bullets">
        {plan.cost.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      {plan.notes.map((n) => (
        <p key={n} className="kv-note">
          {n}
        </p>
      ))}
    </div>
  );
}

const NAMED: Record<string, string> = { red: "#ff4d2e", black: "#2b3038", yellow: "#f2e14a", blue: "#4da3ff", white: "#e9edf2", purple: "#b47cff", green: "#5cf2a1", orange: "#ffb23f" };
function wireColor(name: string): string {
  return NAMED[name] ?? "transparent";
}
