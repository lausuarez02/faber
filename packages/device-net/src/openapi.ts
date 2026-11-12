// Round 14: mock ANY API from its OpenAPI 3 description. One mock {"kind": "openapi", "host",
// "spec": "network/api.yaml"} answers every operation in the file with its example response (or one
// made from the response schema, deterministically), and checks each request the device sends
// against the operation: path, method, content type, required body, and the body against its JSON
// schema. A request that does not fit gets 400 with what is wrong, why and the fix, and the log and
// the request step say so. Generic: nothing here knows what the API is for.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BodyInfo } from "./body.ts";
import { ConfigError, type HttpMock, type HttpMockResponse } from "./config.ts";

/** jumper mock: {"kind": "openapi", "host", "spec": "<file in the project>" | {…the document…}}. */
export interface OpenApiMock {
  kind: "openapi";
  host: string;
  /** The OpenAPI 3.x document: a path in the project (JSON or YAML), or the document itself. */
  spec: string | Record<string, unknown>;
  /** Path prefix the operations live under (default: the path of servers[0].url, e.g. "/v1"). */
  base_path?: string;
  /** Check requests against the operation (default true). */
  validate?: boolean;
  /** Fixed answers by operationId or "METHOD /path/{template}", e.g. {"createPost": {"status": 503}}. */
  responses?: Record<string, HttpMockResponse>;
  /** Set by resolveOpenApiMock: the parsed document (never written to mocks.json). */
  spec_doc?: Record<string, unknown>;
}

type Schema = Record<string, unknown>;
type Doc = { paths?: Record<string, Record<string, unknown>>; servers?: Array<{ url?: string }>; components?: { schemas?: Record<string, Schema> } } & Record<string, unknown>;

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

/** Read and parse the spec file (JSON or YAML) relative to the project folder. */
export function loadOpenApiDoc(spec: string | Record<string, unknown>, projectDir: string, field = "mock.spec"): Doc {
  if (typeof spec === "object" && spec) return checkDoc(spec as Doc, field, "the inline document");
  if (typeof spec !== "string" || !spec) throw new ConfigError(`${field} is missing`, "an openapi mock needs the API's OpenAPI 3 description", '"spec": "network/my-api.openapi.yaml" (a file in the project)', field);
  const file = isAbsolute(spec) ? spec : join(projectDir, spec);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new ConfigError(`${field}: ${spec} could not be read`, (e as Error).message, `put the OpenAPI file at ${spec} in the project (write_file), or fix the path`, field);
  }
  let doc: unknown;
  try {
    doc = /^\s*[{[]/.test(text) ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new ConfigError(`${field}: ${spec} is not valid JSON or YAML`, (e as Error).message, "fix the file (an OpenAPI 3 document)", field);
  }
  return checkDoc(doc as Doc, field, spec);
}

function checkDoc(doc: Doc, field: string, what: string): Doc {
  if (!doc || typeof doc !== "object" || typeof doc.openapi !== "string" || !/^3\./.test(doc.openapi as string)) {
    throw new ConfigError(`${field}: ${what} is not an OpenAPI 3 document`, `it needs "openapi": "3.x" at the top (found ${doc && typeof doc === "object" ? JSON.stringify((doc as Doc).openapi ?? (doc as Doc).swagger ?? null) : typeof doc})`, "convert a Swagger 2 file to OpenAPI 3 (e.g. with swagger2openapi), or write the paths you need in OpenAPI 3", field);
  }
  if (!doc.paths || typeof doc.paths !== "object" || !Object.keys(doc.paths).length) {
    throw new ConfigError(`${field}: ${what} has no paths`, "the mock answers the operations listed under paths", 'add the operations the device calls, e.g. paths: {"/posts": {"post": {...}}}', field);
  }
  return doc;
}

/** Validate an openapi mock and attach its parsed document (spec_doc). */
export function resolveOpenApiMock(m: OpenApiMock, projectDir: string, field = "mock"): OpenApiMock {
  const doc = m.spec_doc ? checkDoc(m.spec_doc as Doc, `${field}.spec`, "the document") : loadOpenApiDoc(m.spec, projectDir, `${field}.spec`);
  if (m.base_path !== undefined && (typeof m.base_path !== "string" || !m.base_path.startsWith("/"))) throw new ConfigError(`${field}.base_path must start with /`, "it is the prefix the operations live under", '"base_path": "/v1"', `${field}.base_path`);
  for (const key of Object.keys(m.responses ?? {})) {
    if (!findOperationByKey(doc, key)) throw new ConfigError(`${field}.responses: no operation '${key}' in the spec`, `responses are keyed by operationId or "METHOD /path"; the spec has ${listOperations(doc).slice(0, 8).join(", ")}`, "use one of those keys", `${field}.responses`);
  }
  return { ...m, spec_doc: doc };
}

/** The mock as it is written to mocks.json (without the parsed document). */
export function storedOpenApiMock(m: OpenApiMock): OpenApiMock {
  const { spec_doc: _doc, ...rest } = m;
  return typeof m.spec === "string" ? rest : { ...rest, spec: m.spec };
}

/** "POST /posts (createPost)", ... for messages. */
export function listOperations(doc: Doc): string[] {
  const out: string[] = [];
  for (const [p, item] of Object.entries(doc.paths ?? {})) for (const mth of METHODS) if (item?.[mth]) out.push(`${mth.toUpperCase()} ${p}${(item[mth] as Schema).operationId ? ` (${(item[mth] as Schema).operationId})` : ""}`);
  return out;
}

function findOperationByKey(doc: Doc, key: string): boolean {
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    for (const mth of METHODS) {
      const op = item?.[mth] as Schema | undefined;
      if (op && (op.operationId === key || `${mth.toUpperCase()} ${p}` === key)) return true;
    }
  }
  return false;
}

