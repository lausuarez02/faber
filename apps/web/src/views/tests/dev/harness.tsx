// Standalone Tests panel (dev and screenshots): the visual report of an example inside a floating
// panel like the app's, with scrubbing.
//   http://localhost:5287/src/views/tests/dev/index.html?example=tamagotchi
// Params: example=<name>, open=<scenario id,…>, scrub=<scenario id>@<ms>, theme=light.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../../../../../../brand/tokens.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadExample, loadExampleFirmware } from "../../../lib/examples.ts";
import { VisualTestReportView } from "../VisualTestReportView.tsx";
import { ScrubView } from "../ScrubView.tsx";
import { isVisualReport, type VisualReport } from "../types.ts";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") document.documentElement.setAttribute("data-theme", "light");
document.body.style.cssText = "margin:0;min-height:100vh;background:var(--bg-canvas);background-image:radial-gradient(var(--dot) 1.2px, transparent 1.2px);background-size:22px 22px;";

function Harness() {
  const name = params.get("example") ?? "tamagotchi";
  const ex = loadExample(name);
  const [hex, setHex] = useState<string | undefined>();
  const [report, setReport] = useState<VisualReport | undefined>();
  const [err, setErr] = useState<string | undefined>();
  useEffect(() => {
    void loadExampleFirmware(ex.example, ex.project).then((f) => setHex(f?.hex));
    fetch(`/reports/${name}.json`)
      .then((r) => r.json())
      .then((j: unknown) => (isVisualReport(j) ? setReport(j) : setErr(`/reports/${name}.json is not a visual report`)))
      .catch((e: unknown) => setErr(String(e)));
    (window as unknown as { __tests: { ready: boolean } }).__tests = { ready: false };
  }, [name, ex.example, ex.project]);
  useEffect(() => {
    if (report && hex) setTimeout(() => ((window as unknown as { __tests: { ready: boolean } }).__tests.ready = true), 300);
  }, [report, hex]);
  if (err) return <pre style={{ color: "#f2555a", padding: 24 }}>{err}</pre>;
  if (!report || !hex) return null;
  const scrub = params.get("scrub");
  if (scrub) {
    const [id, at] = scrub.split("@");
    const sc = report.scenarios.find((s) => s.id === id) ?? report.scenarios[0]!;
    return <ScrubView project={ex.project} hex={hex} scenario={sc} initialT={Number(at ?? 0)} onClose={() => history.back()} />;
  }
  const open = params.get("open")?.split(",");
  const mobile = window.innerWidth < 640;
  return (
    <aside
      style={{
        position: "fixed",
        ...(mobile ? { left: 8, right: 8, bottom: 8, maxHeight: "72vh" } : { top: 76, right: 16, width: 440, maxHeight: "calc(100vh - 100px)" }),
        overflow: "auto",
        background: "var(--bg-float)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        boxShadow: "var(--shadow-float)",
        padding: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10, font: "500 14px var(--font-ui)", color: "var(--fg)" }}>Tests</div>
      <VisualTestReportView report={report} project={ex.project} hex={hex} sourceNote={`examples/${name}`} {...(open ? { open } : {})} />
    </aside>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
