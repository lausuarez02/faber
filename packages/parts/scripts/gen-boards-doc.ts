// Writes docs/boards.md from src/board-support.ts and the boards' part.json (name, availability).
// Run: pnpm --filter @faber/parts gen (or `pnpm gen` at the root). The output is committed.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BOARD_SUPPORT, boardSupportMarkdown } from "../src/board-support.ts";

const parts = fileURLToPath(new URL("../src/parts/", import.meta.url));
const out = fileURLToPath(new URL("../../../docs/boards.md", import.meta.url));
const names: Record<string, { name: string; availability?: { status: string; reason: string } }> = {};
for (const b of BOARD_SUPPORT) {
  const spec = JSON.parse(readFileSync(`${parts}${b.board}/part.json`, "utf8")) as { name: string; availability?: { status: string; reason: string } };
  names[b.board] = { name: spec.name, ...(spec.availability ? { availability: spec.availability } : {}) };
}
writeFileSync(out, boardSupportMarkdown(names));
console.log(`gen-boards-doc: wrote ${BOARD_SUPPORT.length} boards to docs/boards.md`);
