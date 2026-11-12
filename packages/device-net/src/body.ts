// Round 14: what a request carried, kept in the network log so tests can check it (content type,
// JSON fields, form fields, multipart parts such as an uploaded photo) without storing whole bodies.
// Generic: any API. Values are redacted with the rest of the log entry (secrets never appear).

/** A short, test-friendly description of a request body. */
export interface BodyInfo {
  /** Bytes in the body. */
  bytes: number;
  /** The start of a text body (JSON, form, plain text), at most TEXT_MAX characters. */
  text?: string;
  /**
   * JSON or form fields flattened by dot path ("caption", "messages.0.role", "photo.content_type");
   * strings cut at FIELD_MAX characters (the cut ones end in "…"). Multipart: each part by name, with
   * its text value, or `<name>.filename`, `<name>.content_type`, `<name>.bytes` for a file.
   */
  fields?: Record<string, string | number | boolean | null>;
  /** Multipart parts (a photo upload): name, file name, type and size. */
  parts?: Array<{ name: string; filename?: string; content_type?: string; bytes: number }>;
}

const TEXT_MAX = 2048;
const FIELD_MAX = 400;
const MAX_FIELDS = 200;

const TEXTUAL = /^(text\/|application\/(json|[\w.+-]*\+json|x-www-form-urlencoded|xml|[\w.+-]*\+xml|javascript|graphql|x-ndjson))/i;

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Flatten JSON into dot paths (depth and count limited). */
export function flattenJson(v: unknown, out: Record<string, string | number | boolean | null> = {}, prefix = "", depth = 0): Record<string, string | number | boolean | null> {
  if (Object.keys(out).length >= MAX_FIELDS) return out;
  if (v === null || typeof v !== "object") {
    if (prefix) out[prefix] = typeof v === "string" ? cut(v, FIELD_MAX) : (v as number | boolean | null);
    return out;
  }
  if (depth >= 6) {
    if (prefix) out[prefix] = cut(JSON.stringify(v), FIELD_MAX);
    return out;
  }
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  if (prefix && entries.length === 0) out[prefix] = Array.isArray(v) ? "[]" : "{}";
  for (const [k, x] of entries) flattenJson(x, out, prefix ? `${prefix}.${k}` : k, depth + 1);
  return out;
}

function multipart(contentType: string, body: Buffer): Pick<BodyInfo, "fields" | "parts"> | undefined {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) return undefined;
  const sep = Buffer.from(`--${boundary}`);
  const parts: NonNullable<BodyInfo["parts"]> = [];
  const fields: NonNullable<BodyInfo["fields"]> = {};
  let i = body.indexOf(sep);
  while (i >= 0 && parts.length < 50) {
    const start = i + sep.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    const next = body.indexOf(sep, start);
    if (next < 0) break;
    const chunk = body.subarray(start, next);
    const headEnd = chunk.indexOf("\r\n\r\n");
    if (headEnd >= 0) {
      const head = chunk.subarray(0, headEnd).toString("latin1");
      let content = chunk.subarray(headEnd + 4);
      if (content.subarray(-2).toString() === "\r\n") content = content.subarray(0, -2);
      const name = /name="([^"]*)"/i.exec(head)?.[1] ?? `part${parts.length}`;
      const filename = /filename="([^"]*)"/i.exec(head)?.[1];
      const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim();
      parts.push({ name, ...(filename !== undefined ? { filename } : {}), ...(type ? { content_type: type } : {}), bytes: content.length });
      if (filename !== undefined || (type && !TEXTUAL.test(type))) {
        if (filename !== undefined) fields[`${name}.filename`] = filename;
        if (type) fields[`${name}.content_type`] = type;
        fields[`${name}.bytes`] = content.length;
      } else {
        const text = content.toString("utf8");
        fields[name] = cut(text, FIELD_MAX);
        if (type && /json/i.test(type)) {
          try {
            flattenJson(JSON.parse(text), fields, name);
          } catch {
            // not JSON after all: the text value stays
          }
        }
      }
    }
    i = next;
  }
  return { parts, fields };
}

