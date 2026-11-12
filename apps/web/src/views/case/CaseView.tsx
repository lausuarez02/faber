/**
 * Round 6, case track: the Case view. A full-canvas overlay (like the Device view) that shows the
 * printable case around the parts in 3D, with a see-through and an explode slider, a shape picker,
 * the parameters, the fit checks, the overall size and the pocket verdict, and download buttons for
 * every file plus the factory pack. Geometry comes from jumper serve (GET /api/case/mesh): the
 * browser never loads the CAD engine. Esc closes.
 */
import "./case.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { AlertTriangle, Box, CheckCircle2, Download, Loader2, Package, X, XCircle } from "lucide-react";
import type { Enclosure } from "@jumper/project-format";
import { caseApi, decodeF32, decodeU32, type AdviceNote, type CaseMesh, type CaseReport, type CaseState, type CostsResult, type FitResult, type LayoutProposal, type LayoutsResult } from "../../case/api.ts";
import { fitTo, resampleClosed, startPoints, toOutline, type Pt } from "../../case/outline.ts";
import { useCase } from "../../case/store.ts";
import { LayoutTab, partColors, type Pins } from "./LayoutTab.tsx";
import { AssemblyTab } from "./AssemblyTab.tsx";
import { OutlineEditor, type SizeDraft } from "./OutlineEditor.tsx";

const SHAPES: { id: Enclosure["shape"]; label: string; hint: string }[] = [
  { id: "pebble", label: "Pebble", hint: "organic oval, rounded all over" },
  { id: "puck", label: "Puck", hint: "round, centred on the screen" },
  { id: "rounded-box", label: "Box", hint: "rounded rectangle, the most compact" },
  { id: "pill", label: "Pill", hint: "capsule" },
  { id: "keychain", label: "Keychain", hint: "box with a lanyard tab" },
  { id: "custom", label: "Custom", hint: "any outline you draw (an egg, a heart, a bean ...) at any size" },
];

type Params = NonNullable<Enclosure["params"]>;

