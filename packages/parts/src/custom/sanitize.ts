// SVG sanitizer for agent-made part visuals (decision 0003, C4). The SVG ends up inlined in the
// person's canvas (innerHTML) and in headless screenshots, so it is rebuilt from an allowlist
// instead of being passed through: unknown elements and attributes are dropped, and so is
// anything that can run code or reach the network:
//   <script>, <foreignObject>, <style>, <iframe>, <a>, animation elements, DOCTYPE/entities,
//   on*= event attributes, href / xlink:href other than "#id" (and data:image/png|jpeg|gif|webp
//   on <image>), url(…) other than url(#id), javascript:, CSS expression() / @import.
// Ids are prefixed with the part id (and references rewritten) so several parts on one page do
// not share gradients or filters. Pure string code: works in Node and the browser.

export interface SanitizeResult {
  svg: string;
  /** What was removed or changed, one line each (shown to the agent as warnings). */
  removed: string[];
}

export class SvgError extends Error {}

const MAX_BYTES = 256 * 1024;
const MAX_ELEMENTS = 4000;

const ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "title", "desc",
  "rect", "circle", "ellipse", "line", "polyline", "polygon", "path",
  "text", "tspan", "textPath",
  "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask", "marker",
  "filter", "feGaussianBlur", "feOffset", "feMerge", "feMergeNode", "feFlood", "feComposite",
  "feColorMatrix", "feBlend", "feDropShadow", "feMorphology",
  "image",
]);
/** Dropped with everything inside them. */
const DROP_SUBTREE = new Set(["script", "foreignObject", "style", "iframe", "object", "embed", "audio", "video", "canvas", "handler", "listener", "set", "animate", "animateTransform", "animateMotion", "discard", "a", "switch", "metadata"]);

const ATTR_NAME = /^(?:[a-zA-Z_][\w.-]*)(?::[a-zA-Z_][\w.-]*)?$/;
/** Attributes whose value is a URL. */
const HREF_ATTRS = new Set(["href", "xlink:href"]);
const NS_OK: Record<string, string> = {
  xmlns: "http://www.w3.org/2000/svg",
  "xmlns:xlink": "http://www.w3.org/1999/xlink",
};
const RASTER_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;

interface Node {
  tag: string;
  attrs: [string, string][];
  children: (Node | string)[];
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return NAMED[e] ?? m;
  });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Tokenize into a tree. Throws SvgError with a line number on malformed markup. */
function parse(src: string): Node {
  const lineAt = (pos: number) => src.slice(0, pos).split("\n").length;
  const fail = (msg: string, pos: number): never => {
    throw new SvgError(`line ${lineAt(pos)}: ${msg}`);
  };
  const NAME = /^[A-Za-z_][\w:.-]*/;
  const doc: Node = { tag: "#doc", attrs: [], children: [] };
  const stack: Node[] = [doc];
  let i = 0;
  let count = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const text = src.slice(i, lt === -1 ? src.length : lt);
    if (text.length) stack[stack.length - 1]!.children.push(decode(text));
    if (lt === -1) break;
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      if (end === -1) fail("unterminated comment", i);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      if (end === -1) fail("unterminated <? … ?>", i);
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", i)) fail("DOCTYPE, ENTITY and CDATA are not allowed", i);
    if (src.startsWith("</", i)) {
      const m = NAME.exec(src.slice(i + 2));
      if (!m) fail("bad closing tag", i);
      const close = src.indexOf(">", i);
      if (close === -1) fail(`unterminated </${m![0]}>`, i);
      const open = stack.pop();
      if (!open || open === doc) fail(`</${m![0]}> without an opening tag`, i);
      if (open!.tag !== m![0]) fail(`</${m![0]}> closes <${open!.tag}>`, i);
      i = close + 1;
      continue;
    }
    const start = i;
    i++;
    const m = NAME.exec(src.slice(i));
    if (!m) fail("stray '<' (write it as &lt;)", start);
    const el: Node = { tag: m![0], attrs: [], children: [] };
    if (++count > MAX_ELEMENTS) fail(`more than ${MAX_ELEMENTS} elements; simplify the drawing`, start);
    i += m![0].length;
    let selfClosing = false;
    const seen = new Set<string>();
    for (;;) {
      while (/\s/.test(src[i] ?? "")) i++;
      if (i >= src.length) fail(`unterminated <${el.tag}>`, start);
      if (src.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (src[i] === ">") {
        i++;
        break;
      }
      const a = NAME.exec(src.slice(i));
      if (!a) fail(`bad attribute in <${el.tag}>`, i);
      i += a![0].length;
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] !== "=") fail(`attribute ${a![0]} in <${el.tag}> has no value`, i);
      i++;
      while (/\s/.test(src[i] ?? "")) i++;
      const q = src[i];
      if (q !== '"' && q !== "'") fail(`attribute ${a![0]} in <${el.tag}> must be quoted`, i);
      const end = src.indexOf(q!, i + 1);
      if (end === -1) fail(`unterminated value for ${a![0]}`, i);
      if (seen.has(a![0])) fail(`duplicate attribute ${a![0]} in <${el.tag}>`, i);
      seen.add(a![0]);
      el.attrs.push([a![0], decode(src.slice(i + 1, end))]);
      i = end + 1;
    }
    stack[stack.length - 1]!.children.push(el);
    if (!selfClosing) stack.push(el);
  }
  if (stack.length > 1) fail(`<${stack[stack.length - 1]!.tag}> is never closed`, src.length);
  const roots = doc.children.filter((c): c is Node => typeof c !== "string");
  if (doc.children.some((c) => typeof c === "string" && c.trim())) throw new SvgError("text outside the <svg> element");
  if (roots.length !== 1) throw new SvgError(roots.length ? "more than one root element" : "no <svg> element");
  if (roots[0]!.tag !== "svg") throw new SvgError(`the root element is <${roots[0]!.tag}>, expected <svg>`);
  return roots[0]!;
}