/** Describe a request body for the log (never the whole body of a big upload). */
export function describeBody(contentType: string | undefined, body: Buffer): BodyInfo | undefined {
  if (!body.length) return undefined;
  const type = (contentType ?? "").toLowerCase();
  const info: BodyInfo = { bytes: body.length };
  if (type.startsWith("multipart/")) {
    const mp = multipart(contentType!, body);
    if (mp) Object.assign(info, mp);
    return info;
  }
  const textual = TEXTUAL.test(type) || (!type && isMostlyText(body));
  if (!textual) return info;
  const text = body.toString("utf8");
  info.text = cut(text, TEXT_MAX);
  if (/json/.test(type) || (!type && /^\s*[[{]/.test(text))) {
    try {
      info.fields = flattenJson(JSON.parse(text));
    } catch {
      // the device sent broken JSON: the text shows it
    }
  } else if (/x-www-form-urlencoded/.test(type)) {
    const fields: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) fields[k] = cut(v, FIELD_MAX);
    info.fields = fields;
  }
  return info;
}

function isMostlyText(b: Buffer): boolean {
  const n = Math.min(b.length, 512);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i]!;
    if (c < 9 || (c > 13 && c < 32) || c === 127) bad++;
  }
  return bad <= n * 0.02;
}

/** Does a body description match what a test expects? Returns why not, or undefined when it matches. */
export function bodyMismatch(
  entry: { content_type?: string; body?: BodyInfo },
  want: { content_type?: string; body_contains?: string; body_json?: Record<string, unknown>; min_bytes?: number },
): string | undefined {
  if (want.content_type !== undefined && !(entry.content_type ?? "").toLowerCase().includes(want.content_type.toLowerCase())) {
    return `its content type is ${entry.content_type ? JSON.stringify(entry.content_type) : "not set"}, not ${JSON.stringify(want.content_type)}`;
  }
  const b = entry.body;
  if (want.min_bytes !== undefined && (b?.bytes ?? 0) < want.min_bytes) return `its body is ${b?.bytes ?? 0} bytes, fewer than ${want.min_bytes}`;
  if (want.body_contains !== undefined) {
    const needle = want.body_contains.toLowerCase();
    const hay = [b?.text ?? "", ...Object.entries(b?.fields ?? {}).map(([k, v]) => `${k}=${String(v)}`), ...(b?.parts ?? []).map((p) => `${p.name} ${p.filename ?? ""} ${p.content_type ?? ""}`)].join("\n").toLowerCase();
    if (!hay.includes(needle)) return `its body does not contain ${JSON.stringify(want.body_contains)}${b?.text ? ` (it starts ${JSON.stringify(cut(b.text, 120))})` : b ? ` (${b.bytes} B${b.parts ? `, parts ${b.parts.map((p) => p.name).join(", ")}` : ""})` : " (no body)"}`;
  }
  if (want.body_json !== undefined) {
    const have = b?.fields ?? {};
    const expected = flattenJson(want.body_json);
    for (const [k, v] of Object.entries(expected)) {
      if (!(k in have)) return `its body has no field ${JSON.stringify(k)}${Object.keys(have).length ? ` (fields: ${Object.keys(have).slice(0, 12).join(", ")}${Object.keys(have).length > 12 ? ", …" : ""})` : " (no JSON, form or multipart fields)"}`;
      const got = have[k];
      const ok = typeof v === "string" && v.endsWith("*") ? String(got).startsWith(v.slice(0, -1)) : typeof v === "string" && v === "?" ? got !== null && got !== "" : got === v;
      if (!ok) return `its field ${JSON.stringify(k)} is ${JSON.stringify(got)}, not ${JSON.stringify(v)}`;
    }
  }
  return undefined;
}
