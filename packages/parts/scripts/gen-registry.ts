// Builds src/registry.gen.ts from the part folders in src/parts/<id>/.
// Each folder: part.json, fidelity.json, visual.svg, model.ts (exports `create: PartModelFactory`), model.test.ts.
// JSON and SVG are inlined so the registry works in the browser, Node tests and the CLI without bundler tricks.
// Every folder is validated first (see src/spec/validate.ts); any problem aborts without writing.
// Run: pnpm --filter @fabwright/parts gen   (or `pnpm gen` at the root). The output is committed.
//   --check   exit 1 if the committed file is stale instead of writing it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { REGISTRY_FILE, renderRegistry } from "./registry-codegen.ts";

const { code, problems, count } = renderRegistry();
if (problems.length) {
  console.error(`gen-registry: ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
if (process.argv.includes("--check")) {
  const current = existsSync(REGISTRY_FILE) ? readFileSync(REGISTRY_FILE, "utf8") : "";
  if (current !== code) {
    console.error("gen-registry: src/registry.gen.ts is out of date; run `pnpm gen`");
    process.exit(1);
  }
  console.log(`gen-registry: ${count} part(s), registry up to date`);
} else {
  writeFileSync(REGISTRY_FILE, code);
  console.log(`gen-registry: wrote ${count} part(s) to src/registry.gen.ts`);
}
