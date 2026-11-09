import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * `jumper mcp --attach http://localhost:7780`: a stdio MCP server that forwards every message to a
 * running `jumper serve`, so stdio-only clients drive the same live canvas the person is watching.
 * The client's own initialize (and so its name) passes through unchanged.
 */

/** http://localhost:7780 → http://localhost:7780/mcp (a URL that already ends in /mcp is kept). */
export function attachUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new Error(`--attach '${raw}' is not a URL. Fix: pass the jumper serve address, e.g. --attach http://localhost:7780`);
  }
  if (!u.pathname.replace(/\/+$/, "").endsWith("/mcp")) u.pathname = `${u.pathname.replace(/\/+$/, "")}/mcp`;
  return u;
}

export async function startAttachedStdio(raw: string): Promise<void> {
  const url = attachUrl(raw);
  const health = new URL("/health", url);
  try {
    const r = await fetch(health, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    throw new Error(`No Jumper server at ${url.origin} (${(err as Error).message}). Fix: start it with \`pnpm start\` (or \`jumper serve\`) in the Jumper repo, or drop --attach to run a standalone server.`);
  }
  const upstream = new StreamableHTTPClientTransport(url, { requestInit: { headers: { "x-jumper-transport": "stdio-attach" } } });
  const local = new StdioServerTransport();
  const failReply = (msg: JSONRPCMessage, err: Error) => {
    if ("id" in msg && msg.id !== undefined && "method" in msg) {
      void local.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `Jumper server at ${url.origin} did not answer (${err.message}). Fix: check that jumper serve is still running, then retry.` } });
    }
  };
  local.onmessage = (msg) => {
    upstream.send(msg).catch((err: Error) => failReply(msg, err));
  };
  upstream.onmessage = (msg) => {
    const pv = (msg as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
    if (typeof pv === "string") upstream.setProtocolVersion(pv);
    void local.send(msg);
  };
  upstream.onerror = (err) => process.stderr.write(`jumper mcp --attach: ${err.message}\n`);
  const shutdown = async () => {
    await upstream.terminateSession().catch(() => {});
    await upstream.close().catch(() => {});
    process.exit(0);
  };
  local.onclose = () => void shutdown();
  process.stdin.on("end", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await upstream.start();
  await local.start();
  process.stderr.write(`jumper MCP (stdio) attached to ${url.href}: tool calls drive the live canvas there.\n`);
}
