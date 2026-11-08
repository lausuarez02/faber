import type { VisualState, VisualValue } from "./part.ts";

/**
 * SVG binding convention (visual.svg):
 *   <circle data-bind="opacity:brightness" …/>
 *   <path   data-bind="fill:color,opacity:brightness" …/>
 *   <text   data-bind="text:label" …/>
 *   <g      data-bind="visible:pressed" …/>
 * Each entry is "<attr>:<stateKey>". Special attrs:
 *   text    → element.textContent = String(value)
 *   visible → display="none" when value is falsy, removes display otherwise
 * Anything else → element.setAttribute(attr, String(value)).
 */
export interface Binding {
  attr: string;
  key: string;
}

export function parseBindings(spec: string): Binding[] {
  const out: Binding[] = [];
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const i = part.indexOf(":");
    if (i <= 0 || i === part.length - 1) throw new Error(`bad data-bind entry '${part}' (expected "attr:stateKey")`);
    out.push({ attr: part.slice(0, i).trim(), key: part.slice(i + 1).trim() });
  }
  return out;
}

/** Minimal DOM surface so this works on real DOM, jsdom, or a test double. */
interface BindableElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  textContent: string | null;
}
interface BindableRoot {
  querySelectorAll(selector: string): ArrayLike<BindableElement> | Iterable<BindableElement>;
}

function applyOne(el: BindableElement, attr: string, value: VisualValue): void {
  if (attr === "text") {
    const s = String(value);
    if (el.textContent !== s) el.textContent = s;
  } else if (attr === "visible") {
    if (value) el.removeAttribute("display");
    else el.setAttribute("display", "none");
  } else {
    const s = String(value);
    if (el.getAttribute(attr) !== s) el.setAttribute(attr, s);
  }
}

/** Apply visualState to every [data-bind] element under root. Keys missing from state are left alone. */
export function applyVisualState(root: BindableRoot, state: VisualState): void {
  const els = root.querySelectorAll("[data-bind]");
  for (const el of Array.from(els as ArrayLike<BindableElement>)) {
    const spec = el.getAttribute("data-bind");
    if (!spec) continue;
    for (const b of parseBindings(spec)) {
      const v = state[b.key];
      if (v !== undefined) applyOne(el, b.attr, v);
    }
  }
}
