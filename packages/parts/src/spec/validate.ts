// Static checks for one part folder (src/parts/<id>/). Shared by the registry generator and the
// spec test, so `pnpm gen` refuses to write a registry that `pnpm test` would reject.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FidelitySchema, PartSpecSchema, parseBindings, type Fidelity, type PartSpec } from "@jumper/sim-core";
import { parseSvg, parseViewBox, type ParsedSvg } from "./svg.ts";

export const REQUIRED_FILES = ["part.json", "fidelity.json", "visual.svg", "model.ts", "model.test.ts"] as const;
export const BRAND_FONTS = ["IBM Plex Mono", "IBM Plex Sans", "Bricolage Grotesque"];
/** Max distance (px) between a data-pin circle centre and the part.json anchor. */
export const PIN_TOLERANCE = 0.5;

export interface PartFolder {
  dir: string;
  spec?: PartSpec;
  fidelity?: Fidelity;
  svg?: string;
  parsed?: ParsedSvg;
  problems: string[];
}

function readJson(path: string, problems: string[], label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    problems.push(`${label}: not valid JSON (${(e as Error).message})`);
    return undefined;
  }
}

export function checkPartFolder(partsDir: string, dir: string): PartFolder {
  const at = (f: string) => join(partsDir, dir, f);
  const out: PartFolder = { dir, problems: [] };
  const p = out.problems;
  for (const f of REQUIRED_FILES) if (!existsSync(at(f))) p.push(`${dir}: missing ${f}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(dir)) p.push(`${dir}: folder name must be kebab-case`);

  // part.json
  if (existsSync(at("part.json"))) {
    const raw = readJson(at("part.json"), p, `${dir}/part.json`);
    if (raw !== undefined) {
      const r = PartSpecSchema.safeParse(raw);
      if (!r.success) {
        p.push(...r.error.issues.map((x) => `${dir}/part.json: ${x.path.join(".") || "(root)"}: ${x.message}`));
      } else {
        out.spec = r.data;
        checkSpec(dir, r.data, p);
      }
    }
  }

  // fidelity.json
  if (existsSync(at("fidelity.json"))) {
    const raw = readJson(at("fidelity.json"), p, `${dir}/fidelity.json`);
    if (raw !== undefined) {
      const r = FidelitySchema.safeParse(raw);
      if (!r.success) {
        p.push(...r.error.issues.map((x) => `${dir}/fidelity.json: ${x.path.join(".") || "(root)"}: ${x.message}`));
      } else {
        out.fidelity = r.data;
        for (const [k, a] of Object.entries(r.data.areas)) {
          if (a.level !== "n/a" && !a.note.trim()) p.push(`${dir}/fidelity.json: areas.${k}.note is empty; say what is or is not modelled`);
        }
      }
    }
  }

  // visual.svg
  if (existsSync(at("visual.svg"))) {
    const svg = readFileSync(at("visual.svg"), "utf8").trim();
    out.svg = svg;
    try {
      out.parsed = parseSvg(svg);
    } catch (e) {
      p.push(`${dir}/${(e as Error).message}`);
    }
    if (out.parsed && out.spec) checkSvg(dir, out.spec, out.parsed, p);
  }
  return out;
}

function checkSpec(dir: string, spec: PartSpec, p: string[]): void {
  if (spec.id !== dir) p.push(`${dir}/part.json: id '${spec.id}' must equal the folder name`);
  const seen = new Set<string>();
  for (const pin of spec.pins) {
    if (seen.has(pin.id)) p.push(`${dir}/part.json: duplicate pin id '${pin.id}'`);
    seen.add(pin.id);
    if (pin.x < 0 || pin.x > spec.size.w || pin.y < 0 || pin.y > spec.size.h) {
      p.push(`${dir}/part.json: pin '${pin.id}' at (${pin.x}, ${pin.y}) is outside the ${spec.size.w}×${spec.size.h} viewBox`);
    }
  }
  if (spec.category === "board" && !spec.mcu) p.push(`${dir}/part.json: board parts need an "mcu" block`);
  const props = new Set<string>();
  for (const prop of spec.props ?? []) {
    if (props.has(prop.id)) p.push(`${dir}/part.json: duplicate prop '${prop.id}'`);
    props.add(prop.id);
    if (prop.type === "enum") {
      const values = (prop.options ?? []).map((o) => (typeof o === "string" ? o : o.value));
      if (!values.length) p.push(`${dir}/part.json: enum prop '${prop.id}' has no options`);
      else if (!values.includes(String(prop.default))) p.push(`${dir}/part.json: prop '${prop.id}' default '${prop.default}' is not one of its options`);
    }
    if (prop.type === "number") {
      if (typeof prop.default !== "number") p.push(`${dir}/part.json: number prop '${prop.id}' needs a numeric default`);
      else if ((prop.min !== undefined && prop.default < prop.min) || (prop.max !== undefined && prop.default > prop.max)) {
        p.push(`${dir}/part.json: prop '${prop.id}' default ${prop.default} is outside min/max`);
      }
    }
  }
  const keys = new Set<string>();
  for (const b of spec.bindings ?? []) {
    if (keys.has(b.key)) p.push(`${dir}/part.json: duplicate binding key '${b.key}'`);
    keys.add(b.key);
  }
}

function checkSvg(dir: string, spec: PartSpec, svg: ParsedSvg, p: string[]): void {
  const vb = parseViewBox(svg.root.attrs.viewBox);
  if (!vb) p.push(`${dir}/visual.svg: root <svg> needs viewBox="0 0 ${spec.size.w} ${spec.size.h}"`);
  else if (vb[0] !== 0 || vb[1] !== 0 || vb[2] !== spec.size.w || vb[3] !== spec.size.h) {
    p.push(`${dir}/visual.svg: viewBox "${svg.root.attrs.viewBox}" must be "0 0 ${spec.size.w} ${spec.size.h}" (part.json size)`);
  }
  const pins = new Map(spec.pins.map((x) => [x.id, x]));
  const bindingKeys = new Set((spec.bindings ?? []).map((b) => b.key));
  const marked = new Set<string>();
  for (const el of svg.elements) {
    const where = `${dir}/visual.svg line ${el.line}`;
    if (["script", "foreignObject", "iframe", "image", "style"].includes(el.tag)) p.push(`${where}: <${el.tag}> is not allowed in part visuals`);
    for (const [k, v] of Object.entries(el.attrs)) {
      if (/^on/i.test(k)) p.push(`${where}: event handler attribute ${k} is not allowed`);
      if ((k === "href" || k === "xlink:href") && !v.startsWith("#")) p.push(`${where}: external reference ${k}="${v}" is not allowed`);
      if (/url\((?!#)/.test(v)) p.push(`${where}: external url() in ${k} is not allowed`);
    }
    const id = el.attrs.id;
    if (id !== undefined && !id.startsWith(`${spec.id}-`)) p.push(`${where}: id "${id}" must start with "${spec.id}-" (many copies share one page)`);
    const font = el.attrs["font-family"];
    if (font !== undefined) {
      const first = font.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "");
      if (!BRAND_FONTS.includes(first)) p.push(`${where}: font-family "${font}" is not a brand font (${BRAND_FONTS.join(", ")})`);
    }
    const pinId = el.attrs["data-pin"];
    if (pinId !== undefined) {
      const pin = pins.get(pinId);
      if (!pin) p.push(`${where}: data-pin="${pinId}" is not a pin in part.json`);
      else {
        marked.add(pinId);
        const cx = Number(el.attrs.cx ?? el.attrs.x);
        const cy = Number(el.attrs.cy ?? el.attrs.y);
        if (Number.isFinite(cx) && Number.isFinite(cy) && Math.hypot(cx - pin.x, cy - pin.y) > PIN_TOLERANCE) {
          p.push(`${where}: data-pin="${pinId}" is drawn at (${cx}, ${cy}) but part.json says (${pin.x}, ${pin.y})`);
        }
      }
    }
    const bind = el.attrs["data-bind"];
    if (bind !== undefined) {
      try {
        for (const b of parseBindings(bind)) {
          if (!bindingKeys.has(b.key)) p.push(`${where}: data-bind key '${b.key}' is not documented in part.json "bindings"`);
        }
      } catch (e) {
        p.push(`${where}: ${(e as Error).message}`);
      }
    }
  }
  for (const pin of spec.pins) {
    if (!marked.has(pin.id)) p.push(`${dir}/visual.svg: pin '${pin.id}' has no <circle data-pin="${pin.id}"> anchor`);
  }
}

/** Every data-bind key used in an SVG. */
export function boundKeys(svg: ParsedSvg): Set<string> {
  const out = new Set<string>();
  for (const el of svg.elements) {
    const bind = el.attrs["data-bind"];
    if (bind) for (const b of parseBindings(bind)) out.add(b.key);
  }
  return out;
}
