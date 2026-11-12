import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PROMPTS, renderGuide, renderPrompt } from "@jumper/agent-skill";
import { AGENT_LOOP, ProjectSession, TOOLS, type Builder, type CallMeta } from "@jumper/session";

export const SERVER_NAME = "jumper";
export const SERVER_VERSION = "0.1.0";

const TOOL_NAMES = TOOLS.map((t) => t.name);

const DOCS_AGENTS = fileURLToPath(new URL("../../../docs/agents.md", import.meta.url));

export interface JumperMcpOptions {
  /** Project folder; created if missing. */
  dir: string;
  /** Override the firmware builder (tests). */
  builder?: Builder;
  /** Attach PNG screenshots as image content (default true; agents with vision can look at them). */
  images?: boolean;
  /** Use this session instead of creating one (jumper serve: every MCP client and the canvas share one). */
  session?: ProjectSession;
  /** How tool calls reach the session (jumper serve passes a queue so calls never interleave). */
  call?: (op: string, args: Record<string, unknown>, meta: CallMeta) => Promise<unknown>;
  /** Told before and after each tool call (the canvas shows "building · place_part led1"). */
  onToolStart?: (op: string, args: Record<string, unknown>) => void;
  onToolEnd?: (op: string, ok: boolean, result: unknown) => void;
  /** Extra text for the server instructions (e.g. "the human is watching at http://…"). */
  instructionsExtra?: string;
}