function basePath(m: OpenApiMock, doc: Doc): string {
  if (m.base_path !== undefined) return m.base_path.replace(/\/$/, "");
  const url = doc.servers?.[0]?.url;
  if (!url) return "";
  try {
    return new URL(url, "http://x").pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

export interface OpenApiMatch {
  template: string;
  method: string;
  op: Schema;
  params: Record<string, string>;
  key: string;
}

/** The operation a request is for, or undefined. */
export function matchOperation(m: OpenApiMock, method: string, rawPath: string): OpenApiMatch | undefined {
  const doc = m.spec_doc as Doc | undefined;
  if (!doc) return undefined;
  const base = basePath(m, doc);
  let path = rawPath.split("?")[0]!;
  if (base) {
    if (!path.startsWith(base)) return undefined;
    path = path.slice(base.length) || "/";
  }
  const mth = method.toLowerCase();
  // exact templates first, then the ones with parameters (so /posts/mine wins over /posts/{id})
  const entries = Object.entries(doc.paths ?? {}).sort(([a], [b]) => (a.includes("{") ? 1 : 0) - (b.includes("{") ? 1 : 0));
  for (const [tpl, item] of entries) {
    const op = item?.[mth] as Schema | undefined;
    if (!op) continue;
    const names: string[] = [];
    const re = new RegExp(`^${tpl.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{([^}]+)\\?\}/g, (_, n: string) => (names.push(n), "([^/]+)"))}/?$`);
    const hit = re.exec(path);
    if (!hit) continue;
    const params: Record<string, string> = {};
    names.forEach((n, i) => (params[n] = decodeURIComponent(hit[i + 1]!)));
    return { template: tpl, method: mth, op, params, key: (op.operationId as string | undefined) ?? `${method.toUpperCase()} ${tpl}` };
  }
  return undefined;
}

function resolveRef(doc: Doc, s: Schema | undefined, depth = 0): Schema | undefined {
  if (!s || depth > 20) return s;
  const ref = s.$ref as string | undefined;
  if (!ref) return s;
  if (!ref.startsWith("#/")) return {};
  let cur: unknown = doc;
  for (const part of ref.slice(2).split("/")) cur = (cur as Record<string, unknown> | undefined)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return resolveRef(doc, cur as Schema | undefined, depth + 1);
}

/** A deterministic example value for a schema (example, default, enum, or built from the type). */
export function exampleOf(doc: Doc, raw: Schema | undefined, depth = 0, name = ""): unknown {
  const s = resolveRef(doc, raw);
  if (!s || depth > 8) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  for (const k of ["allOf", "oneOf", "anyOf"]) {
    const list = s[k] as Schema[] | undefined;
    if (list?.length) {
      if (k === "allOf") return Object.assign({}, ...list.map((x) => exampleOf(doc, x, depth + 1, name)).filter((x) => x && typeof x === "object"));
      return exampleOf(doc, list[0], depth + 1, name);
    }
  }
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== "null") : (s.type as string | undefined) ?? (s.properties ? "object" : s.items ? "array" : undefined);
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((s.properties as Record<string, Schema>) ?? {})) out[k] = exampleOf(doc, v, depth + 1, k);
      return out;
    }
    case "array":
      return [exampleOf(doc, s.items as Schema, depth + 1, name)];
    case "integer":
      return typeof s.minimum === "number" ? Math.ceil(s.minimum) : 1;
    case "number":
      return typeof s.minimum === "number" ? s.minimum : 1.5;
    case "boolean":
      return true;
    case "string": {
      const f = s.format as string | undefined;
      if (f === "date-time") return "2026-01-01T12:00:00Z";
      if (f === "date") return "2026-01-01";
      if (f === "uuid") return "00000000-0000-4000-8000-000000000001";
      if (f === "uri" || f === "url") return "https://example.test/item/1";
      if (f === "email") return "someone@example.test";
      if (f === "binary" || f === "byte") return "";
      const base = name ? `${name}-1` : "string";
      return typeof s.minLength === "number" && base.length < s.minLength ? base.padEnd(s.minLength, "x") : base;
    }
    default:
      return null;
  }
}

