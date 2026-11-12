// Writes docs/mcp-tools.md from the tool definitions. Run: pnpm --filter @jumper/mcp gen:docs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAgentSkillFiles, renderToolDocs } from "../src/docs.ts";

const out = fileURLToPath(new URL("../../../docs/mcp-tools.md", import.meta.url));
writeFileSync(out, renderToolDocs());
console.log(`wrote ${out}`);

// Round 12 skill: the plugin's SKILL.md and docs/hardware-guide.md, from packages/agent-skill.
for (const [rel, text] of Object.entries(renderAgentSkillFiles())) {
  const abs = fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  console.log(`wrote ${abs}`);
}
