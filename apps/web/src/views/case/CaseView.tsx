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
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { AlertTriangle, Box, CheckCircle2, Download, Loader2, Package, X, XCircle } from "lucide-react";
import type { Enclosure } from "@jumper/project-format";
import { caseApi, decodeF32, decodeU32, type CaseMesh, type CaseReport, type CaseState, type FitResult } from "../../case/api.ts";
import { fitTo, resampleClosed, startPoints, toOutline, type Pt } from "../../case/outline.ts";
import { useCase } from "../../case/store.ts";
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
  const report = state?.report;
  const hashRef = useRef<string | undefined>(undefined);

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
        else if (st.enclosure.shape === "custom" && st.report?.outline_mm?.length) setPoints(resampleClosed(st.report.outline_mm, 14));
        setSize({ ...(st.enclosure.size_mm ?? {}) });
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
  const draft = (): Record<string, unknown> => ({ shape, params, ...(shape === "custom" ? { outline: toOutline(points), size_mm: { w: size.w ?? null, h: size.h ?? null, d: size.d ?? null } } : { size_mm: null }) });
  const sizeKey = JSON.stringify({ w: size.w, h: size.h, d: size.d });
  const savedSizeKey = JSON.stringify({ w: saved?.size_mm?.w, h: saved?.size_mm?.h, d: saved?.size_mm?.d });
  const dirty = !saved || saved.shape !== shape || JSON.stringify(saved.params ?? {}) !== JSON.stringify(params) || (shape === "custom" && (JSON.stringify(saved.outline ?? null) !== JSON.stringify(toOutline(points)) || sizeKey !== savedSizeKey));

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

  const pickShape = (id: Enclosure["shape"]) => {
    if (id === "custom" && shape !== "custom") {
      // start from the shape the case is now, at its size
      const w = report?.size_mm.w ?? 60;
      const h = report?.size_mm.h ?? 76;
      setPoints(report?.outline_mm?.length ? resampleClosed(report.outline_mm, 14) : startPoints(shape, w, h));
    }
    setShape(id);
  };

  const apply = async () => {
    setBusy(saved ? "Updating the case…" : "Designing the case…");
    setPack(undefined);
    try {
      const r = (await caseApi.save(draft() as Partial<Enclosure>)) as CaseReport & { fits?: boolean; saved?: boolean };
      if (r.fits === false && r.saved === false) {
        // a fixed size that cannot hold the parts: nothing was saved; the fit panel says what to change
        setFit(r as unknown as FitResult);
        setError("The parts do not fit that size, so nothing was saved. Why: the size is fixed (W x H x D). Fix: pick a change under What would fit, or clear a size to make it auto.");
        return;
      }
      setError(undefined);
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

  return (
    <div className="case-view" data-testid="case-view" role="dialog" aria-modal="true" aria-label="Case">
      <div className="cv-stage">
        {mesh ? (
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
        {mesh ? (
          <div className="cv-sliders float-box">
            <label>
              <span>See-through</span>
              <input data-testid="case-opacity" type="range" min={0.08} max={1} step={0.01} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
            </label>
            <label>
              <span>Explode</span>
              <input data-testid="case-explode" type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => setExplode(Number(e.target.value))} />
            </label>
          </div>
        ) : null}
        {busy ? (
          <div className="cv-busy" data-testid="case-busy">
            <Loader2 size={16} className="spin" aria-hidden /> {busy} <span className="cv-faint">real CAD, a few seconds</span>
          </div>
        ) : null}
      </div>

      <aside className="cv-panel float-box" aria-label="Case settings">
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