/** "claude-code" → "Claude Code": the name the canvas shows for an MCP client. */
export function prettyClientName(raw: string | undefined): string {
  const n = (raw ?? "").toLowerCase();
  if (!n) return "An agent";
  if (n.includes("claude-code") || n === "claude code") return "Claude Code";
  if (n.includes("claude-ai") || n.includes("claude desktop")) return "Claude Desktop";
  if (n.includes("codex")) return "Codex";
  if (n.includes("cursor")) return "Cursor";
  if (n.includes("vscode") || n.includes("visual studio code")) return "VS Code";
  if (n.includes("windsurf")) return "Windsurf";
  if (n.includes("zed")) return "Zed";
  if (n.includes("gemini")) return "Gemini CLI";
  if (n.includes("jumper")) return raw!;
  return raw!.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Resolve the project folder from --project <dir>, JUMPER_PROJECT, or the working directory. */
export function projectDirFromArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const i = argv.findIndex((a) => a === "--project" || a === "-p");
  const eq = argv.find((a) => a.startsWith("--project="));
  const dir = eq ? eq.slice("--project=".length) : i >= 0 ? argv[i + 1] : env.JUMPER_PROJECT;
  return resolve(dir ?? process.cwd());
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Turn an op result into MCP content: compact JSON, with ASCII screens and images split out. */
export function toContent(op: string, result: unknown, images: boolean): Content[] {
  const out: Content[] = [];
  if (result && typeof result === "object") {
    const r = { ...(result as Record<string, unknown>) };
    let screen: string | undefined;
    let file: string | undefined;
    if (typeof r.screen === "string") {
      screen = r.screen;
      delete r.screen;
    }
    if (op === "read_file" && typeof r.content === "string") {
      file = r.content;
      delete r.content;
    }
    out.push({ type: "text", text: JSON.stringify(r) });
    if (screen) out.push({ type: "text", text: screen });
    if (file !== undefined) out.push({ type: "text", text: file });
    if (op === "screenshot" && images && r.format === "png" && typeof r.path === "string" && existsSync(r.path)) {
      const buf = readFileSync(r.path);
      if (buf.length < 1_500_000) out.push({ type: "image", data: buf.toString("base64"), mimeType: "image/png" });
    }
    // round 6 case: design_case / update_case return their renders as image_files
    if (images && Array.isArray(r.image_files)) {
      for (const p of r.image_files.slice(0, 4)) {
        if (typeof p !== "string" || !existsSync(p)) continue;
        const buf = readFileSync(p);
        if (buf.length < 1_500_000) out.push({ type: "image", data: buf.toString("base64"), mimeType: "image/png" });
      }
    }
    if (op === "run_tests" && images && Array.isArray(r.frame_images)) {
      for (const p of r.frame_images.slice(0, 4)) {
        if (typeof p !== "string" || !existsSync(p)) continue;
        const buf = readFileSync(p);
        if (buf.length < 1_500_000) out.push({ type: "image", data: buf.toString("base64"), mimeType: "image/png" });
      }
    }
    return out;
  }
  return [{ type: "text", text: JSON.stringify(result) }];
}

export function createJumperMcpServer(opts: JumperMcpOptions): { server: Server; session: ProjectSession } {
  const dir = resolve(opts.dir);
  mkdirSync(dir, { recursive: true });
  const session = opts.session ?? new ProjectSession({ dir, actor: "mcp", ...(opts.builder ? { builder: opts.builder } : {}) });
  const images = opts.images ?? true;
  const call = opts.call ?? ((op: string, args: Record<string, unknown>, meta: CallMeta) => session.call(op, args, meta));
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: `${AGENT_LOOP}\n\nProject folder: ${dir}${session.exists ? "" : " (empty: start with new_project or place_part)"}.${opts.instructionsExtra ? `\n\n${opts.instructionsExtra}` : ""}`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: t.name === "remove" || t.name === "new_project" || t.name === "reject_step", idempotentHint: !!t.readOnly, openWorldHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const info = server.getClientVersion();
    const meta: CallMeta = { actor: "mcp", ...(info?.name ? { client: `${info.name}${info.version ? ` ${info.version}` : ""}` } : {}) };
    opts.onToolStart?.(name, args);
    try {
      const result = await call(name, args, meta);
      opts.onToolEnd?.(name, true, result);
      return { content: toContent(name, result, images) };
    } catch (err) {
      opts.onToolEnd?.(name, false, (err as Error).message);
      return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "jumper://docs/hardware", name: "Building a real device", description: "Jumper's hardware know-how: the design loop, rules of thumb, how the parts go inside (mounting, insertion order, wire room, access, battery safety) and how to answer what to buy, print and assemble.", mimeType: "text/markdown" },
      { uri: "jumper://docs/agents", name: "Jumper agent guide", description: "How to build and test a device with Jumper's tools, with a worked example.", mimeType: "text/markdown" },
      { uri: "jumper://parts", name: "Parts catalog", description: "Every part type with its pins, category and fidelity, one per line.", mimeType: "text/plain" },
      { uri: "jumper://project", name: "Current project (jumper.json)", description: "The project file as it is now.", mimeType: "application/json" },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri === "jumper://docs/hardware") {
      return { contents: [{ uri, mimeType: "text/markdown", text: renderGuide({ tools: TOOL_NAMES }) }] };
    }
    if (uri === "jumper://docs/agents") {
      const text = existsSync(DOCS_AGENTS) ? readFileSync(DOCS_AGENTS, "utf8") : AGENT_LOOP;
      return { contents: [{ uri, mimeType: "text/markdown", text }] };
    }
    if (uri === "jumper://parts") {
      const text = session.registry
        .list()
        .map((d) => `${d.spec.id} [${d.spec.category}, ${d.fidelity.level}] ${d.spec.name}: pins ${d.spec.pins.map((p) => p.id).join(" ")}`)
        .join("\n");
      return { contents: [{ uri, mimeType: "text/plain", text }] };
    }
    if (uri === "jumper://project") {
      session.sync();
      const text = existsSync(session.projectFile) ? readFileSync(session.projectFile, "utf8") : JSON.stringify(session.project, null, 2);
      return { contents: [{ uri, mimeType: "application/json", text }] };
    }
    throw new Error(`Unknown resource '${uri}'. Why: Jumper serves jumper://docs/hardware, jumper://docs/agents, jumper://parts and jumper://project. Fix: read one of those.`);
  });

  // Round 12 skill: the hardware know-how as prompts (design-device, build-kit, design-for-assembly).
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments.map((a) => ({ ...a })) })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const p = PROMPTS.find((x) => x.name === req.params.name);
    const text = renderPrompt(req.params.name, (req.params.arguments ?? {}) as Record<string, string>, { tools: TOOL_NAMES });
    return { ...(p ? { description: p.description } : {}), messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
  });

  return { server, session };
}

/** Start on stdio (what `jumper mcp` and bin/jumper-mcp.mjs do). Nothing but protocol goes to stdout. */
export async function startStdioServer(argv = process.argv.slice(2)): Promise<void> {
  const ai = argv.findIndex((a) => a === "--attach");
  const attach = argv.find((a) => a.startsWith("--attach="))?.slice("--attach=".length) ?? (ai >= 0 ? argv[ai + 1] : undefined) ?? process.env.JUMPER_ATTACH;
  if (attach) {
    const { startAttachedStdio } = await import("./attach.ts");
    await startAttachedStdio(attach);
    return;
  }
  const dir = projectDirFromArgs(argv);
  const { server, session } = createJumperMcpServer({ dir });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`jumper MCP server ready (project: ${dir})\n`);
  const shutdown = () => {
    session.dispose();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