/** True when a CSS-ish value is safe: url() only to #ids, no javascript:, expression(), @import, behaviour bindings. */
function safeCss(v: string): boolean {
  const s = v.replace(/\\/g, "").replace(/\s+/g, "").toLowerCase();
  if (/javascript:|vbscript:|expression\(|@import|behavior:|-moz-binding/.test(s)) return false;
  const urls = s.match(/url\(([^)]*)\)/g) ?? [];
  return urls.every((u) => /^url\((['"]?)#[\w.:-]+\1\)$/.test(u));
}

/**
 * Sanitize an agent-supplied SVG. `idPrefix` (the part id) is put in front of every id.
 * Throws SvgError when it cannot be parsed (the message says where).
 */
export function sanitizeSvg(src: string, idPrefix: string): SanitizeResult {
  if (src.length > MAX_BYTES) throw new SvgError(`it is ${Math.round(src.length / 1024)} KB; the limit is ${MAX_BYTES / 1024} KB (simplify paths, drop embedded images)`);
  const root = parse(src.replace(/^﻿/, ""));
  const removed: string[] = [];
  const note = (s: string) => {
    if (!removed.includes(s)) removed.push(s);
  };
  const ids = new Map<string, string>();
  const prefix = `${idPrefix}-`;
  // First pass: collect ids so references can be rewritten.
  const collect = (n: Node) => {
    for (const [k, v] of n.attrs) if (k === "id" && v) ids.set(v, v.startsWith(prefix) ? v : prefix + v);
    for (const c of n.children) if (typeof c !== "string") collect(c);
  };
  collect(root);
  const refId = (id: string) => ids.get(id) ?? id;
  const rewriteUrls = (v: string) => v.replace(/url\(\s*(['"]?)#([\w.:-]+)\1\s*\)/g, (_m, _q, id: string) => `url(#${refId(id)})`);

  const out = (n: Node, depth: number): string => {
    if (DROP_SUBTREE.has(n.tag)) {
      note(`removed <${n.tag}> (not allowed in part visuals)`);
      return "";
    }
    if (!ELEMENTS.has(n.tag)) {
      note(`removed unknown element <${n.tag}>`);
      return "";
    }
    const attrs: string[] = [];
    for (const [k, v] of n.attrs) {
      if (!ATTR_NAME.test(k)) {
        note(`removed attribute ${k}`);
        continue;
      }
      if (/^on/i.test(k)) {
        note(`removed event handler ${k}= (no scripts in part visuals)`);
        continue;
      }
      if (k.startsWith("xmlns")) {
        if (NS_OK[k] !== v) note(`removed namespace ${k}="${v}"`);
        continue; // re-added on the root below
      }
      if (HREF_ATTRS.has(k)) {
        if (v.startsWith("#")) attrs.push(`${k}="${esc("#" + refId(v.slice(1)))}"`);
        else if (n.tag === "image" && RASTER_DATA.test(v)) attrs.push(`${k}="${esc(v.replace(/\s+/g, ""))}"`);
        else note(`removed ${k}="${v.slice(0, 40)}${v.length > 40 ? "…" : ""}" (only #id links${n.tag === "image" ? " and data:image/png|jpeg|gif|webp" : ""} are allowed)`);
        continue;
      }
      if (/^(src|action|formaction|from|to|values|begin|end|attributeName)$/i.test(k)) {
        note(`removed attribute ${k}`);
        continue;
      }
      if (!safeCss(v)) {
        note(`removed ${k}="${v.slice(0, 40)}${v.length > 40 ? "…" : ""}" (external url(), javascript: or CSS expressions)`);
        continue;
      }
      if (k === "id") {
        attrs.push(`id="${esc(refId(v))}"`);
        continue;
      }
      attrs.push(`${k}="${esc(rewriteUrls(v))}"`);
    }
    if (n.tag === "image" && !n.attrs.some(([k, v]) => HREF_ATTRS.has(k) && RASTER_DATA.test(v))) {
      note("removed <image> without an inline data:image source");
      return "";
    }
    if (depth === 0) attrs.unshift(`xmlns="${NS_OK.xmlns}"`, ...(src.includes("xlink:") ? [`xmlns:xlink="${NS_OK["xmlns:xlink"]}"`] : []));
    const inner = n.children.map((c) => (typeof c === "string" ? (c.trim() ? esc(c) : c.includes("\n") ? "\n" : c) : out(c, depth + 1))).join("");
    const open = `<${n.tag}${attrs.length ? " " + attrs.join(" ") : ""}`;
    return inner ? `${open}>${inner}</${n.tag}>` : `${open}/>`;
  };
  return { svg: out(root, 0), removed };
}

/** The viewBox of an SVG root as [x, y, w, h], or undefined. */
export function svgViewBox(svg: string): [number, number, number, number] | undefined {
  const m = /<svg\b[^>]*\sviewBox="([^"]*)"/.exec(svg);
  if (!m) return undefined;
  const n = m[1]!.trim().split(/[\s,]+/).map(Number);
  return n.length === 4 && n.every(Number.isFinite) ? (n as [number, number, number, number]) : undefined;
}

/** Set viewBox / width / height on the root <svg> (replacing any there). */
export function setSvgSize(svg: string, w: number, h: number): string {
  return svg.replace(/<svg\b([^>]*?)(\/?)>/, (_m, attrs: string, sc: string) => {
    const kept = attrs.replace(/\s(viewBox|width|height)="[^"]*"/g, "");
    return `<svg${kept} viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${sc}>`;
  });
}
