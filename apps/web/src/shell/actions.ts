import type { ReactFlowInstance } from "@xyflow/react";
import { parseProject, safeParseProject, serializeProject, type Project } from "@faber/project-format";
import { engine, useFaber } from "../lib/app.ts";
import { getDef } from "../lib/parts.ts";
import type { ThemeChoice } from "../lib/store.ts";
import { isPhone } from "../lib/ui.ts";
import type { PartFlowNode } from "../components/PartNode.tsx";
import type { WireFlowEdge } from "../components/WireEdge.tsx";
import { onProjectSwitch } from "../lib/projectSwitch.ts";

/** Shell actions shared by menus, the rail and keyboard shortcuts. */

let rf: ReactFlowInstance<PartFlowNode, WireFlowEdge> | undefined;
export function setFlow(i: ReactFlowInstance<PartFlowNode, WireFlowEdge> | undefined): void {
  rf = i;
  // Handy in devtools and Playwright: window.faber.flow.fitView().
  const w = typeof window !== "undefined" ? (window as unknown as { faber?: Record<string, unknown> }) : undefined;
  if (w?.faber) w.faber.flow = i;
}

/** Room the floating chrome takes on each side, so a fit keeps parts clear of it. */
export function chromeInsets(): { top: number; right: number; bottom: number; left: number } {
  const col = typeof document !== "undefined" ? document.querySelector(".panel-column") : null;
  const open = !!col && col.childElementCount > 0;
  const r = open ? col!.getBoundingClientRect() : undefined;
  // The empty-canvas "Start here" card sits under the board: keep the board above it.
  const hint = typeof document !== "undefined" ? document.querySelector(".empty-hint") : null;
  const hintRoom = hint ? innerHeight - hint.getBoundingClientRect().top + 16 : 0;
  if (isPhone()) {
    // Sheets rise from the bottom: keep the circuit above the open one.
    const sheetTop = open ? Math.min(...[...col!.children].map((c) => c.getBoundingClientRect().top)) : Infinity;
    return { top: 72, right: 20, bottom: Math.max(hintRoom, Number.isFinite(sheetTop) ? Math.max(150, innerHeight - sheetTop + 12) : 150), left: 20 };
  }
  return { top: 120, right: open && r ? Math.max(80, innerWidth - r.left + 24) : 80, bottom: Math.max(236, hintRoom), left: 120 };
}

/** The same insets in React Flow's padding form (used for the very first fit). */
export function chromePadding(): { top: `${number}px`; right: `${number}px`; bottom: `${number}px`; left: `${number}px` } {
  const i = chromeInsets();
  return { top: `${i.top}px`, right: `${i.right}px`, bottom: `${i.bottom}px`, left: `${i.left}px` };
}

// ---- round 6, canvas track: the view is the person's ------------------------------------------
//
// Once the person zoomed or panned (wheel, drag, pinch, minimap, the zoom buttons) or fitted by
// hand, automatic refits (a card appearing on run, a save, a build, an agent step) leave the view
// alone until another project opens (R8 "open"; "reload" keeps it). Asked-for fits still work.
let viewKept = false;

/** The person owns the view (automatic fits are skipped). */
export function isViewKept(): boolean {
  return viewKept;
}

/** Mark the view as the person's (a gesture, a zoom button) or give it back to automatic fits. */
export function keepView(on: boolean): void {
  viewKept = on;
}

onProjectSwitch(({ reason }) => {
  if (reason === "open") viewKept = false;
});

/**
 * Fit the parts (or some of them) into the canvas area the floating chrome leaves free.
 * React Flow's own fitView centres the slack axis on the whole viewport, ignoring uneven
 * padding, so the circuit would sit under the panels; this centres it in the free rectangle.
 *
 * Round 6: `fitView()` with no duration is the person asking (Shift+1, the menu): it always fits.
 * A call with an explicit duration is an automatic refit (chrome changed): skipped once the person
 * owns the view (isViewKept).
 */
export function fitView(duration?: number, ids?: string[], maxZoom = 1.25): void {
  if (duration === undefined && !ids) viewKept = true;
  else if (viewKept && !ids) return;
  fitNow(duration ?? 300, ids, maxZoom);
}

/** Fit without asking whose view it is (project opened, first paint, focus on a part). */
export function fitNow(duration = 300, ids?: string[], maxZoom = 1.25): void {
  if (!rf) return;
  const nodes = ids ? rf.getNodes().filter((n) => ids.includes(n.id)) : rf.getNodes();
  if (!nodes.length) return;
  const b = rf.getNodesBounds(nodes);
  const el = document.querySelector('[data-testid="canvas"]')?.getBoundingClientRect();
  if (!el || !b.width || !b.height) return;
  const ins = chromeInsets();
  const labelRoom = 28; // part labels sit above the top edge
  const w = Math.max(80, el.width - ins.left - ins.right);
  const h = Math.max(80, el.height - ins.top - ins.bottom);
  // A lone board should sit in a calm, mostly empty canvas, not fill the window.
  const cap = nodes.length <= 1 ? Math.min(maxZoom, 0.8) : maxZoom;
  const zoom = Math.max(0.15, Math.min(cap, w / b.width, (h - labelRoom) / b.height));
  const x = ins.left + (w - b.width * zoom) / 2 - b.x * zoom;
  const y = ins.top + labelRoom + (h - labelRoom - b.height * zoom) / 2 - b.y * zoom;
  void rf.setViewport({ x, y, zoom }, { duration });
}
export const zoomIn = () => {
  viewKept = true;
  void rf?.zoomIn({ duration: 150 });
};
export const zoomOut = () => {
  viewKept = true;
  void rf?.zoomOut({ duration: 150 });
};

