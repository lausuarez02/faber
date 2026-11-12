/**
 * Round 12: the Case view's Build tab. How to build the device for this case, as Jumper worked it
 * out at design time: what to buy, what to print, the consumables and tools, then the steps one at
 * a time with a picture each (the part going in highlighted, the case open like a book for the
 * wires between the shells), and the assembly checks in plain words. Data: POST /api/case/assembly.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { caseApi, type AssemblyResult } from "../../case/api.ts";

const ACTION: Record<string, string> = {
  place: "Place",
  "press-fit": "Press in",
  screw: "Screw",
  glue: "Glue",
  solder: "Solder",
  tape: "Tape",
  "route-wire": "Wire",
  close: "Close",
  flash: "Flash",
  test: "Test",
};

export function AssemblyTab({ hash, working }: { hash: string | undefined; working: boolean }) {
  const [data, setData] = useState<AssemblyResult | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [at, setAt] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!hash || working) return;
    const n = ++seq.current;
    setBusy(true);
    setError(undefined);
    caseApi
      .assembly()
      .then((r) => {
        if (n !== seq.current) return;
        setData(r);
        setAt((a) => Math.min(a, Math.max(0, r.steps.length - 1)));
      })
      .catch((e) => n === seq.current && setError((e as Error).message))
      .finally(() => n === seq.current && setBusy(false));
  }, [hash, working]);

  if (!hash) return <div className="cv-faint">Design the case first: the build steps are worked out for its shape.</div>;
  if (!data)
    return (
      <div className="cv-asm" data-testid="case-assembly">
        {busy ? (
          <div className="cv-faint">
            <Loader2 size={14} className="spin" aria-hidden /> Working out how it goes together…
          </div>
        ) : null}
        {error ? (
          <div className="cv-error" role="alert" data-testid="case-assembly-error">
            {error}
          </div>
        ) : null}
      </div>
    );

  const step = data.steps[at]!;
  const bad = data.checks.filter((c) => c.id.startsWith("assembly-") && (!c.ok || c.severity === "warning"));
  const go = (i: number) => setAt(Math.max(0, Math.min(data.steps.length - 1, i)));
  return (
    <div className="cv-asm" data-testid="case-assembly">
      <p className="cv-lt-intro cv-faint">
        How to build it, worked out for this case: what goes into which half, in what order, when each wire is soldered, the battery last, a test before closing.
        {busy ? <Loader2 size={12} className="spin" aria-label="updating" /> : null}
      </p>

      {bad.length ? (
        <section aria-label="Things to know">
          <div className="cv-label">Things to know</div>
          <ul className="cv-checks" data-testid="case-assembly-problems">
            {bad.map((c, i) => (
              <li key={i} className={!c.ok ? "is-bad" : "is-warn"}>
                {!c.ok ? <XCircle size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}
                <span>{c.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="cv-asm-ok" data-testid="case-assembly-ok">
          <CheckCircle2 size={14} aria-hidden /> Every part can go in, every joint can be soldered, the wires fit.
        </div>
      )}

      <section aria-label="Steps" className="cv-asm-steps">
        <div className="cv-label">
          Step {step.n} of {data.steps.length}
        </div>
        <div className="cv-asm-step" data-testid="case-assembly-step">
          {step.image_url ? <img src={step.image_url} alt={`Step ${step.n}: ${step.title}`} data-testid="case-assembly-image" /> : <div className="cv-faint cv-asm-noimg">{data.pictures}</div>}
          <div className="cv-asm-title">
            <span className="cv-asm-action">{ACTION[step.action] ?? step.action}</span> <span data-testid="case-assembly-title">{step.title}</span>
          </div>
          <p className="cv-asm-say">{step.say}</p>
          {step.wires.length && step.wires.length <= 16 ? (
            <ul className="cv-asm-list" aria-label="Wires in this step">
              {step.wires.map((w) => (
                <li key={w.id}>
                  {w.id}: {w.from} → {w.to}, {w.color}, {w.length_mm} mm
                </li>
              ))}
            </ul>
          ) : null}
          {step.fasteners.map((f, i) => (
            <div key={i} className="cv-faint">
              {f.qty} × {f.kind} {f.size}
            </div>
          ))}
          {step.cautions.map((c, i) => (
            <div key={i} className="cv-asm-caution">
              <AlertTriangle size={12} aria-hidden /> {c}
            </div>
          ))}
        </div>
        <div className="cv-asm-nav">
          <button type="button" className="cv-secondary" aria-label="Previous step" data-testid="case-assembly-prev" disabled={at === 0} onClick={() => go(at - 1)}>
            <ChevronLeft size={14} aria-hidden /> Back
          </button>
          <div className="cv-asm-dots" role="tablist" aria-label="Steps">
            {data.steps.map((s, i) => (
              <button key={s.n} type="button" role="tab" aria-selected={i === at} aria-label={`Step ${s.n}: ${s.title}`} className={i === at ? "is-on" : ""} onClick={() => go(i)} />
            ))}
          </div>
          <button type="button" className="cv-secondary" aria-label="Next step" data-testid="case-assembly-next" disabled={at === data.steps.length - 1} onClick={() => go(at + 1)}>
            Next <ChevronRight size={14} aria-hidden />
          </button>
        </div>
      </section>

      <details className="cv-asm-more" data-testid="case-assembly-buy">
        <summary>To buy ({data.buy.length})</summary>
        <ul className="cv-asm-list">
          {data.buy.map((b, i) => (
            <li key={i}>
              {b.qty} × {b.name}
              {b.value ? ` ${b.value}` : ""}
              {b.notes ? <span className="cv-faint"> ({b.notes})</span> : null}
            </li>
          ))}
        </ul>
      </details>
      <details className="cv-asm-more" data-testid="case-assembly-print">
        <summary>To print ({data.print.length})</summary>
        <ul className="cv-asm-list">
          {data.print.map((p) => (
            <li key={p.file}>
              <a href={caseApi.fileUrl(p.file.replace(/^case\//, ""))}>{p.file.replace(/^case\/stl\//, "")}</a>
              <span className="cv-faint">
                {" "}
                ({p.face_down} face on the bed{p.supports ? ", supports" : ", no supports"})
              </span>
            </li>
          ))}
        </ul>
      </details>
      <details className="cv-asm-more">
        <summary>Consumables and tools</summary>
        <ul className="cv-asm-list">
          {data.consumables.map((c, i) => (
            <li key={i}>
              {c.item}: {c.qty} <span className="cv-faint">({c.why})</span>
            </li>
          ))}
          {data.tools.map((t) => (
            <li key={t} className="cv-faint">
              {t}
            </li>
          ))}
        </ul>
      </details>
      <details className="cv-asm-more">
        <summary>How each part is held</summary>
        <ul className="cv-asm-list">
          {data.mounts.map((m) => (
            <li key={m.part}>{m.say}</li>
          ))}
        </ul>
      </details>
      {error ? (
        <div className="cv-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
