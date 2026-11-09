// Writes docs/mcp-tools.md from the tool definitions. Run: pnpm --filter @jumper/mcp gen:docs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToolDocs } from "../src/docs.ts";

const out = fileURLToPath(new URL("../../../docs/mcp-tools.md", import.meta.url));
writeFileSync(out, renderToolDocs());
console.log(`wrote ${out}`);
