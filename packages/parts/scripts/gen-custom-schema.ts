// Writes packages/parts/custom-part.schema.json (agent-made part.json, decision 0003 C4) from the zod schema.
// Run: pnpm --filter @faber/parts gen   (or `pnpm gen` at the root). --check: exit 1 when stale.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { customPartJsonSchema } from "../src/custom/schema.ts";

const out = fileURLToPath(new URL("../custom-part.schema.json", import.meta.url));
const text = JSON.stringify(customPartJsonSchema(), null, 2) + "\n";
if (process.argv.includes("--check")) {
  if ((existsSync(out) ? readFileSync(out, "utf8") : "") !== text) {
    console.error("gen-custom-schema: custom-part.schema.json is out of date; run `pnpm gen`");
    process.exit(1);
  }
  console.log("gen-custom-schema: up to date");
} else {
  writeFileSync(out, text);
  console.log(`gen-custom-schema: wrote ${out}`);
}
