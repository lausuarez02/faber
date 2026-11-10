// Appends (or replaces) the "mechanical" and "sourcing" blocks at the END of each part.json,
// after "tags" (decision 0004, R1: they are the last keys). Never reformats the rest of the file.
// Usage: node packages/enclosure/scripts/append-mech.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA } from "./mech-data.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../parts/src/parts");
const fmt = (v, ind) => {
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    if (v.every((x) => typeof x !== "object")) return JSON.stringify(v);
    return "[\n" + v.map((x) => " ".repeat(ind + 2) + JSON.stringify(x).replace(/":/g, '": ').replace(/,"/g, ', "').replace(/^\{/, "{ ").replace(/\}$/, " }")).join(",\n") + "\n" + " ".repeat(ind) + "]";
  }
  if (v && typeof v === "object") return "{\n" + Object.entries(v).map(([k, x]) => " ".repeat(ind + 2) + JSON.stringify(k) + ": " + fmt(x, ind + 2)).join(",\n") + "\n" + " ".repeat(ind) + "}";
  return JSON.stringify(v);
};
let n = 0;
for (const [id, d] of Object.entries(DATA)) {
  const file = join(root, id, "part.json");
  let text = readFileSync(file, "utf8");
  const json = JSON.parse(text);
  // strip existing blocks written by this script (they are the last keys)
  const cut = text.search(/,\n  "(mechanical|sourcing)": /);
  if (cut >= 0) text = text.slice(0, cut) + "\n}\n";
  const keys = Object.keys(json).filter((k) => k !== "mechanical" && k !== "sourcing");
  if (keys[keys.length - 1] !== "tags") throw new Error(`${id}: last key is ${keys[keys.length - 1]}, expected tags`);
  const add = [d.mechanical ? `  "mechanical": ${fmt(d.mechanical, 2)}` : null, d.sourcing ? `  "sourcing": ${fmt(d.sourcing, 2)}` : null].filter(Boolean).join(",\n");
  text = text.replace(/\n\}\s*$/, `,\n${add}\n}\n`);
  JSON.parse(text);
  writeFileSync(file, text);
  n++;
}
console.log(`mechanical / sourcing written to ${n} parts`);