/** The answer for an operation: a fixed one from the mock, else the operation's example (2xx first). */
export function answerFor(m: OpenApiMock, hit: OpenApiMatch): HttpMock {
  const fixed = m.responses?.[hit.key] ?? m.responses?.[`${hit.method.toUpperCase()} ${hit.template}`];
  if (fixed) return { host: m.host, path: hit.template, method: hit.method.toUpperCase(), response: fixed };
  const doc = m.spec_doc as Doc;
  const responses = (hit.op.responses ?? {}) as Record<string, Schema>;
  const codes = Object.keys(responses);
  const code = codes.find((c) => /^2\d\d$/.test(c)) ?? codes.find((c) => c === "default") ?? codes[0];
  const status = code && /^\d{3}$/.test(code) ? Number(code) : 200;
  const r = resolveRef(doc, responses[code ?? ""]) ?? {};
  const content = (r.content ?? {}) as Record<string, Schema>;
  const type = Object.keys(content).find((t) => /json/.test(t)) ?? Object.keys(content)[0];
  if (!type) return { host: m.host, path: hit.template, method: hit.method.toUpperCase(), response: { status } };
  const media = content[type]!;
  let body: unknown;
  if (media.example !== undefined) body = media.example;
  else if (media.examples && typeof media.examples === "object") body = resolveRef(doc, Object.values(media.examples as Record<string, Schema>)[0])?.value;
  if (body === undefined) body = exampleOf(doc, media.schema as Schema);
  // the path's own parameters show up in the answer when the example has a field of that name
  if (body && typeof body === "object" && !Array.isArray(body)) for (const [k, v] of Object.entries(hit.params)) if (k in (body as Record<string, unknown>)) (body as Record<string, unknown>)[k] = v;
  return { host: m.host, path: hit.template, method: hit.method.toUpperCase(), response: { status, ...(/json/.test(type) ? { body } : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": type } }) } };
}

/** JSON-schema check of a value (the subset APIs use). Returns problems as "field: what" strings. */
export function validateSchema(doc: Doc, raw: Schema | undefined, v: unknown, at = "body", out: string[] = [], depth = 0): string[] {
  const s = resolveRef(doc, raw);
  if (!s || depth > 20 || out.length > 20) return out;
  if (v === null && (s.nullable === true || (Array.isArray(s.type) && (s.type as string[]).includes("null")))) return out;
  if (Array.isArray(s.allOf)) for (const x of s.allOf as Schema[]) validateSchema(doc, x, v, at, out, depth + 1);
  for (const k of ["oneOf", "anyOf"] as const) {
    const list = s[k] as Schema[] | undefined;
    if (list?.length && !list.some((x) => validateSchema(doc, x, v, at, [], depth + 1).length === 0)) out.push(`${at}: does not match any of the ${list.length} allowed shapes (${k})`);
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) out.push(`${at}: ${JSON.stringify(v)} is not one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  const types = Array.isArray(s.type) ? (s.type as string[]) : s.type ? [s.type as string] : s.properties ? ["object"] : [];
  if (types.length) {
    const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) {
      out.push(`${at}: is ${actual === "undefined" ? "missing" : `a ${actual}`}${actual !== "undefined" ? ` (${JSON.stringify(v)?.slice(0, 40)})` : ""}, the API wants ${types.join(" or ")}`);
      return out;
    }
  }
  if (typeof v === "string") {
    if (typeof s.minLength === "number" && v.length < s.minLength) out.push(`${at}: is ${v.length} characters, at least ${s.minLength} wanted`);
    if (typeof s.maxLength === "number" && v.length > s.maxLength) out.push(`${at}: is ${v.length} characters, at most ${s.maxLength} allowed`);
    if (typeof s.pattern === "string") {
      try {
        if (!new RegExp(s.pattern as string, "u").test(v)) out.push(`${at}: ${JSON.stringify(v.slice(0, 40))} does not match the pattern ${s.pattern}`);
      } catch {
        // a pattern JavaScript cannot read is skipped
      }
    }
    if (s.format === "date-time" && Number.isNaN(Date.parse(v))) out.push(`${at}: ${JSON.stringify(v.slice(0, 40))} is not a date-time (RFC 3339, e.g. 2026-01-01T12:00:00Z)`);
  }
  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum) out.push(`${at}: ${v} is under the minimum ${s.minimum}`);
    if (typeof s.maximum === "number" && v > s.maximum) out.push(`${at}: ${v} is over the maximum ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems) out.push(`${at}: has ${v.length} items, at least ${s.minItems} wanted`);
    if (typeof s.maxItems === "number" && v.length > s.maxItems) out.push(`${at}: has ${v.length} items, at most ${s.maxItems} allowed`);
    v.slice(0, 50).forEach((x, i) => validateSchema(doc, s.items as Schema, x, `${at}[${i}]`, out, depth + 1));
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const r of (s.required as string[]) ?? []) if (!(r in o)) out.push(`${at}.${r}: is required but missing`);
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const [k, x] of Object.entries(o)) {
      if (props[k]) validateSchema(doc, props[k], x, `${at}.${k}`, out, depth + 1);
      else if (s.additionalProperties === false) out.push(`${at}.${k}: is not a field of this API (allowed: ${Object.keys(props).join(", ")})`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") validateSchema(doc, s.additionalProperties as Schema, x, `${at}.${k}`, out, depth + 1);
    }
  }
  return out;
}

/**
 * Check one request against its operation. Returns the problems (empty: it fits). `body` is the
 * request's raw bytes; `info` what describeBody made of it (multipart parts, form fields).
 */
export function validateRequest(m: OpenApiMock, hit: OpenApiMatch, rawPath: string, contentType: string | undefined, body: Buffer, info: BodyInfo | undefined): string[] {
  const doc = m.spec_doc as Doc;
  const problems: string[] = [];
  const query = new URLSearchParams(rawPath.split("?")[1] ?? "");
  const params = [...(((doc.paths?.[hit.template] as Schema | undefined)?.parameters as Schema[]) ?? []), ...((hit.op.parameters as Schema[]) ?? [])].map((p) => resolveRef(doc, p) ?? {});
  for (const p of params) {
    const name = p.name as string;
    if (p.in === "query" && p.required && !query.has(name)) problems.push(`query parameter ${name}: is required but missing`);
    if ((p.in === "path" || p.in === "query") && p.schema) {
      const raw = p.in === "path" ? hit.params[name] : query.get(name);
      if (raw !== undefined && raw !== null) {
        const sch = resolveRef(doc, p.schema as Schema) ?? {};
        const value = sch.type === "integer" || sch.type === "number" ? (Number.isFinite(Number(raw)) ? Number(raw) : raw) : sch.type === "boolean" ? (raw === "true" ? true : raw === "false" ? false : raw) : raw;
        validateSchema(doc, sch, value, `${p.in} parameter ${name}`, problems);
      }
    }
  }
  const rb = resolveRef(doc, hit.op.requestBody as Schema | undefined);
  if (!rb) return problems;
  const content = (rb.content ?? {}) as Record<string, Schema>;
  if (!body.length) {
    if (rb.required) problems.push(`body: is required (${Object.keys(content).join(" or ")}) but the request has none`);
    return problems;
  }
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const key = Object.keys(content).find((k) => k.toLowerCase() === ct) ?? Object.keys(content).find((k) => k.endsWith("/*") && ct.startsWith(k.slice(0, -1))) ?? Object.keys(content).find((k) => k === "*/*");
  if (!key) {
    problems.push(`Content-Type: is ${ct ? JSON.stringify(ct) : "not set"}, the API takes ${Object.keys(content).join(" or ")}`);
    return problems;
  }
  const schema = content[key]!.schema as Schema | undefined;
  if (!schema) return problems;
  if (/json/.test(key)) {
    let v: unknown;
    try {
      v = JSON.parse(body.toString("utf8"));
    } catch (e) {
      problems.push(`body: is not valid JSON (${(e as Error).message})`);
      return problems;
    }
    validateSchema(doc, schema, v, "body", problems);
  } else if (/multipart\/form-data|x-www-form-urlencoded/.test(key)) {
    const s = resolveRef(doc, schema) ?? {};
    const props = (s.properties ?? {}) as Record<string, Schema>;
    const parts = new Map((info?.parts ?? []).map((p) => [p.name, p]));
    const fields = info?.fields ?? {};
    for (const r of (s.required as string[]) ?? []) if (!parts.has(r) && !(r in fields)) problems.push(`body.${r}: is required but the form has no "${r}" part`);
    for (const [k, ps] of Object.entries(props)) {
      const sch = resolveRef(doc, ps) ?? {};
      const part = parts.get(k);
      if (sch.format === "binary" || sch.format === "byte") {
        if (part && part.bytes === 0) problems.push(`body.${k}: the file part is empty`);
        const enc = ((content[key]!.encoding as Record<string, Schema> | undefined)?.[k]?.contentType as string | undefined) ?? undefined;
        if (part && enc && part.content_type && !enc.split(",").some((t) => matchesType(t.trim(), part.content_type!))) problems.push(`body.${k}: is ${part.content_type}, the API takes ${enc}`);
      } else if (k in fields && fields[k] !== null) {
        const raw = String(fields[k]);
        const value = sch.type === "integer" || sch.type === "number" ? Number(raw) : sch.type === "boolean" ? raw === "true" : raw;
        validateSchema(doc, sch, value, `body.${k}`, problems);
      }
    }
  }
  return problems;
}

function matchesType(pattern: string, type: string): boolean {
  const t = type.split(";")[0]!.trim().toLowerCase();
  const p = pattern.toLowerCase();
  return p === t || p === "*/*" || (p.endsWith("/*") && t.startsWith(p.slice(0, -1)));
}

/** Resolve every openapi mock of a list (read its spec file); other mocks pass through. */
export function resolveMocks<T extends { kind?: string }>(list: T[], projectDir: string, field = "mocks"): T[] {
  return list.map((m, i) => (m.kind === "openapi" ? (resolveOpenApiMock(m as unknown as OpenApiMock, projectDir, `${field}[${i}]`) as unknown as T) : m));
}
