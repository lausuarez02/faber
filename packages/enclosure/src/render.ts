/**
 * Deterministic software renders of the case (no browser, no GPU): a z-buffered triangle
 * rasteriser with flat Lambert shading and 2x supersampling, written to PNG with sim-core's encoder.
 */
import { zlibSync } from "fflate";
import type { Mesh } from "./mesh.ts";
import type { Vec3 } from "./types.ts";

export interface RenderItem {
  mesh: Mesh;
  color: string;
  /** 0..1; < 1 draws the body see-through (painted after the opaque ones). */
  alpha?: number;
  offset?: Vec3;
}

export interface View {
  /** Direction the camera looks FROM (towards the origin), case frame. */
  from: Vec3;
  up?: Vec3;
}

export const VIEWS: Record<"front" | "back" | "exploded" | "inside", View> = {
  front: { from: [0.45, 0.4, 1] },
  back: { from: [-0.45, 0.4, -1] },
  exploded: { from: [1, 0.55, 0.9] },
  inside: { from: [0.25, 0.55, 1] },
};

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function renderPng(items: RenderItem[], view: View, width = 960, height = 720, background = "#F3F4F6"): Uint8Array {
  const S = 2;
  const W = width * S;
  const H = height * S;
  const fwd = norm([-view.from[0], -view.from[1], -view.from[2]]);
  const upHint: Vec3 = view.up ?? (Math.abs(fwd[1]) > 0.95 ? [0, 0, -1] : [0, 1, 0]);
  const right = norm(cross(fwd, upHint));
  const up = cross(right, fwd);
  // project every vertex; fit the view
  const proj = items.map((it) => {
    const P = it.mesh.positions;
    const o = it.offset ?? [0, 0, 0];
    const out = new Float32Array((P.length / 3) * 3);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i]! + o[0];
      const y = P[i + 1]! + o[1];
      const z = P[i + 2]! + o[2];
      out[i] = x * right[0] + y * right[1] + z * right[2];
      out[i + 1] = x * up[0] + y * up[1] + z * up[2];
      out[i + 2] = x * fwd[0] + y * fwd[1] + z * fwd[2];
    }
    return out;
  });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of proj)
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i]!);
      maxX = Math.max(maxX, p[i]!);
      minY = Math.min(minY, p[i + 1]!);
      maxY = Math.max(maxY, p[i + 1]!);
    }
  const scale = Math.min((W * 0.86) / (maxX - minX || 1), (H * 0.86) / (maxY - minY || 1));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rgb = new Float32Array(W * H * 3);
  const bg = hex(background);
  for (let i = 0; i < W * H; i++) {
    // soft vertical gradient
    const k = 1 - (Math.floor(i / W) / H) * 0.06;
    rgb[3 * i] = bg[0] * k;
    rgb[3 * i + 1] = bg[1] * k;
    rgb[3 * i + 2] = bg[2] * k;
  }
  const zbuf = new Float32Array(W * H).fill(Infinity);
  const light = norm([-0.35, 0.7, 0]);
  const lightV: Vec3 = norm([light[0] * right[0] + light[1] * up[0] - 0.6 * fwd[0], light[0] * right[1] + light[1] * up[1] - 0.6 * fwd[1], light[0] * right[2] + light[1] * up[2] - 0.6 * fwd[2]]);
  const order = items.map((_, i) => i).sort((a, b) => (items[a]!.alpha ?? 1) < 1 ? 1 : (items[b]!.alpha ?? 1) < 1 ? -1 : 0);
  for (const ii of order) {
    const it = items[ii]!;
    const p = proj[ii]!;
    const P = it.mesh.positions;
    const I = it.mesh.indices;
    const base = hex(it.color);
    const alpha = it.alpha ?? 1;
    const o = it.offset ?? [0, 0, 0];
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t]!, b = I[t + 1]!, c = I[t + 2]!;
      // world normal for shading
      const ax = P[3 * a]! + o[0], ay = P[3 * a + 1]! + o[1], az = P[3 * a + 2]! + o[2];
      const n = norm(cross([P[3 * b]! - P[3 * a]!, P[3 * b + 1]! - P[3 * a + 1]!, P[3 * b + 2]! - P[3 * a + 2]!], [P[3 * c]! - P[3 * a]!, P[3 * c + 1]! - P[3 * a + 1]!, P[3 * c + 2]! - P[3 * a + 2]!]));
      void ax; void ay; void az;
      const facing = -(n[0] * fwd[0] + n[1] * fwd[1] + n[2] * fwd[2]);
      if (alpha >= 1 && facing <= 0) continue; // back-face cull for solids
      const lam = Math.max(0, n[0] * lightV[0] + n[1] * lightV[1] + n[2] * lightV[2]);
      const shadeK = 0.42 + 0.5 * lam + 0.14 * Math.max(0, facing);
      const col = [base[0] * shadeK, base[1] * shadeK, base[2] * shadeK];
      const X = [(p[3 * a]! - cx) * scale + W / 2, (p[3 * b]! - cx) * scale + W / 2, (p[3 * c]! - cx) * scale + W / 2];
      const Y = [H / 2 - (p[3 * a + 1]! - cy) * scale, H / 2 - (p[3 * b + 1]! - cy) * scale, H / 2 - (p[3 * c + 1]! - cy) * scale];
      const Z = [p[3 * a + 2]!, p[3 * b + 2]!, p[3 * c + 2]!];
      const x0 = Math.max(0, Math.floor(Math.min(X[0]!, X[1]!, X[2]!)));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(X[0]!, X[1]!, X[2]!)));
      const y0 = Math.max(0, Math.floor(Math.min(Y[0]!, Y[1]!, Y[2]!)));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(Y[0]!, Y[1]!, Y[2]!)));
      const den = (Y[1]! - Y[2]!) * (X[0]! - X[2]!) + (X[2]! - X[1]!) * (Y[0]! - Y[2]!);
      if (Math.abs(den) < 1e-12) continue;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((Y[1]! - Y[2]!) * (px - X[2]!) + (X[2]! - X[1]!) * (py - Y[2]!)) / den;
          const w1 = ((Y[2]! - Y[0]!) * (px - X[2]!) + (X[0]! - X[2]!) * (py - Y[2]!)) / den;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const z = w0 * Z[0]! + w1 * Z[1]! + w2 * Z[2]!;
          const k = y * W + x;
          if (z >= zbuf[k]!) continue;
          if (alpha >= 1) {
            zbuf[k] = z;
            rgb[3 * k] = col[0]!;
            rgb[3 * k + 1] = col[1]!;
            rgb[3 * k + 2] = col[2]!;
          } else {
            rgb[3 * k] = rgb[3 * k]! * (1 - alpha) + col[0]! * alpha;
            rgb[3 * k + 1] = rgb[3 * k + 1]! * (1 - alpha) + col[1]! * alpha;
            rgb[3 * k + 2] = rgb[3 * k + 2]! * (1 - alpha) + col[2]! * alpha;
          }
        }
    }
  }
  // downsample 2x2 → RGBA
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < S; dy++)
        for (let dx = 0; dx < S; dx++) {
          const k = (y * S + dy) * W + (x * S + dx);
          r += rgb[3 * k]!;
          g += rgb[3 * k + 1]!;
          b += rgb[3 * k + 2]!;
        }
      const o = (y * width + x) * 4;
      out[o] = Math.min(255, Math.round(r / (S * S)));
      out[o + 1] = Math.min(255, Math.round(g / (S * S)));
      out[o + 2] = Math.min(255, Math.round(b / (S * S)));
      out[o + 3] = 255;
    }
  return png(out, width, height);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGBA → PNG (RGB, deflated; the case renders are opaque). */
export function png(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = rgba[(y * w + x) * 4]!;
      raw[o + 1] = rgba[(y * w + x) * 4 + 1]!;
      raw[o + 2] = rgba[(y * w + x) * 4 + 2]!;
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((a, b) => a + b.length, 0);
  const res = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    res.set(p, o);
    o += p.length;
  }
  return res;
}
