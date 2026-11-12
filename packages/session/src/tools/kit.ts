import { relative } from "node:path";
import { fail } from "../errors.ts";
import { buildKit } from "../kit/index.ts";
import { writeKitFiles } from "../kit/files.ts";
import type { ToolModule } from "./types.ts";

/**
 * Round 12, track kit (owner): get_build_kit. Everything a person needs to build the device
 * themselves, for any project: what to buy (exact variant, store links per region, prices, totals
 * per store, the things people forget), what to print (material, colour, orientation, supports,
 * layer, infill, grams and time per STL, print-service notes), the tools and skill, the steps to
 * put it inside the case (wires with cut lengths and colours, cautions, checks), how to flash the
 * board, and troubleshooting from the project's own risks. Read-only on the project.
 */
export const kitTools: ToolModule = {
  name: "kit",
  tools: [
    {
      name: "get_build_kit",
      title: "Build kit",
      description:
        'Everything a person needs to build the device themselves, as one kit: shopping (every part with qty, the exact variant, store links for their region, unit and line prices, alternatives, and the things people forget: microSD card, the mating socket for a battery\'s JST lead, the USB data cable, wire / heat-shrink / solder / Kapton / foam tape, M2 screws and heat-set inserts, filament; totals per store and in all, with what they may already have kept apart), print (each STL with its measured size in mm (size_mm: width, depth, print height as it lies on the bed), material, colour, orientation, supports, layer height, infill, estimated grams and time, the 3MF plate, what to tell a print service like JLC3DP or Craftcloud), tools with skill level and time, numbered steps to put it together and inside the case (each with its picture, the wires with cut lengths, colours and gauge, cautions, and a check before going on), flashing for this board with exact commands and where the file is, connect for a device that reaches APIs (the API keys by name, the relay that holds them on a computer or Cloudflare Workers, one revocable token per device, Wi-Fi and the relay address on the device, what calls cost; relay/ is in the download), and troubleshooting from the project\'s own risks (design checks, case checks, what the simulation cannot check). Writes build-kit/<name>-kit/ (kit.html with pictures inside, kit.pdf when Chromium is installed, KIT.md, SHOPPING.csv / .md, PRINT-LIST.md, the case files, the firmware) and a zip unless write is false. Use it when the person asks what to buy, what to print, how to put it together, or "everything I need to build it"; tell them the totals and the time in plain words and give them kit.html (or the Build it panel in the app). Example: {} or {"region": "eu", "prefer": "AliExpress"}. Returns {summary, kit: {shopping, print, tools, steps, flash, connect?, troubleshooting, missing, check_first (circuit errors and warnings from the design check: tell the person before they buy)}, files: {dir, zip, html, pdf, markdown, csv}, next}. Read-only on the project; it does not rebuild the case or the firmware (missing[] says what is stale and how to fix it).',
      inputSchema: {
        type: "object",
        properties: {
          region: { type: "string", enum: ["global", "us", "eu", "uk"], description: 'Where the person shops (default "global"): Amazon search links go to that region\'s Amazon.' },
          prefer: { type: "string", description: 'A store to list first where a part has it, e.g. "AliExpress", "DigiKey", "Adafruit".' },
          slicer: { type: "string", enum: ["auto", "cached", "off"], description: 'Print estimates: "auto" (default) slices with PrusaSlicer when it is installed on this computer (else estimated from the meshes), "off" always estimates.' },
          write: { type: "boolean", description: "Default true: write the kit's files and zip. false returns only the data." },
          pdf: { type: "boolean", description: "Default true: also print kit.pdf (needs Playwright's Chromium)." },
        },
      },
      readOnly: true,
    },
  ],
  ops: {
    async get_build_kit(args, x) {
      const s = x.session;
      if (!s.project.parts.length) fail("empty-project", "Nothing to build yet", "the project has no parts", "plan_device {goal} and place the parts first, then get_build_kit");
      const region = (typeof args.region === "string" ? args.region : "global") as "global" | "us" | "eu" | "uk";
      const kit = await buildKit(s, { region, ...(typeof args.prefer === "string" ? { prefer: args.prefer } : {}), slicer: (args.slicer as "auto" | "cached" | "off") ?? "auto" });
      const files = args.write === false ? undefined : await writeKitFiles(s, kit, { pdf: args.pdf !== false });
      const missing = files?.missing ?? kit.missing;
      x.summary(`build kit: ${kit.shopping.lines.length} lines, $${kit.shopping.to_buy_usd.toFixed(2)} to buy, ${kit.print.items.length} prints, ${kit.steps.length} steps${missing.length ? `, ${missing.length} missing` : ""}`);
      return {
        summary: kit.summary,
        kit: { ...kit, missing },
        ...(files ? { files: { dir: files.dir, ...(files.zip ? { zip: files.zip, zip_bytes: files.zip_bytes } : {}), html: files.html, ...(files.pdf ? { pdf: files.pdf } : {}), markdown: files.markdown, csv: files.csv, count: files.files.length } } : {}),
        next: missing.length
          ? `Tell the person what is missing and fix it: ${missing.map((m) => m.fix).join("; ")}.`
          : `Give the person ${files ? relative(s.dir, files.html) : "the Build it panel (Case view > Build it)"}: tell them the total to buy ($${kit.shopping.to_buy_usd.toFixed(2)}), the print time and the build time in plain words, and that ticks in the page are remembered.${kit.connect?.needs_relay ? ` For the real device to reach its APIs, walk them through Connect: ${kit.connect.secrets.filter((x) => !x.set).length ? `put ${kit.connect.secrets.filter((x) => !x.set).map((x) => x.name).join(", ")} in .env, ` : ""}run or deploy the relay (relay/README.md), jumper relay token add <device>, jumper relay device-header, then build and flash from the sketch folder.` : ""}${kit.check_first.length ? ` Before they buy, tell them what the design check found (${kit.check_first.map((c) => c.problem).join("; ")}) and offer the fix: ${kit.check_first.map((c) => c.fix).join("; ")}` : ""}`,
      };
    },
  },
};
