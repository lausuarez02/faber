// Writes packages/project-format/jumper.schema.json from the zod schema.
// Run: pnpm --filter @jumper/project-format gen:schema   (or `pnpm gen` at the root)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { projectJsonSchema } from "../src/jsonSchema.ts";

const out = fileURLToPath(new URL("../jumper.schema.json", import.meta.url));
writeFileSync(out, JSON.stringify(projectJsonSchema(), null, 2) + "\n");
console.log(`wrote ${out}`);
