import type { Ctx2D } from "@jumper/physics";

/**
 * A tiny CanvasRenderingContext2D look-alike that records drawing as SVG markup, so the physics
 * painters (drawWorld / drawArm, written for <canvas>) also draw the headless screenshot.
 * Supports exactly what those painters use: paths of lines and arcs, rects, text, a transform
 * stack (translate / rotate / scale), dashes and global alpha.
 */

type M = [number, number, number, number, number, number]; // a b c d e f

const IDENTITY: M = [1, 0, 0, 1, 0, 0];

function mul(m: M, n: M): M {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

interface State {
  m: M;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  globalAlpha: number;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  dash: number[];
}

export class SvgCtx implements Ctx2D {
  private out: string[] = [];
  private stack: State[] = [];
  private st: State = { m: IDENTITY, fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "10px sans-serif", globalAlpha: 1, textAlign: "start", textBaseline: "alphabetic", dash: [] };
  private d = "";
  private cur: [number, number] | undefined;

  get fillStyle(): string {
    return this.st.fillStyle;
  }
  set fillStyle(v: string | CanvasGradient | CanvasPattern) {
    this.st.fillStyle = String(v);
  }
  get strokeStyle(): string {
    return this.st.strokeStyle;
  }
  set strokeStyle(v: string | CanvasGradient | CanvasPattern) {
    this.st.strokeStyle = String(v);
  }
  get lineWidth(): number {
    return this.st.lineWidth;
  }
  set lineWidth(v: number) {
    this.st.lineWidth = v;
  }
  get font(): string {
    return this.st.font;
  }
  set font(v: string) {
    this.st.font = v;
  }
  get globalAlpha(): number {
    return this.st.globalAlpha;
  }
  set globalAlpha(v: number) {
    this.st.globalAlpha = v;
  }
  get textAlign(): CanvasTextAlign {
    return this.st.textAlign;
  }
  set textAlign(v: CanvasTextAlign) {
    this.st.textAlign = v;
  }
  get textBaseline(): CanvasTextBaseline {
    return this.st.textBaseline;
  }
  set textBaseline(v: CanvasTextBaseline) {
    this.st.textBaseline = v;
  }

  save(): void {
    this.stack.push({ ...this.st, dash: [...this.st.dash] });
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) this.st = s;
  }
  translate(x: number, y: number): void {
    this.st.m = mul(this.st.m, [1, 0, 0, 1, x, y]);
  }
  rotate(a: number): void {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.st.m = mul(this.st.m, [c, s, -s, c, 0, 0]);
  }
  scale(x: number, y: number): void {
    this.st.m = mul(this.st.m, [x, 0, 0, y, 0, 0]);
  }
  setLineDash(segments: number[]): void {
    this.st.dash = [...segments];
  }

  private p(x: number, y: number): [number, number] {
    const m = this.st.m;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }
  /** Uniform scale of the current transform (for radii and line widths). */
  private k(): number {
    const m = this.st.m;
    return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  }

  beginPath(): void {
    this.d = "";
    this.cur = undefined;
  }
  moveTo(x: number, y: number): void {
    const [a, b] = this.p(x, y);
    this.d += `M${f(a)} ${f(b)}`;
    this.cur = [a, b];
  }
  lineTo(x: number, y: number): void {
    const [a, b] = this.p(x, y);
    this.d += `${this.cur ? "L" : "M"}${f(a)} ${f(b)}`;
    this.cur = [a, b];
  }
  closePath(): void {
    this.d += "Z";
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
    const sweep = ccw ? a0 - a1 : a1 - a0;
    const full = Math.abs(sweep) >= Math.PI * 2 - 1e-6;
    const pt = (a: number) => this.p(x + r * Math.cos(a), y + r * Math.sin(a));
    const R = f(r * this.k());
    const [sx, sy] = pt(a0);
    this.d += `${this.cur ? "L" : "M"}${f(sx)} ${f(sy)}`;
    if (full) {
      const [mx, my] = pt(a0 + Math.PI);
      this.d += `A${R} ${R} 0 1 1 ${f(mx)} ${f(my)}A${R} ${R} 0 1 1 ${f(sx)} ${f(sy)}`;
      this.cur = [sx, sy];
      return;
    }
    const [ex, ey] = pt(a1);
    const large = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) > Math.PI ? 1 : 0;
    this.d += `A${R} ${R} 0 ${large} ${ccw ? 0 : 1} ${f(ex)} ${f(ey)}`;
    this.cur = [ex, ey];
  }

  private alpha(): string {
    return this.st.globalAlpha < 1 ? ` opacity="${f(this.st.globalAlpha)}"` : "";
  }
  private strokeAttrs(): string {
    const dash = this.st.dash.length ? ` stroke-dasharray="${this.st.dash.map((v) => f(v * this.k())).join(" ")}"` : "";
    return `fill="none" stroke="${esc(this.st.strokeStyle)}" stroke-width="${f(this.st.lineWidth * this.k())}" stroke-linejoin="round"${dash}${this.alpha()}`;
  }
  fill(): void {
    if (this.d) this.out.push(`<path d="${this.d}" fill="${esc(this.st.fillStyle)}"${this.alpha()}/>`);
  }
  stroke(): void {
    if (this.d) this.out.push(`<path d="${this.d}" ${this.strokeAttrs()}/>`);
  }
  private rectPath(x: number, y: number, w: number, h: number): string {
    const save = [this.d, this.cur] as const;
    this.beginPath();
    this.rect(x, y, w, h);
    const d = this.d;
    [this.d, this.cur] = save as [string, [number, number] | undefined];
    return d;
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.out.push(`<path d="${this.rectPath(x, y, w, h)}" fill="${esc(this.st.fillStyle)}"${this.alpha()}/>`);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.out.push(`<path d="${this.rectPath(x, y, w, h)}" ${this.strokeAttrs()}/>`);
  }
  fillText(text: string, x: number, y: number): void {
    const [a, b] = this.p(x, y);
    const size = Number(this.st.font.match(/([\d.]+)px/)?.[1] ?? 10) * this.k();
    const family = this.st.font.replace(/^.*?[\d.]+px\s*/, "") || "monospace";
    const anchor = this.st.textAlign === "center" ? "middle" : this.st.textAlign === "right" || this.st.textAlign === "end" ? "end" : "start";
    const base = this.st.textBaseline === "middle" ? ' dominant-baseline="middle"' : this.st.textBaseline === "top" ? ' dominant-baseline="hanging"' : "";
    this.out.push(`<text x="${f(a)}" y="${f(b)}" font-size="${f(size)}" font-family="${esc(family)}" text-anchor="${anchor}"${base} fill="${esc(this.st.fillStyle)}"${this.alpha()}>${esc(text)}</text>`);
  }

  /** The drawing so far, as SVG elements (no <svg> wrapper). */
  markup(): string {
    return this.out.join("");
  }
}