export function CaseView({ onClose }: { onClose(): void }) {
  const epoch = useCase((s) => s.epoch);
  const [state, setState] = useState<CaseState | undefined>();
  const [mesh, setMesh] = useState<CaseMesh | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [shape, setShape] = useState<Enclosure["shape"]>("pebble");
  const [params, setParams] = useState<Params>({});
  const [opacity, setOpacity] = useState(0.35);
  const [explode, setExplode] = useState(0);
  const [pack, setPack] = useState<{ url?: string; missing: { item: string; why: string; fix: string; say?: string }[] } | undefined>();
  // round 7: the custom outline being drawn (mm, y up), its size (blank = auto) and the live fit
  const [points, setPoints] = useState<Pt[]>(() => startPoints("ellipse"));
  const [size, setSize] = useState<SizeDraft>({});
  const [fit, setFit] = useState<FitResult | undefined>();
  const [fitBusy, setFitBusy] = useState(false);
  const [fitError, setFitError] = useState<string | undefined>();
  const fitSeq = useRef(0);
  // round 8: the distributions Jumper proposes and the one picked ("auto" = its best)
  const [layout, setLayout] = useState<string>("auto");
  const [layouts, setLayouts] = useState<LayoutsResult | undefined>();
  const [layoutsBusy, setLayoutsBusy] = useState(false);
  const [layoutsError, setLayoutsError] = useState<string | undefined>();
  const layoutSeq = useRef(0);
  // round 8 (view): the Layout tab, the proposal previewed, the parts placed by hand, the parts advice
  const [tab, setTab] = useState<"shape" | "layout" | "build">("shape");
  const [selected, setSelected] = useState<string | undefined>();
  const [stageMode, setStageMode] = useState<"case" | "preview">("case");
  const [pins, setPins] = useState<Pins>({});
  const [advice, setAdvice] = useState<AdviceNote[] | undefined>();
  const [adviceBusy, setAdviceBusy] = useState<string | undefined>();
  const [adviceError, setAdviceError] = useState<string | undefined>();
  const [adviceDone, setAdviceDone] = useState<string | undefined>();
  const [partsTick, setPartsTick] = useState(0);
  // round 8b: what each choice in the saved case adds, and the Apply of one
  const [costs, setCosts] = useState<CostsResult | undefined>();
  const [costsBusy, setCostsBusy] = useState(false);
  const [costsError, setCostsError] = useState<string | undefined>();
  const [costApplying, setCostApplying] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  // the last part moved, and where it was before (put back when Jumper cannot fit the rest around it)
  const lastPin = useRef<{ id: string; before: Pins[string] | undefined } | undefined>(undefined);
  const report = state?.report;
  const hashRef = useRef<string | undefined>(undefined);
  const untouched = useRef<string | undefined>(undefined);

  const load = async (withMesh: boolean) => {
    try {
      const st = await caseApi.get();
      setState(st);
      setError(undefined);
      if (st.enclosure && hashRef.current === undefined) {
        setShape(st.enclosure.shape);
        setParams(st.enclosure.params ?? {});
        // a custom outline (the person's points, or the silhouette of one an agent drew) opens in the editor
        const o = st.enclosure.outline;
        if (o && typeof o === "object" && "points" in o) setPoints(o.points as Pt[]);
        else if (st.enclosure.shape === "custom" && st.report?.outline_mm?.length) {
          // an outline an agent drew as a path opens as points to edit; until they are edited, the
          // path itself is what the previews and Update case use (the points only approximate it)
          const pts = resampleClosed(st.report.outline_mm, 14);
          untouched.current = JSON.stringify(pts);
          setPoints(pts);
        } else if (st.enclosure.shape === "custom") untouched.current = "pending"; // no case built yet: the points come with it
        setSize({ ...(st.enclosure.size_mm ?? {}) });
        setLayout(st.enclosure.layout ?? "auto");
      }
      if (untouched.current === "pending" && st.enclosure?.shape === "custom" && st.report?.outline_mm?.length) {
        const pts = resampleClosed(st.report.outline_mm, 14);
        untouched.current = JSON.stringify(pts);
        setPoints(pts);
      }
      const h = st.report?.hash;
      if (st.enclosure && (withMesh || st.stale || h !== hashRef.current)) {
        const m = await caseApi.mesh();
        setMesh(m);
        hashRef.current = m.hash;
        if (st.stale) setState(await caseApi.get());
      }
      if (!st.enclosure) {
        setMesh(undefined);
        hashRef.current = undefined;
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // open, and on project switch (R8): drop the old project's case and reload
  useEffect(() => {
    setState(undefined);
    setMesh(undefined);
    setPack(undefined);
    hashRef.current = undefined;
    untouched.current = undefined;
    setPins({});
    void load(true);
    // follow agent changes (design_case / update_case over MCP) while the view is open
    const t = setInterval(() => void load(false), 4000);
    return () => clearInterval(t);
  }, [epoch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const saved = state?.enclosure;
  // the saved placements (the agent's and the person's) with the parts moved here since
  const placements = useMemo(() => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(saved?.placements ?? {})) out[k] = { ...v };
    for (const [k, v] of Object.entries(pins)) {
      const one = { ...(out[k] ?? {}) };
      delete one.x_mm;
      delete one.y_mm;
      if (v) Object.assign(one, v);
      if (Object.keys(one).length) out[k] = one;
      else delete out[k];
    }
    return out;
  }, [saved?.placements, pins]);
  const outlineNow = () => (saved?.outline !== undefined && (untouched.current === "pending" || untouched.current === JSON.stringify(points)) ? saved.outline : toOutline(points));
  const draft = (): Record<string, unknown> => ({ shape, params, layout, ...(Object.keys(placements).length ? { placements } : {}), ...(shape === "custom" ? { outline: outlineNow(), size_mm: { w: size.w ?? null, h: size.h ?? null, d: size.d ?? null } } : { size_mm: null }) });
  const sizeKey = JSON.stringify({ w: size.w, h: size.h, d: size.d });
  const savedSizeKey = JSON.stringify({ w: saved?.size_mm?.w, h: saved?.size_mm?.h, d: saved?.size_mm?.d });
  const dirty = !saved || Object.keys(pins).length > 0 || saved.shape !== shape || (saved.layout ?? "auto") !== layout || JSON.stringify(saved.params ?? {}) !== JSON.stringify(params) || (shape === "custom" && (JSON.stringify(saved.outline ?? null) !== JSON.stringify(outlineNow()) || sizeKey !== savedSizeKey));

  // the live fit while drawing (no CAD on the server, under a second), the newest answer wins
  useEffect(() => {
    if (shape !== "custom") {
      setFit(undefined);
      setFitError(undefined);
      return;
    }
    const seq = ++fitSeq.current;
    setFitBusy(true);
    const t = setTimeout(() => {
      caseApi
        .fit(draft())
        .then((r) => {
          if (seq !== fitSeq.current) return;
          setFit(r);
          setFitError(undefined);
        })
        .catch((e: Error) => {
          if (seq !== fitSeq.current) return;
          setFit(undefined);
          setFitError(e.message);
        })
        .finally(() => seq === fitSeq.current && setFitBusy(false));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, JSON.stringify(points), sizeKey, JSON.stringify(params), epoch]);

  // the proposals for the shape as drawn (a second or two on the server), the newest answer wins
  useEffect(() => {
    const seq = ++layoutSeq.current;
    setLayoutsBusy(true);
    const t = setTimeout(() => {
      const { layout: _l, ...body } = draft();
      void _l;
      caseApi
        .layouts({ ...body, views: true })
        .then((r) => {
          if (seq !== layoutSeq.current) return;
          // a part moved where the others no longer fit around it: put it back and say so
          const lp = lastPin.current;
          lastPin.current = undefined;
          const lost = r.proposals.find((q) => q.id === r.best)?.warnings.filter((w) => /could not be placed/.test(w)).map((w) => w.split(" ")[0]!) ?? [];
          if (lp && lost.length) {
            setPins((p0) => {
              const n = { ...p0 };
              if (lp.before === undefined) delete n[lp.id];
              else n[lp.id] = lp.before;
              return n;
            });
            setNotice(`With ${lp.id} there, Jumper could not fit ${lost.filter((x) => x !== lp.id).join(", ") || "the other parts"} around it, so ${lp.id} went back. Try another spot.`);
            return;
          }
          setLayouts(r);
          setLayoutsError(undefined);
        })
        .catch((e: Error) => {
          if (seq !== layoutSeq.current) return;
          setLayouts(undefined);
          setLayoutsError(e.message);
        })
        .finally(() => seq === layoutSeq.current && setLayoutsBusy(false));
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, JSON.stringify(points), sizeKey, JSON.stringify(params), JSON.stringify(placements), report?.hash, partsTick, epoch]);

  // the agent changed the layout (update_case {layout}): follow it
  useEffect(() => {
    setLayout(saved?.layout ?? "auto");
    setSelected(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.layout]);

  // the parts advice, again whenever the case or the parts change
  useEffect(() => {
    let live = true;
    caseApi
      .advice()
      .then((r) => live && (setAdvice(r.notes), setAdviceError(undefined)))
      .catch((e: Error) => live && setAdviceError(e.message));
    return () => {
      live = false;
    };
  }, [report?.hash, partsTick, epoch]);

  // round 8b: the costs of the saved case's choices, when the Layout tab is open (a few seconds on the server)
  useEffect(() => {
    if (tab !== "layout" || !saved || busy || adviceBusy) return;
    let live = true;
    setCostsBusy(true);
    const t = setTimeout(() => {
      caseApi
        .costs({ budget_ms: 5000 })
        .then((r) => live && (setCosts(r), setCostsError(undefined)))
        .catch((e: Error) => live && setCostsError(e.message))
        .finally(() => live && setCostsBusy(false));
    }, 600);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, report?.hash, partsTick, epoch, !!saved, !!busy, !!adviceBusy]);

  /** Relax one choice (or all of them): the change is the case settings that drop it, saved like Update case. */
  const applyCost = async (id: string, change: Record<string, unknown>) => {
    setCostApplying(id);
    try {
      const d = draft();
      const over: Record<string, unknown> = {};
      const nulls = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
      if (change.params) {
        const p = nulls({ ...((d.params as Record<string, unknown>) ?? {}), ...(change.params as Record<string, unknown>) });
        over.params = p;
        setParams(p as Params);
      }
      if (change.size_mm) {
        const sz = { ...((d.size_mm as Record<string, unknown>) ?? {}), ...(change.size_mm as Record<string, unknown>) };
        over.size_mm = sz;
        setSize(nulls(sz) as SizeDraft);
      }
      if (change.placements) {
        const pl: Record<string, unknown> = { ...((d.placements as Record<string, unknown>) ?? {}) };
        for (const [k, v] of Object.entries(change.placements as Record<string, Record<string, unknown>>)) pl[k] = { ...((pl[k] as object) ?? {}), ...v };
        over.placements = pl;
      }
      await apply(over);
    } finally {
      setCostApplying(undefined);
    }
  };

  const applyAdvice = async (id: string) => {
    setAdviceBusy(id);
    setAdviceDone(undefined);
    try {
      const r = await caseApi.applyAdvice(id);
      setAdvice(r.notes);
      setAdviceDone(r.result);
      setAdviceError(undefined);
      setPartsTick((n) => n + 1);
      void load(false); // the parts changed: the case is rebuilt with them
    } catch (e) {
      setAdviceError((e as Error).message);
    } finally {
      setAdviceBusy(undefined);
    }
  };

  const pickShape = (id: Enclosure["shape"]) => {
    if (id === "custom" && shape !== "custom") {
      // start from the shape the case is now, at its size
      const w = report?.size_mm.w ?? 60;
      const h = report?.size_mm.h ?? 76;
      setPoints(report?.outline_mm?.length ? resampleClosed(report.outline_mm, 14) : startPoints(shape, w, h));
    }
    setShape(id);
  };

  const apply = async (over: Record<string, unknown> = {}) => {
    setBusy(saved ? "Updating the case…" : "Designing the case…");
    setPack(undefined);
    try {
      // a part let go back to automatic is sent as null fields (update_case removes them)
      const unpin: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(pins)) unpin[k] = v ? { ...(saved?.placements?.[k] ?? {}), x_mm: v.x_mm ?? null, y_mm: v.y_mm ?? null } : { x_mm: null, y_mm: null };
      const body = { ...draft(), ...(Object.keys(unpin).length && saved ? { placements: unpin } : {}), ...over };
      const r = (await caseApi.save(body as Partial<Enclosure>)) as CaseReport & { fits?: boolean; saved?: boolean };
      if (r.fits === false && r.saved === false) {
        // a fixed size that cannot hold the parts: nothing was saved; the fit panel says what to change
        setFit(r as unknown as FitResult);
        setError("The parts do not fit that size, so nothing was saved. Why: the size is fixed (W x H x D). Fix: pick a change under What would fit, or clear a size to make it auto.");
        return;
      }
      setError(undefined);
      setPins({});
      hashRef.current = "";
      await load(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const makePack = async () => {
    setBusy("Writing the factory pack…");
    try {
      const r = await caseApi.pack();
      setPack({ ...(r.url ? { url: r.url } : {}), missing: r.missing });
      if (r.url) {
        const a = document.createElement("a");
        a.href = r.url;
        a.download = r.url.split("/").pop() ?? "pack.zip";
        a.click();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const set = <K extends keyof Params>(k: K, v: Params[K]) => setParams((p) => ({ ...p, [k]: v }));
  const files = useMemo(() => (report?.files ?? []).map((f) => (typeof f === "string" ? f : f.path)), [report]);
  const has = (p: string) => files.includes(p);
  // the shapes made side by side, without the one the case is now (it is the case above)
  const otherShapes = (state?.variants ?? []).filter((v) => v.shape !== (report?.shape ?? saved?.shape));
  // round 8: the proposal shown in the Layout tab (the one the case uses until another is picked)
  const chosenId = layout === "auto" ? (layouts?.best ?? "balanced") : layout;
  const shown: LayoutProposal | undefined = layouts?.proposals.find((q) => q.id === (selected ?? chosenId)) ?? layouts?.proposals.find((q) => q.id === layouts.best);
  const preview = tab === "layout" && stageMode === "preview" && !!shown?.views;
  // the built case is not what Jumper would now do: an old one (before round 8) or another size
  const builtAs = report?.layout ? layouts?.proposals.find((q) => q.id === report.layout!.goal) : undefined;
  const staleMsg = !report || dirty || busy
    ? undefined
    : !report.layout
      ? "This case was built before Jumper worked out where the parts go: they are stacked front to back. Let Jumper spread them out again."
      : builtAs && (Math.abs(builtAs.size_mm.w - report.size_mm.w) > 0.6 || Math.abs(builtAs.size_mm.h - report.size_mm.h) > 0.6 || Math.abs(builtAs.size_mm.d - report.size_mm.d) > 0.6)
        ? `Jumper now finds a different way to fit the parts (${builtAs.size_mm.w} × ${builtAs.size_mm.h} × ${builtAs.size_mm.d} mm; the case is ${report.size_mm.w} × ${report.size_mm.h} × ${report.size_mm.d} mm).`
        : undefined;
  const useLayout = (id: string) => {
    const v = id === layouts?.best ? "auto" : id;
    setLayout(v);
    setSelected(id);
    void apply({ layout: v });
  };

  return (
    <div className="case-view" data-testid="case-view" role="dialog" aria-modal="true" aria-label="Case">
      <div className="cv-stage">
        {preview && shown ? (
          <Canvas key="preview" camera={{ fov: 32, near: 1, far: 5000, position: [140, 90, 190] }} dpr={[1, 2]} gl={{ antialias: true }} data-testid="case-preview-3d">
            <color attach="background" args={["#0d0f12"]} />
            <hemisphereLight args={["#ffffff", "#2a2f38", 1.1]} />
            <directionalLight position={[120, 200, 160]} intensity={1.6} />
            <directionalLight position={[-150, -60, -120]} intensity={0.45} />
            <ProposalScene p={shown} opacity={opacity} color={partColors(layouts)} />
            <OrbitControls makeDefault enableDamping />
          </Canvas>
        ) : mesh ? (
          <Canvas camera={{ fov: 32, near: 1, far: 5000, position: [140, 90, 190] }} dpr={[1, 2]} gl={{ antialias: true }}>
            <color attach="background" args={["#0d0f12"]} />
            <hemisphereLight args={["#ffffff", "#2a2f38", 1.1]} />
            <directionalLight position={[120, 200, 160]} intensity={1.6} />
            <directionalLight position={[-150, -60, -120]} intensity={0.45} />
            <CaseBodies mesh={mesh} opacity={opacity} explode={explode} />
            <OrbitControls makeDefault enableDamping />
          </Canvas>
        ) : (
          <div className="cv-empty" data-testid="case-empty">
            <Box size={40} strokeWidth={1.2} aria-hidden />
            <div className="cv-empty-title">{error ? "The case could not load" : state && !state.enclosure ? "No case yet" : "Loading the case…"}</div>
            <div className="cv-empty-sub">{error ?? (state && !state.enclosure ? "Pick a shape on the right and press Design case. Jumper packs the parts, cuts the window, the USB and button openings, and writes files for a 3D printer and a factory." : "")}</div>
          </div>
        )}
        {tab === "layout" && shown?.views ? (
          <div className="cv-stage-mode float-box" role="radiogroup" aria-label="What the 3D view shows" data-testid="case-stage-mode">
            <button type="button" role="radio" aria-checked={preview} className={preview ? "is-on" : ""} onClick={() => setStageMode("preview")} data-testid="case-stage-preview">
              {({ thinnest: "Thinnest", smallest: "Smallest", balanced: "Balanced" } as Record<string, string>)[shown.id] ?? shown.label} preview
            </button>
            <button type="button" role="radio" aria-checked={!preview} className={!preview ? "is-on" : ""} disabled={!mesh} onClick={() => setStageMode("case")} data-testid="case-stage-built">
              Built case
            </button>
          </div>
        ) : null}
        {preview && shown ? (
          <div className="cv-preview-note float-box" data-testid="case-preview-note">
            {shown.size_mm.w} × {shown.size_mm.h} × {shown.size_mm.d} mm<span className="cv-preview-long"> · the parts as boxes inside the shell</span>{report && builtAs?.id === shown.id && !dirty ? "" : " · not built yet"}
          </div>
        ) : null}
        {mesh || preview ? (
          <div className="cv-sliders float-box">
            <label>
              <span>See-through</span>
              <input data-testid="case-opacity" type="range" min={0.08} max={1} step={0.01} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
            </label>
            {preview ? null : (
              <label>
                <span>Explode</span>
                <input data-testid="case-explode" type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => setExplode(Number(e.target.value))} />
              </label>
            )}
          </div>
        ) : null}
        {busy ? (
          <div className="cv-busy" data-testid="case-busy">
            <Loader2 size={16} className="spin" aria-hidden /> {busy} <span className="cv-faint">real CAD, a few seconds</span>
          </div>
        ) : null}
      </div>

      <aside className={`cv-panel float-box ${tab !== "shape" ? "is-wide" : ""}`} aria-label="Case settings">
        <header className="cv-head">
          <div>
            <div className="cv-title">Case</div>
            {report ? (
              <div className="cv-size" data-testid="case-size">
                {report.size_mm.w} × {report.size_mm.h} × {report.size_mm.d} mm <PocketBadge pocket={report.pocket} />
              </div>
            ) : (
              <div className="cv-faint">{saved ? "…" : "not designed yet"}</div>
            )}
          </div>
          <button type="button" className="icon-btn" aria-label="Close case view" data-testid="case-close" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </header>

        <div className="cv-tabs" role="tablist" aria-label="Case">
          <button type="button" role="tab" id="cv-tab-shape" aria-selected={tab === "shape"} aria-controls="cv-pane" className={tab === "shape" ? "is-on" : ""} data-testid="case-tab-shape" onClick={() => setTab("shape")}>
            Shape
          </button>
          <button
            type="button"
            role="tab"
            id="cv-tab-layout"
            aria-selected={tab === "layout"}
            aria-controls="cv-pane"
            className={tab === "layout" ? "is-on" : ""}
            data-testid="case-tab-layout"
            onClick={() => {
              setTab("layout");
              setStageMode("preview");
            }}
          >
            Layout {staleMsg ? <span className="cv-dot" aria-label="(Jumper has a better layout)" /> : null}
          </button>
          <button type="button" role="tab" id="cv-tab-build" aria-selected={tab === "build"} aria-controls="cv-pane" className={tab === "build" ? "is-on" : ""} data-testid="case-tab-build" onClick={() => setTab("build")}>
            Build
          </button>
        </div>

        {tab === "build" ? (
          <div id="cv-pane" role="tabpanel" aria-labelledby="cv-tab-build" className="cv-pane">
            <AssemblyTab hash={state?.stale ? undefined : report?.hash} working={!!busy} />
          </div>
        ) : tab === "layout" ? (
          <div id="cv-pane" role="tabpanel" aria-labelledby="cv-tab-layout" className="cv-pane">
            <LayoutTab
              {...(layouts ? { result: layouts } : {})}
              busy={layoutsBusy}
              {...(layoutsError ? { error: layoutsError } : {})}
              selected={shown?.id ?? chosenId}
              onSelect={(id) => {
                setSelected(id);
                setStageMode("preview");
              }}
              {...(report?.layout ? { built: { goal: report.layout.goal, size: report.size_mm } } : {})}
              onUse={useLayout}
              working={!!busy}
              pins={pins}
              savedPins={Object.fromEntries(Object.entries(saved?.placements ?? {}).filter(([, v]) => v.x_mm !== undefined || v.y_mm !== undefined).map(([k, v]) => [k, { ...(v.x_mm !== undefined ? { x_mm: v.x_mm } : {}), ...(v.y_mm !== undefined ? { y_mm: v.y_mm } : {}) }]))}
              onPin={(id, at) => {
                lastPin.current = { id, before: pins[id] };
                setNotice(undefined);
                setPins((p0) => ({ ...p0, [id]: at }));
                setStageMode("preview");
              }}
              onBlocked={setNotice}
              {...(notice ? { notice } : {})}
              onClearPins={() => setPins(Object.fromEntries(Object.keys(placements).map((k) => [k, null])))}
              {...(staleMsg ? { stale: staleMsg } : {})}
              onRedistribute={() => {
                setLayout("auto");
                setSelected(undefined);
                void apply({ layout: "auto" });
              }}
              {...(advice ? { advice } : {})}
              {...(adviceBusy ? { adviceBusy } : {})}
              {...(adviceError ? { adviceError } : {})}
              {...(adviceDone ? { adviceDone } : {})}
              onApplyAdvice={(id) => void applyAdvice(id)}
              {...(costs ? { costs } : {})}
              costsBusy={costsBusy}
              {...(costsError ? { costsError } : {})}
              {...(costApplying ? { costApplying } : {})}
              onApplyCost={(id, change) => void applyCost(id, change)}
            />
            {error ? (
              <div className="cv-error" role="alert" data-testid="case-error">
                {error}
              </div>
            ) : null}
          </div>
        ) : (
          <div id="cv-pane" role="tabpanel" aria-labelledby="cv-tab-shape" className="cv-pane">
            <section>
              <div className="cv-label">Shape</div>
              <div className="cv-shapes" role="radiogroup" aria-label="Shape">
                {SHAPES.map((s) => (
                  <button key={s.id} type="button" role="radio" aria-checked={shape === s.id} title={s.hint} className={shape === s.id ? "is-on" : ""} data-testid={`case-shape-${s.id}`} onClick={() => pickShape(s.id)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </section>

            {shape === "custom" ? (
              <OutlineEditor
                points={points}
                onPoints={setPoints}
                size={size}
                onSize={(s) => {
                  // typing W / H scales the drawing to that size (blank = auto keeps it as drawn)
                  if ((s.w !== size.w || s.h !== size.h) && (s.w !== undefined || s.h !== undefined)) setPoints(fitTo(points, s.w, s.h));
                  setSize(s);
                }}
                fit={fit}
                fitBusy={fitBusy}
                fitError={fitError}
                onStart={(k) => setPoints(startPoints(k, size.w ?? fit?.size_mm.w ?? 60, size.h ?? fit?.size_mm.h ?? 76))}
                onUseSize={(s) => {
                  setPoints(fitTo(points, s.w, s.h));
                  setSize({ ...size, ...s });
                }}
              />
            ) : null}

            <section className="cv-params">
              <Range label="Wall" unit="mm" min={1.2} max={3} step={0.1} value={params.wall_mm ?? 1.6} onChange={(v) => set("wall_mm", v)} testId="case-wall" />
              {shape === "rounded-box" || shape === "keychain" ? <Range label="Corner radius" unit="mm" min={0} max={12} step={0.5} value={params.corner_radius_mm ?? 4} onChange={(v) => set("corner_radius_mm", v)} /> : null}
              <Range label="Room for wires" unit="mm" min={0.5} max={4} step={0.1} value={params.gap_mm ?? 1.5} onChange={(v) => set("gap_mm", v)} />
              <div className="cv-row">
                <span>Closure</span>
                <select value={params.closure ?? "snap"} onChange={(e) => set("closure", e.target.value as "snap" | "screws")} data-testid="case-closure">
                  <option value="snap">Snap lip</option>
                  <option value="screws">M2 screws + inserts</option>
                </select>
              </div>
              <div className="cv-row">
                <span>Made by</span>
                <select value={params.process ?? "fdm"} onChange={(e) => set("process", e.target.value as "fdm" | "resin" | "injection")}>
                  <option value="fdm">3D printer (FDM)</option>
                  <option value="resin">Resin printer</option>
                  <option value="injection">Factory (injection)</option>
                </select>
              </div>
              <div className="cv-row">
                <span>Colour</span>
                <input type="color" value={params.color ?? "#F2EDE4"} onChange={(e) => set("color", e.target.value.toUpperCase())} aria-label="Case colour" />
              </div>
              <label className="cv-check">
                <input type="checkbox" checked={params.lanyard_hole ?? shape === "keychain"} onChange={(e) => set("lanyard_hole", e.target.checked)} /> Lanyard hole
              </label>
              <label className="cv-check">
                <input type="checkbox" checked={params.belt_clip ?? false} onChange={(e) => set("belt_clip", e.target.checked)} /> Belt clip
              </label>
            </section>

            {layouts ? (
              <button type="button" className="cv-inside-link" data-testid="case-open-layout" onClick={() => (setTab("layout"), setStageMode("preview"))}>
                Parts inside: {layouts.proposals.find((q) => q.id === chosenId)?.label ?? chosenId}, {layouts.proposals.find((q) => q.id === chosenId)?.size_mm.d ?? "?"} mm thick. See how they go →
              </button>
            ) : null}

            <button type="button" className="cv-primary" disabled={!!busy || (!!saved && !dirty)} data-testid="case-update" onClick={() => void apply()}>
              {busy && busy !== "Writing the factory pack…" ? (saved ? "Updating…" : "Designing…") : saved ? (dirty ? "Update case" : "Case is up to date") : "Design case"}
            </button>
            {error && (mesh || shape === "custom") ? (
              <div className="cv-error" role="alert" data-testid="case-error">
                {error}
              </div>
            ) : null}

            {report ? (
              <>
                <section>
                  <div className="cv-label">Checks</div>
                  <ul className="cv-checks" data-testid="case-checks">
                    {report.checks.map((c, i) => (
                      <li key={i} className={`is-${c.ok ? (c.severity === "warning" ? "warn" : "ok") : c.severity === "error" ? "bad" : "warn"}`} title={c.message}>
                        {c.ok && c.severity !== "warning" ? <CheckCircle2 size={14} aria-hidden /> : c.severity === "error" && !c.ok ? <XCircle size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}
                        <span>
                          <b>{c.id}</b> {c.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <div className="cv-label">Files</div>
                  <div className="cv-files">
                    {[
                      ["stl/front.stl", "Front STL"],
                      ["stl/back.stl", "Back STL"],
                      ["case.3mf", "3MF (all)"],
                      ["step/assembly.step", "STEP"],
                      [has("drawing/drawing.pdf") ? "drawing/drawing.pdf" : "drawing/drawing.svg", "Drawing"],
                      ["PRINT.md", "Print notes"],
                    ].map(([p, label]) => (
                      <a key={p} href={caseApi.fileUrl(p!)} download className={`cv-file ${has(p!) ? "" : "is-off"}`} data-testid={`case-download-${p!.split("/").pop()}`}>
                        <Download size={13} aria-hidden /> {label}
                      </a>
                    ))}
                  </div>
                  <button type="button" className="cv-secondary" disabled={!!busy} data-testid="case-pack" onClick={() => void makePack()}>
                    <Package size={15} aria-hidden /> Factory pack (zip)
                  </button>
                  {pack ? (
                    <div className="cv-pack" data-testid="case-pack-result">
                      {pack.url ? (
                        <div>
                          <a href={pack.url}>Download the zip again</a>
                        </div>
                      ) : null}
                      {pack.missing.length ? <ul>{pack.missing.map((m) => <li key={m.item}>Missing {m.item}: {m.why}. To fix it: {m.say ?? inWords(m.fix)}.</li>)}</ul> : <span> Everything is in it.</span>}
                    </div>
                  ) : null}
                </section>
                {otherShapes.length ? (
                  <section data-testid="case-variants">
                    <div className="cv-label">Other shapes made</div>
                    {otherShapes.map((v) => (
                      <div key={v.shape} className="cv-variant" data-testid={`case-variant-${v.shape}`}>
                        <div>
                          <b>{v.shape}</b> {v.size_mm.w} × {v.size_mm.h} × {v.size_mm.d} mm <PocketBadge pocket={v.pocket} />
                          {v.ok ? null : <span className="cv-faint"> has problems</span>}
                        </div>
                        <div className="cv-files">
                          {[
                            ["stl/front.stl", "Front STL"],
                            ["stl/back.stl", "Back STL"],
                            ["case.3mf", "3MF"],
                            ["renders/front.png", "Render"],
                          ]
                            .filter(([p]) => v.files.includes(`variants/${v.shape}/${p}`))
                            .map(([p, label]) => (
                              <a key={p} href={caseApi.fileUrl(`variants/${v.shape}/${p}`)} download className="cv-file">
                                <Download size={13} aria-hidden /> {label}
                              </a>
                            ))}
                        </div>
                        <button type="button" className="cv-secondary" disabled={!!busy || shape === v.shape} onClick={() => setShape(v.shape as Enclosure["shape"])}>
                          Pick {v.shape} (then Update case)
                        </button>
                      </div>
                    ))}
                  </section>
                ) : null}
                <p className="cv-faint cv-note">The case cannot check snap strength or your printer's real tolerances: print the two shells first and test the fit.</p>
              </>
            ) : null}
          </div>
        )}
      </aside>
    </div>
  );
}

/** A fix written for an agent, in the words of the buttons on this page (no tool names). */
function inWords(fix: string): string {
  return fix
    .replace(/\bexport_manufacturing\b/g, "Factory pack")
    .replace(/\bdesign_case\b(\s*\{[^}]*\})?/g, "Design case")
    .replace(/\bupdate_case\b(\s*\{[^}]*\})?/g, "Update case")
    .replace(/\bget_case\b/g, "open the Case view")
    .replace(/\bbuild \(or run\)/gi, "press Run (or Build)")
    .replace(/\.$/, "");
}

function PocketBadge({ pocket }: { pocket: CaseReport["pocket"] }) {
  const text = pocket === "fits" ? "fits a pocket" : pocket === "tight" ? "tight for a pocket" : "bulky for a pocket";
  return (
    <span className={`cv-pocket is-${pocket}`} data-testid="case-pocket">
      {text}
    </span>
  );
}

function Range({ label, unit, min, max, step, value, onChange, testId }: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange(v: number): void; testId?: string }) {
  return (
    <label className="cv-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} {...(testId ? { "data-testid": testId } : {})} />
      <output>
        {value.toFixed(1)} {unit}
      </output>
    </label>
  );
}

function CaseBodies({ mesh, opacity, explode }: { mesh: CaseMesh; opacity: number; explode: number }) {
  const geos = useMemo(
    () =>
      mesh.bodies.map((b) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(decodeF32(b.positions), 3));
        g.setIndex(new THREE.BufferAttribute(decodeU32(b.indices), 1));
        g.computeVertexNormals();
        g.computeBoundingBox();
        return { b, g };
      }),
    [mesh],
  );
  useEffect(() => () => geos.forEach(({ g }) => g.dispose()), [geos]);
  const size = useMemo(() => {
    const box = new THREE.Box3();
    for (const { g, b } of geos) if (b.kind === "shell") box.union(g.boundingBox!);
    return box;
  }, [geos]);
  return (
    <group>
      <FitCamera box={size} />
      {geos.map(({ b, g }) => {
        const shell = b.kind === "shell";
        return (
          <mesh key={b.body} geometry={g} position={[b.explode[0] * explode, b.explode[1] * explode, b.explode[2] * explode]} renderOrder={shell ? 2 : 1}>
            <meshStandardMaterial color={b.color} roughness={shell ? 0.62 : 0.5} metalness={b.kind === "part" ? 0.1 : 0} transparent={shell && opacity < 0.99} opacity={shell ? opacity : 1} depthWrite={!shell || opacity >= 0.99} side={shell ? THREE.DoubleSide : THREE.FrontSide} flatShading={false} />
          </mesh>
        );
      })}
    </group>
  );
}

function FitCamera({ box }: { box: THREE.Box3 }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update(): void } | null;
  useEffect(() => {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length();
    camera.position.set(c.x + r * 0.9, c.y + r * 0.55, c.z + r * 1.35);
    camera.lookAt(c);
    if (controls) {
      controls.target.copy(c);
      controls.update();
    }
  }, [box, camera, controls]);
  return null;
}

/**
 * Round 8 (view): a proposal in 3D before it is built: the outline extruded to the case's depth as a
 * see-through shell (white line art at its edges) and every part as a box in its layer's colour.
 */
function ProposalScene({ p, opacity, color }: { p: LayoutProposal; opacity: number; color(id: string): string }) {
  const v = p.views!;
  const shell = useMemo(() => {
    const shape = new THREE.Shape(v.front.outline.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: v.side.z[1] - v.side.z[0], bevelEnabled: false, curveSegments: 4 });
    g.translate(0, 0, v.side.z[0]);
    g.computeBoundingBox();
    return { g, edges: new THREE.EdgesGeometry(g, 30) };
  }, [v]);
  useEffect(() => () => (shell.g.dispose(), shell.edges.dispose()), [shell]);
  const boxes = useMemo(
    () =>
      v.front.parts.map((q) => {
        const s = v.side.parts.find((x) => x.id === q.id);
        const z = s?.z ?? [v.side.z[0] + 2, v.side.z[1] - 2];
        const size: [number, number, number] = [q.max[0] - q.min[0], q.max[1] - q.min[1], z[1] - z[0]];
        const at: [number, number, number] = [(q.min[0] + q.max[0]) / 2, (q.min[1] + q.max[1]) / 2, (z[0] + z[1]) / 2];
        return { id: q.id, label: q.label, color: color(q.id), size, at };
      }),
    [v, color],
  );
  return (
    <group>
      <FitCamera box={shell.g.boundingBox!} />
      <mesh geometry={shell.g} renderOrder={2}>
        <meshStandardMaterial color="#e9edf2" roughness={0.6} transparent opacity={Math.min(opacity, 0.6) * 0.35} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={shell.edges}>
        <lineBasicMaterial color="#ffffff" transparent opacity={0.8} />
      </lineSegments>
      {boxes.map((b) => (
        <group key={b.id} position={b.at}>
          <mesh>
            <boxGeometry args={b.size} />
            <meshStandardMaterial color={b.color} roughness={0.55} />
          </mesh>
          <Html center position={[0, 0, b.size[2] / 2 + 0.5]} className="cv-3d-label" zIndexRange={[30, 10]}>
            {b.label}
          </Html>
        </group>
      ))}
    </group>
  );
}
