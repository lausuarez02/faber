/**
 * Visual test report, rendered inside the Tests floating panel: per scenario pass / fail and a
 * filmstrip of the device at every check; click a frame to open the device at that exact moment.
 *
 * Where the report comes from, first that answers:
 *   1. `?report=<url>` (a faber-visual-report/1 JSON)
 *   2. the faber server: GET /api/visual-report (ProjectSession's latest run_tests)
 *   3. the example's prebuilt report: public/reports/<example>.json
 *      (node --import tsx packages/session/src/visual-report.ts examples/<name> apps/web/public/reports/<name>.json)
 */
import { useEffect, useState } from "react";
import { initialExample, useFaber } from "../../lib/app.ts";
import { VisualTestReportView } from "./VisualTestReportView.tsx";
import { isVisualReport, type VisualReport } from "./types.ts";

async function fetchReport(url: string): Promise<VisualReport | undefined> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return undefined;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return undefined;
    const body: unknown = await res.json();
    return isVisualReport(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

export function VisualTestReport({ report: given }: { report?: VisualReport } = {}) {
  const project = useFaber((s) => s.project);
  const firmware = useFaber((s) => s.firmware);
  const [state, setState] = useState<{ report?: VisualReport; note?: string; loading: boolean }>({ loading: !given, ...(given ? { report: given } : {}) });

  useEffect(() => {
    if (given) return;
    let dead = false;
    void (async () => {
      const q = new URLSearchParams(location.search).get("report");
      const base = import.meta.env.BASE_URL ?? "/";
      const tries: [string, string][] = [];
      if (q) tries.push([q, q]);
      tries.push([`/api/visual-report?project=${encodeURIComponent(project.name)}`, "session · latest run_tests"]);
      tries.push([`${base}reports/${initialExample.example}.json`, `examples/${initialExample.example} · prebuilt`]);
      for (const [url, note] of tries) {
        const r = await fetchReport(url);
        if (dead) return;
        if (r) return setState({ report: r, note, loading: false });
      }
      setState({ loading: false });
    })();
    return () => {
      dead = true;
    };
  }, [given, project.name]);

  if (state.loading) return <div className="vt vt-empty">Loading the test report…</div>;
  if (!state.report)
    return (
      <div className="vt vt-empty" data-testid="visual-test-report-empty">
        No visual test report for this project yet. Ask your agent to <code>run_tests</code>, or run the tests from a terminal:{" "}
        <code>pnpm faber test --visual -p &lt;project dir&gt;</code> (the server shows the newest report; reopen this panel)
      </div>
    );
  return <VisualTestReportView report={state.report} project={project} hex={firmware.status === "ready" ? firmware.hex : undefined} {...(state.note ? { sourceNote: state.note } : {})} />;
}
