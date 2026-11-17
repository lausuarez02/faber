/**
 * Dimensioned drawing (SVG, A3 landscape, mm): front view with the window, side and bottom views
 * with the openings and the split line, overall size, wall, hole table, tolerances, material /
 * finish and print settings. PDF: the same SVG printed by Playwright's Chromium when it is installed.
 */
import type { Layout, Opening } from "./layout.ts";
import { outline } from "./plan.ts";
import { materialFor, printSettings } from "./print.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const f1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

export function drawingSvg(L: Layout, title: string, extra: { rf: number; rfBack?: number; wallMeasured: number; screws?: string; massG?: number }): string {
  const t = L.params.wall_mm;
  const W = L.outer.w;
  const H = L.outer.h;
  const D = L.outer.d;
  const largest = Math.max(W + D, H + D);
  const scale = largest <= 150 ? 1.5 : largest <= 220 ? 1 : largest <= 440 ? 0.5 : 0.25;
  const sTxt = scale === 1.5 ? "3:2" : scale === 1 ? "1:1" : scale === 0.5 ? "1:2" : "1:4";
  const out: string[] = [];
  const P = 420;
  const Q = 297;
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${P}mm" height="${Q}mm" viewBox="0 0 ${P} ${Q}" font-family="Helvetica, Arial, sans-serif">`);
  out.push(`<rect x="0" y="0" width="${P}" height="${Q}" fill="#fff"/><rect x="8" y="8" width="${P - 16}" height="${Q - 16}" fill="none" stroke="#111" stroke-width="0.5"/>`);
  out.push(`<style>.o{fill:none;stroke:#111;stroke-width:0.45}.h{fill:none;stroke:#555;stroke-width:0.25;stroke-dasharray:2 1.2}.c{fill:none;stroke:#888;stroke-width:0.18;stroke-dasharray:6 1.5 1 1.5}.d{stroke:#1d4ed8;stroke-width:0.2;fill:none}.dt{fill:#1d4ed8;font-size:3.2px}.t{font-size:3.4px;fill:#111}.s{font-size:2.8px;fill:#333}.m{font-size:2.6px;fill:#333;font-family:Menlo,Consolas,monospace;white-space:pre}.b{font-size:5px;font-weight:bold;fill:#111}.op{fill:#e6efff;stroke:#111;stroke-width:0.3}</style>`);
  // ---- front view
  const fx = 20 + (W * scale) / 2 + 12;
  const fy = 30 + (H * scale) / 2 + 12;
  const tf = (x: number, y: number) => [fx + x * scale, fy - y * scale] as const;
  const poly = (pts: [number, number][], cls: string) => `<polygon class="${cls}" points="${pts.map(([x, y]) => tf(x, y).map((v) => v.toFixed(2)).join(",")).join(" ")}"/>`;
  out.push(`<text class="b" x="${fx}" y="22" text-anchor="middle">FRONT</text>`);
  out.push(poly(outline(L.plan, t, 240), "o"));
  out.push(poly(outline(L.plan, 0, 240), "h"));
  if (L.tab) {
    const [x0, y0] = tf(L.tab.x - L.tab.w / 2, L.tab.y + L.tab.h / 2);
    out.push(`<rect class="o" x="${x0}" y="${y0}" width="${L.tab.w * scale}" height="${L.tab.h * scale}" rx="${Math.min(4, L.tab.w / 2) * scale}"/>`);
    const [hx, hy] = tf(L.tab.x, L.tab.y + L.tab.h / 2 - L.tab.hole / 2 - 1.8);
    out.push(`<circle class="o" cx="${hx}" cy="${hy}" r="${(L.tab.hole / 2) * scale}"/>`);
  }
  out.push(`<line class="c" x1="${fx - (W / 2 + 4) * scale}" y1="${fy}" x2="${fx + (W / 2 + 4) * scale}" y2="${fy}"/><line class="c" x1="${fx}" y1="${fy - (H / 2 + 4) * scale}" x2="${fx}" y2="${fy + (H / 2 + 4) * scale}"/>`);
  const faceOps = (face: string) => L.openings.filter((o) => o.face === face);
  for (const o of faceOps("front")) out.push(openingFront(o, tf, scale));
  for (const b of L.bosses) {
    const [x, y] = tf(b.x, b.y);
    out.push(`<circle class="h" cx="${x}" cy="${y}" r="${(b.od / 2) * scale}"/><circle class="h" cx="${x}" cy="${y}" r="${1.6 * scale}"/>`);
  }
  // dims: overall W / H
  out.push(dimH(fx - (W / 2) * scale, fx + (W / 2) * scale, fy + (H / 2) * scale + 8, `${f1(W)}`));
  out.push(dimV(fy - (H / 2) * scale, fy + (H / 2) * scale, fx - (W / 2) * scale - 8, `${f1(H)}`));
  const win = faceOps("front").find((o) => o.kind === "window");
  if (win) {
    const [wx, wy] = tf(win.at[0], win.at[1]);
    out.push(`<line class="d" x1="${wx}" y1="${wy}" x2="${wx + (win.u / 2) * scale * 0.7071 + 10}" y2="${wy - (win.v / 2) * scale * 0.7071 - 10}"/><text class="dt" x="${wx + (win.u / 2) * scale * 0.7071 + 11}" y="${wy - (win.v / 2) * scale * 0.7071 - 11}">${win.shape === "round" ? "Ø" + f1(win.u) : f1(win.u) + " x " + f1(win.v)} window, centre (${f1(win.at[0])}, ${f1(win.at[1])})</text>`);
  }
  // ---- right view (depth horizontal: front at the left)
  const rx = fx + (W / 2) * scale + 28 + (D * scale) / 2;
  const ry = fy;
  out.push(`<text class="b" x="${rx}" y="22" text-anchor="middle">RIGHT SIDE</text>`);
  const tr = (z: number, y: number) => [rx - z * scale, ry - y * scale] as const;
  const cF = L.dome?.front.crown ?? 0;
  const cB = L.dome?.back.crown ?? 0;
  const rB = extra.rfBack ?? extra.rf;
  out.push(silhouette(tr, L.outer.max[2], L.outer.min[2], L.outer.min[1], L.outer.max[1], extra.rf, rB, cF, cB));
  {
    const [a, b] = tr(L.split, L.outer.max[1] + 2);
    const [, c] = tr(L.split, L.outer.min[1] - 2);
    out.push(`<line class="c" x1="${a}" y1="${b}" x2="${a}" y2="${c}"/><text class="s" x="${a + 1}" y="${b + 2}">split</text>`);
  }
  for (const o of faceOps("right")) out.push(openingSide(o, (p) => tr(p[2], p[1]), scale, [0, 0, -1], [0, 1, 0]));
  out.push(dimH(rx - (D / 2) * scale, rx + (D / 2) * scale, ry + (H / 2) * scale + 8, `${f1(D)}`));
  out.push(dimH(...([tr(L.outer.max[2], 0)[0], tr(L.split, 0)[0]] as [number, number]), ry - (H / 2) * scale - 6, `${f1(L.outer.max[2] - L.split)} front shell`));
  // ---- bottom view (x horizontal, depth vertical: front at the top)
  const bx = fx;
  const by = fy + (H / 2) * scale + 26 + (D * scale) / 2;
  out.push(`<text class="b" x="${bx}" y="${by - (D / 2) * scale - 4}" text-anchor="middle">BOTTOM</text>`);
  const tb = (x: number, z: number) => [bx + x * scale, by - z * scale] as const;
  out.push(silhouette((z, x) => tb(x, z), L.outer.max[2], L.outer.min[2], L.outer.min[0], L.outer.max[0], extra.rf, rB, cF, cB));
  for (const o of faceOps("bottom")) out.push(openingSide(o, (p) => tb(p[0], p[2]), scale, [1, 0, 0], [0, 0, 1]));
  faceOps("bottom").forEach((o, i) => {
    out.push(`<text class="dt" x="${bx}" y="${by + (D / 2) * scale + 5 + i * 4}" text-anchor="middle">${o.part}.${o.feature}: centre x ${f1(o.at[0])}, z ${f1(o.at[2])}; ${f1(o.u)} x ${f1(o.v)} mm</text>`);
  });
  // top / left / back openings listed in the table; the back is drawn small if it has holes
  // ---- tables (right column)
  const tx = 262;
  let ty = 26;
  const line = (s: string, cls = "t", dy = 4.6) => {
    out.push(`<text class="${cls}" x="${tx}" y="${ty}">${esc(s)}</text>`);
    ty += dy;
  };
  line(`${title}`, "b", 7);
  line(`Case: ${L.shape}, ${f1(W)} x ${f1(H)} x ${f1(D)} mm (W x H x D), inner ${L.inner.w} x ${L.inner.h} x ${L.inner.d} mm`);
  line(`Wall ${f1(t)} mm (measured min ${extra.wallMeasured.toFixed(2)} mm), edge radius ${f1(extra.rf)} mm front${Math.abs(rB - extra.rf) > 0.05 ? `, ${f1(rB)} mm back` : ""} (rounded in 3D all round)${cF || cB ? `, faces domed ${f1(cF)} / ${f1(cB)} mm` : ""}, split ${f1(L.outer.max[2] - L.split)} mm from the front`);
  line(`Closure: ${L.lip ? `snap lip ${f1(L.lip.t)} x ${f1(L.lip.h)} mm${L.lip.groove > 0.05 ? `, bead ${L.lip.bead} mm into a ${L.lip.groove.toFixed(1)} mm groove` : " (friction fit)"}` : extra.screws ?? "screws"}`);
  if (extra.massG) line(`Shell mass about ${extra.massG.toFixed(0)} g (${materialFor(L.params.process).name})`);
  ty += 2;
  line("OPENINGS (case frame, origin = centre of the outer box; +x right, +y up, +z out of the front)", "s", 4);
  line("part.feature            face     centre x, y, z          size", "m", 4);
  for (const o of L.openings) line(`${(o.part + "." + o.feature).padEnd(22).slice(0, 22)}  ${o.face.padEnd(7)}  ${[o.at[0], o.at[1], o.at[2]].map(f1).join(", ").padEnd(22)}  ${o.shape === "round" ? "Ø" + f1(o.u) : f1(o.u) + " x " + f1(o.v)}${o.kind === "grille" ? ` (${o.holes?.length} x Ø1.5)` : ""}`, "m", 3.8);
  for (const b of L.bosses) line(`boss                    front/back  ${[b.x, b.y].map(f1).join(", ")}             Ø${f1(b.od)}, insert hole Ø3.2 x 4.5, screw hole Ø2.2, counterbore Ø4.2`, "m", 3.8);
  ty += 2;
  line("TOLERANCES", "s", 4);
  const tol = L.params.tolerance_mm;
  line(`General ±${L.params.process === "fdm" ? "0.2" : L.params.process === "resin" ? "0.1" : "0.05"} mm. Clearance between mating parts ${tol} mm (${L.params.process}). Holes are drawn at size + clearance.`, "s", 3.8);
  line("Check the screen window and the USB openings against the real modules before a production run.", "s", 3.8);
  ty += 2;
  line("MATERIAL / FINISH", "s", 4);
  const mat = materialFor(L.params.process);
  for (const s of mat.lines) line(s, "s", 3.8);
  ty += 2;
  line("PRINT SETTINGS", "s", 4);
  for (const s of printSettings(L.params.process)) line(s, "s", 3.8);
  // title block
  out.push(`<rect x="${P - 128}" y="${Q - 30}" width="120" height="22" fill="none" stroke="#111" stroke-width="0.4"/>`);
  out.push(`<text class="t" x="${P - 125}" y="${Q - 23}">${esc(title)} · case (${L.shape})</text><text class="s" x="${P - 125}" y="${Q - 18}">Units mm · scale ${sTxt} on A3 · third-angle views</text><text class="s" x="${P - 125}" y="${Q - 13}">Generated by Faber from faber.json + the parts' mechanical data</text>`);
  out.push(`</svg>`);
  return out.join("\n");

  function dimH(x0: number, x1: number, y: number, label: string): string {
    return `<line class="d" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/><line class="d" x1="${x0}" y1="${y - 2}" x2="${x0}" y2="${y + 2}"/><line class="d" x1="${x1}" y1="${y - 2}" x2="${x1}" y2="${y + 2}"/><text class="dt" x="${(x0 + x1) / 2}" y="${y - 1.2}" text-anchor="middle">${label}</text>`;
  }
  function dimV(y0: number, y1: number, x: number, label: string): string {
    return `<line class="d" x1="${x}" y1="${y0}" x2="${x}" y2="${y1}"/><line class="d" x1="${x - 2}" y1="${y0}" x2="${x + 2}" y2="${y0}"/><line class="d" x1="${x - 2}" y1="${y1}" x2="${x + 2}" y2="${y1}"/><text class="dt" x="${x - 1.4}" y="${(y0 + y1) / 2}" text-anchor="middle" transform="rotate(-90 ${x - 1.4} ${(y0 + y1) / 2})">${label}</text>`;
  }
}

