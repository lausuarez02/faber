// A tiny, dependency-free XML reader for part visuals. It is not a general XML parser: it accepts
// the subset part SVGs are allowed to use (elements, attributes, text, comments, CDATA-free) and
// throws a readable error on anything malformed (unbalanced tags, bad attributes, stray '<').

export interface SvgElement {
  tag: string;
  attrs: Record<string, string>;
  /** 1-based line of the opening tag. */
  line: number;
  /** Text directly inside the element (for <text>). */
  text: string;
}

export interface ParsedSvg {
  root: SvgElement;
  elements: SvgElement[];
}

const NAME = /^[A-Za-z_][\w:.-]*/;

export function parseSvg(src: string): ParsedSvg {
  const elements: SvgElement[] = [];
  const stack: SvgElement[] = [];
  let root: SvgElement | undefined;
  let i = 0;
  const lineAt = (pos: number) => src.slice(0, pos).split("\n").length;
  const fail = (msg: string, pos = i): never => {
    throw new Error(`visual.svg line ${lineAt(pos)}: ${msg}`);
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const text = src.slice(i, lt === -1 ? src.length : lt);
    if (text.trim()) {
      const top = stack[stack.length - 1];
      if (!top) fail("text outside the root element");
      else top.text += text.trim();
    }
    if (lt === -1) break;
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      if (end === -1) fail("unterminated comment");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      if (end === -1) fail("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", i)) fail("DOCTYPE/CDATA is not allowed in part visuals");
    if (src.startsWith("</", i)) {
      const m = NAME.exec(src.slice(i + 2));
      if (!m) fail("bad closing tag");
      const tag = m![0];
      const close = src.indexOf(">", i);
      if (close === -1) fail(`unterminated </${tag}>`);
      const open = stack.pop();
      if (!open) fail(`</${tag}> without an opening tag`);
      if (open!.tag !== tag) fail(`</${tag}> closes <${open!.tag}> (opened on line ${open!.line})`);
      i = close + 1;
      continue;
    }
    // opening tag
    const start = i;
    i += 1;
    const m = NAME.exec(src.slice(i));
    if (!m) fail("stray '<' (escape it as &lt;)");
    const el: SvgElement = { tag: m![0], attrs: {}, line: lineAt(start), text: "" };
    i += m![0].length;
    let selfClosing = false;
    for (;;) {
      while (/\s/.test(src[i] ?? "")) i++;
      if (i >= src.length) fail(`unterminated <${el.tag}>`, start);
      if (src.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (src[i] === ">") {
        i += 1;
        break;
      }
      const a = NAME.exec(src.slice(i));
      if (!a) fail(`bad attribute in <${el.tag}>`);
      i += a![0].length;
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] !== "=") fail(`attribute ${a![0]} in <${el.tag}> has no value`);
      i++;
      while (/\s/.test(src[i] ?? "")) i++;
      const q = src[i];
      if (q !== '"' && q !== "'") fail(`attribute ${a![0]} in <${el.tag}> must be quoted`);
      const end = src.indexOf(q!, i + 1);
      if (end === -1) fail(`unterminated value for ${a![0]}`);
      if (a![0] in el.attrs) fail(`duplicate attribute ${a![0]} in <${el.tag}>`);
      el.attrs[a![0]] = src.slice(i + 1, end);
      i = end + 1;
    }
    if (!root) {
      if (stack.length) fail("internal");
      root = el;
    } else if (!stack.length) fail(`second root element <${el.tag}>`, start);
    elements.push(el);
    if (!selfClosing) stack.push(el);
  }
  if (stack.length) fail(`<${stack[stack.length - 1]!.tag}> is never closed`, src.length);
  if (!root) throw new Error("visual.svg: no root element");
  if (root.tag !== "svg") throw new Error(`visual.svg: root element is <${root.tag}>, expected <svg>`);
  return { root, elements };
}

export function parseViewBox(v: string | undefined): [number, number, number, number] | undefined {
  if (!v) return undefined;
  const n = v.trim().split(/[\s,]+/).map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return undefined;
  return n as [number, number, number, number];
}
