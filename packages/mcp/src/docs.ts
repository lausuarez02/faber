import { AGENT_LOOP, TOOLS } from "@jumper/session";

/** docs/mcp-tools.md, generated from the tool definitions (kept in sync by test/docs.test.ts). */
export function renderToolDocs(): string {
  const lines = [
    "# Jumper MCP tool reference",
    "",
    "<!-- Generated from packages/session/src/catalog.ts by `pnpm --filter @jumper/mcp gen:docs`. Do not edit by hand. -->",
    "",
    `${TOOLS.length} tools. The same operations are CLI subcommands (\`jumper <tool> --json\`) and run with the same rules. Setup and a worked example: [agents.md](agents.md).`,
    "",
    "## Recommended loop (sent as the server's instructions)",
    "",
    "```text",
    AGENT_LOOP,
    "```",
    "",
    "## Tools",
    "",
    "| Tool | What | Changes the project |",
    "| --- | --- | --- |",
    ...TOOLS.map((t) => `| [\`${t.name}\`](#${t.name.replace(/_/g, "_")}) | ${t.title} | ${t.edits ? "yes (undoable step)" : t.readOnly ? "no (read-only)" : "simulation only"} |`),
    "",
  ];
  for (const t of TOOLS) {
    lines.push(`### ${t.name}`, "", t.description, "");
    const props = Object.entries(t.inputSchema.properties);
    if (props.length) {
      lines.push("| Argument | Type | Required | Notes |", "| --- | --- | --- | --- |");
      for (const [name, raw] of props) {
        const p = raw as { type?: string | string[]; enum?: unknown[]; description?: string; items?: { type?: string } };
        const type = Array.isArray(p.type) ? p.type.join(" \\| ") : p.type === "array" ? `${p.items?.type ?? "any"}[]` : (p.type ?? "any");
        const notes = [p.enum ? `one of ${p.enum.map((e) => `\`${String(e)}\``).join(", ")}` : "", p.description ?? ""].filter(Boolean).join(". ");
        lines.push(`| \`${name}\` | ${type} | ${t.inputSchema.required?.includes(name) ? "yes" : ""} | ${notes.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
      }
      lines.push("");
    } else lines.push("No arguments.", "");
  }
  return lines.join("\n");
}