function openingFront(o: Opening, tf: (x: number, y: number) => readonly [number, number], scale: number): string {
  const [x, y] = tf(o.at[0], o.at[1]);
  if (o.holes) return o.holes.map((h) => { const [hx, hy] = tf(h.at[0], h.at[1]); return `<circle class="op" cx="${hx}" cy="${hy}" r="${(h.d / 2) * scale}"/>`; }).join("");
  if (o.shape === "round") return `<circle class="op" cx="${x}" cy="${y}" r="${(o.u / 2) * scale}"/>`;
  const w = (Math.abs(o.uAxis[0]) > 0.5 ? o.u : o.v) * scale;
  const h = (Math.abs(o.uAxis[0]) > 0.5 ? o.v : o.u) * scale;
  return `<rect class="op" x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${o.corner * scale}"/>`;
}

function openingSide(o: Opening, tf: (p: [number, number, number]) => readonly [number, number], scale: number, hAxis: [number, number, number], vAxis: [number, number, number]): string {
  const [x, y] = tf(o.at);
  if (o.holes) return o.holes.map((h) => { const [hx, hy] = tf(h.at); return `<circle class="op" cx="${hx}" cy="${hy}" r="${(h.d / 2) * scale}"/>`; }).join("");
  if (o.shape === "round") return `<circle class="op" cx="${x}" cy="${y}" r="${(o.u / 2) * scale}"/>`;
  const along = (ax: [number, number, number]) => (Math.abs(o.uAxis[0] * ax[0] + o.uAxis[1] * ax[1] + o.uAxis[2] * ax[2]) > 0.5 ? o.u : o.v);
  const w = along(hAxis) * scale;
  const h = along(vAxis) * scale;
  return `<rect class="op" x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${o.corner * scale}"/>`;
}