export function focusPart(id: string): void {
  useFaber.getState().select([id], []);
  viewKept = true;
  fitNow(350, [id], 1.6);
}

export const THEME_NEXT: Record<ThemeChoice, ThemeChoice> = { system: "dark", dark: "light", light: "system" };
export const cycleTheme = () => {
  const s = useFaber.getState();
  s.setTheme(THEME_NEXT[s.theme]);
};

function slug(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").toLowerCase() || "project";
}

function save(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function exportProject(): void {
  const p = useFaber.getState().project;
  save(`${slug(p.name)}.faber.json`, serializeProject(p), "application/json");
}

/** Bill of materials: one row per part type with the ids that use it. */
export function exportBom(): void {
  const p = useFaber.getState().project;
  const rows = new Map<string, { name: string; ids: string[] }>();
  for (const part of p.parts) {
    const r = rows.get(part.type) ?? { name: getDef(part.type)?.spec.name ?? part.type, ids: [] };
    r.ids.push(part.id);
    rows.set(part.type, r);
  }
  const csv = ["qty,type,name,ids", ...[...rows].map(([type, r]) => `${r.ids.length},${type},"${r.name.replace(/"/g, '""')}",${r.ids.join(" ")}`)].join("\n");
  save(`${slug(p.name)}-bom.csv`, `${csv}\n`, "text/csv");
}

/** Netlist: every wire as `part.pin -- part.pin`. */
export function exportNetlist(): void {
  const p = useFaber.getState().project;
  const lines = [`# ${p.name}: ${p.wires.length} wires`, ...p.wires.map((w) => `${w.id}\t${w.from.part}.${w.from.pin} -- ${w.to.part}.${w.to.pin}`)];
  save(`${slug(p.name)}-netlist.txt`, `${lines.join("\n")}\n`, "text/plain");
}

export function newProject(): void {
  const project: Project = parseProject({
    format: "faber/1",
    name: "Untitled",
    parts: [{ id: "uno", type: "arduino-uno", x: 0, y: 0 }],
    wires: [],
  });
  engine.stop();
  const s = useFaber.getState();
  s.loadProject(project);
  s.setFirmware({ status: "none" });
  s.setSimError(undefined);
  history.replaceState(null, "", location.pathname);
  viewKept = false;
  requestAnimationFrame(() => fitNow(0));
}

export async function importProjectFile(file: File): Promise<void> {
  const res = safeParseProject(await file.text());
  const s = useFaber.getState();
  if (!res.ok) {
    s.toast({
      kind: "error",
      title: `${file.name} is not a valid faber.json`,
      detail: `${res.issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("\n")}\nFix: export a project from Faber or run \`faber check\` on the folder.`,
    });
    return;
  }
  engine.stop();
  s.loadProject(res.project);
  const fw = s.firmware;
  if (res.project.firmware && !(fw.status === "ready" && fw.source === "upload")) {
    s.setFirmware({ status: "missing", reason: `load ${res.project.firmware.artifact} with “Load firmware .hex”` });
  }
  s.toast({ kind: "info", title: `Opened ${res.project.name}` });
  viewKept = false;
  requestAnimationFrame(() => fitNow(0));
}

export async function loadHexFile(file: File): Promise<void> {
  const hex = await file.text();
  const s = useFaber.getState();
  if (!hex.trim().startsWith(":")) {
    s.toast({ kind: "error", title: `${file.name} is not Intel HEX`, detail: "Expected lines starting with ':'. Fix: load the <sketch>.ino.hex that arduino-cli writes (not the .elf or the _with_bootloader file)." });
    return;
  }
  engine.stop();
  s.setFirmware({ status: "ready", hex, name: file.name, source: "upload" });
  s.setSimError(undefined);
  s.toast({ kind: "info", title: `Firmware ${file.name} loaded` });
}

/** Open a hidden file picker. */
export function pickFile(accept: string, onFile: (f: File) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) onFile(f);
  };
  input.click();
}

/** The board the firmware runs on (or the first board on the canvas). */
export function boardOf(p: Project): { id: string; name: string } | undefined {
  const id = p.firmware?.board ?? p.parts.find((x) => getDef(x.type)?.spec.category === "board")?.id;
  const part = id ? p.parts.find((x) => x.id === id) : undefined;
  if (!part) return undefined;
  return { id: part.id, name: getDef(part.type)?.spec.name.replace(/\s+R\d+$/, "") ?? part.type };
}
