// Just enough HTTP/1.x for boards: parse one request from a byte string (as an ESP-01 sends it
// with AT+CIPSEND) and build a short response that fits a SoftwareSerial buffer.

export interface HttpRequest {
  method: string;
  path: string;
  query: string;
  version: string;
  headers: Record<string, string>;
  body: string;
}

export type HttpParse = { done: false } | { done: true; request: HttpRequest; rest: string } | { done: true; error: string };

/** Parse the first request in `data`. `done: false` until the headers (and Content-Length body) are in. */
export function parseHttpRequest(data: string): HttpParse {
  const end = data.indexOf("\r\n\r\n");
  const endLf = end < 0 ? data.indexOf("\n\n") : -1;
  if (end < 0 && endLf < 0) {
    if (data.length > 4096) return { done: true, error: "request headers longer than 4 KB" };
    return { done: false };
  }
  const headEnd = end >= 0 ? end : endLf;
  const sepLen = end >= 0 ? 4 : 2;
  const lines = data.slice(0, headEnd).split(/\r?\n/);
  const first = (lines.shift() ?? "").trim();
  const m = /^([A-Z]+)\s+(\S+)(?:\s+(HTTP\/\d\.\d))?$/.exec(first);
  if (!m) return { done: true, error: `malformed request line '${first.slice(0, 60)}'` };
  const headers: Record<string, string> = {};
  for (const l of lines) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  const len = Number(headers["content-length"] ?? 0) || 0;
  const bodyStart = headEnd + sepLen;
  if (data.length < bodyStart + len) return { done: false };
  const target = m[2]!;
  const q = target.indexOf("?");
  return {
    done: true,
    request: {
      method: m[1]!,
      path: q < 0 ? target : target.slice(0, q),
      query: q < 0 ? "" : target.slice(q + 1),
      version: m[3] ?? "HTTP/1.0",
      headers,
      body: data.slice(bodyStart, bodyStart + len),
    },
    rest: data.slice(bodyStart + len),
  };
}

const REASONS: Record<number, string> = { 200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 504: "Gateway Timeout" };

/** A minimal response: status line, Content-Length, Connection: close, body. */
export function httpResponse(status: number, body: string, extraHeaders: Record<string, string> = {}): string {
  const head = [`HTTP/1.0 ${status} ${REASONS[status] ?? "OK"}`, `Content-Length: ${body.length}`, "Connection: close", ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`)];
  return `${head.join("\r\n")}\r\n\r\n${body}`;
}