/**
 * Side silhouette (model mm → sheet via tf(z, a)): front face at zF (crown cF above its flat wall
 * plane), back at zB, across a0..a1, front edge radius rF, back edge rB: the true 3D rounding.
 */
function silhouette(tf: (z: number, a: number) => readonly [number, number], zF: number, zB: number, a0: number, a1: number, rF: number, rB: number, cF: number, cB: number): string {
  const pF = zF - cF;
  const pB = zB + cB;
  const half = (pF - pB) / 2;
  const rf = Math.min(rF, half, (a1 - a0) / 2);
  const rb = Math.min(rB, half, (a1 - a0) / 2);
  const pts: [number, number][] = [];
  const arc = (cz: number, ca: number, r: number, t0: number, t1: number) => {
    for (let i = 0; i <= 10; i++) {
      const t = t0 + ((t1 - t0) * i) / 10;
      pts.push([cz + r * Math.cos(t), ca + r * Math.sin(t)]);
    }
  };
  const face = (z: number, c: number, from: number, to: number, dir: 1 | -1) => {
    for (let i = 1; i < 12; i++) {
      const a = from + ((to - from) * i) / 12;
      const u = (2 * (a - from)) / (to - from) - 1;
      pts.push([z + dir * c * (1 - u * u), a]);
    }
  };
  arc(pF - rf, a0 + rf, rf, -Math.PI / 2, 0); // front-low corner
  face(pF, cF, a0 + rf, a1 - rf, 1);
  arc(pF - rf, a1 - rf, rf, 0, Math.PI / 2); // front-high
  arc(pB + rb, a1 - rb, rb, Math.PI / 2, Math.PI); // back-high
  face(pB, cB, a1 - rb, a0 + rb, -1);
  arc(pB + rb, a0 + rb, rb, Math.PI, (3 * Math.PI) / 2); // back-low
  const d = pts.map(([z, a], i) => {
    const [x, y] = tf(z, a);
    return `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  return `<path class="o" d="${d.join(" ")} Z"/>`;
}
