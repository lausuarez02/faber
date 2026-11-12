import { factoryNetworkNotes, relayPack, relayUseful } from "@jumper/device-net";
import { networkConfigOf } from "../device-network.ts";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CASE_SHAPES, EnclosureSchema, type Enclosure, type Project } from "@jumper/project-format";
import type { CaseReport } from "@jumper/enclosure";
import { parseOutline as parseOutlineSync } from "@jumper/enclosure/outline";
import { hexToUf2 } from "@jumper/sim-backends";
import { fail } from "../errors.ts";
import { wiringMarkdown } from "../exporter.ts";
import { fidelityReport } from "../fidelity.ts";
import { wireCuts, wireCutsCsv } from "../assembly.ts"; // round 6: one wire-cut model (power track)
import { bomCsv, bomLines, bomMd, clearDir, copyTree, kicadNetlist, listFiles, netlistCsv, pinPositions, writeText, zipFolder } from "../manufacturing.ts";
import { sdCardFiles } from "../voice.ts"; // round 7 voice
import { projectSlug } from "../projects-registry.ts";
import { loadPlaywright } from "../screenshot.ts";
import type { ProjectSession } from "../session.ts";
import { listVersions } from "../versions.ts";
import type { ToolModule } from "./types.ts";

/**
 * Round 6, track "case" (owner). Decision 0004, R3 to R6.
 * design_case / update_case / get_case / export_manufacturing. The enclosure config lives in
 * jumper.json (an undoable edit); the generated files in <project>/case/ are outputs, never in the
 * undo history, regenerated whenever the hash of the config + the parts' mechanical data changes.
 */

const CANNOT = "What the case cannot check: snap strength and fit on your printer (print the two shells first and test), real tolerances of clone modules (about ±1 mm), drop / water / heat, the route of each wire.";

const autoNum = (min: number, max: number, d: string) => ({ anyOf: [{ type: "number", minimum: min, maximum: max }, { type: "string", enum: ["auto"] }], description: d });
const params = {
  type: "object",
  description: "Case parameters (all optional): wall_mm (≥ 1.2, default 1.6), corner_radius_mm (rounded-box / keychain, default 4), color ('#F2EDE4'), lanyard_hole (default true for keychain), belt_clip, closure ('snap' | 'screws' = M2 into heat-set inserts), tolerance_mm (default 0.2 FDM), process ('fdm' | 'resin' | 'injection'), gap_mm (wiring room around parts, default 1.5). 3D finish, any shape (number or \"auto\"): edge_radius_front_mm / edge_radius_back_mm (round-over of each rim), dome_mm / dome_back_mm (how far the faces bulge; leave auto, about 1 mm: every mm of dome is a mm of thickness per face, over 3 mm is warned), depth_mm (overall thickness). Leave the finish on auto unless the person asked for it.",
  properties: {
    wall_mm: { type: "number", minimum: 1.2, maximum: 5 },
    corner_radius_mm: { type: "number", minimum: 0, maximum: 30 },
    color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    lanyard_hole: { type: "boolean" },
    belt_clip: { type: "boolean" },
    closure: { type: "string", enum: ["snap", "screws"] },
    tolerance_mm: { type: "number", minimum: 0, maximum: 1 },
    process: { type: "string", enum: ["fdm", "resin", "injection"] },
    gap_mm: { type: "number", minimum: 0, maximum: 10 },
    edge_radius_front_mm: autoNum(0, 40, "Front rim round-over, mm."),
    edge_radius_back_mm: autoNum(0, 40, "Back rim round-over, mm."),
    dome_mm: autoNum(0, 15, "Front (and back) face bulge, mm. Leave auto (about 1 mm) unless the person asked: each mm adds a mm of thickness on each face."),
    dome_back_mm: autoNum(0, 15, "Back face bulge when it differs, mm."),
    depth_mm: autoNum(6, 120, "Overall thickness, mm (same as size_mm.d)."),
  },
};
const outlineArg = {
  description:
    'Shape "custom" only: the FRONT outline of the case in mm, drawn however you like. Either an SVG path string (M L H V C S Q T A Z, absolute or relative; y points DOWN like any SVG) e.g. an egg 56 x 73 mm: "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z", or {"points": [[x, y], ...], "smooth": true} with y UP (the top of the device is +y; smooth = a closed curve through the points). One closed shape that does not cross itself; sharp corners are rounded so they print. Only the proportions matter unless size_mm is given.',
  anyOf: [
    { type: "string" },
    { type: "object", properties: { points: { type: "array", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }, minItems: 3, maxItems: 400 }, smooth: { type: "boolean" } }, required: ["points"] },
  ],
};
const sizeArg = {
  type: "object",
  description: 'Fixed overall size in mm: {"w": 58, "h": 75, "d": 22} (any of them; the rest auto). The outline is scaled to w x h and the case is exactly that size; parts that do not fit come back as misses with smaller swaps instead of the case growing. Leave it out for auto (the smallest that holds the parts).',
  properties: { w: { type: "number", minimum: 15, maximum: 250 }, h: { type: "number", minimum: 15, maximum: 250 }, d: { type: "number", minimum: 6, maximum: 120 } },
};
const placements = {
  type: "object",
  description: 'Only for what the person asked for (Jumper places every part by itself; each pin can cost many mm: read costs). Per part id, where it goes: {"pet": {"face": "right", "y_mm": 4}, "bat": {"face": "inside"}, "xiao": {"on_edge": true}}. face: front | back | left | right | top | bottom (as seen holding it, screen towards you) or inside (no opening); x_mm / y_mm from the centre of that face (+x right, +y up looking straight at it); rotation 0 / 90 / 180 / 270; on_edge: stand the board on its edge (narrower, thicker). Parts left out are auto-packed (screen front, USB bottom, buttons on the sides, buzzer / speaker grille at the back; a speaker that should talk through the front: {"spk": {"face": "front"}}).',
  additionalProperties: true,
};
const why = { type: "string", description: "Short reason shown in the step list." };
const layoutArg = {
  type: "string",
  enum: ["auto", "thinnest", "smallest", "balanced"],
  description:
    'How the parts are distributed inside (round 8). Jumper works it out automatically: it lays the parts out flat first (side by side, one layer), then in two or three layers, inside the real outline, and proposes three layouts: "thinnest" (fewest layers), "smallest" (least volume), "balanced" (pocket-friendly: thickness over 18 mm and a footprint over 110 x 70 mm weigh up). "auto" (default) = balanced. See them first with propose_layout. Pin a part with placements ({"bat": {"x_mm": 0, "y_mm": -20}} or {"layer": 1}) and the rest is arranged around it.',
};

export const caseTools: ToolModule = {
  name: "case",
  tools: [
    {
      name: "design_case",
      title: "Design a printable case",
      description: `Pack the project's parts into a two-part printable case and write everything needed to make it into <project>/case/: STL per body in print orientation (front, back, button plungers, light pipes), case.3mf (a coloured build plate for slicers), STEP (assembly with the parts as named solids, front, back: what factories ask for), renders (front / back / exploded / inside), an A3 drawing (SVG, PDF when Chromium is installed) with sizes, hole positions, tolerances, material and print settings, and PRINT.md. Shapes: "rounded-box", "pill", "pebble" (organic oval), "puck" (round), "keychain" (tab with a lanyard hole) are starting points; "custom" is ANY outline you draw (an egg, a heart, a bean, a guitar pick ...) with outline, at any size with size_mm: Jumper packs the parts inside that real outline (a narrow end holds less) and, when they do not fit a fixed size, says what misses by how much and which smaller parts would fit (fits: false, misses, suggestions; nothing is saved). Check a fit first in under a second with check_fit (or dry_run: true). Before it: propose_layout (how the parts go inside) and read its costs. Do not pin positions (placements) unless the person asked; leave dome_mm and the edges on auto; a pocket or hand-held device should be 20 mm thick or less. Example: {"shape": "pebble"} or {"shape": "custom", "outline": "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z"} or {"shape": "puck", "params": {"closure": "screws", "color": "#2B3038"}, "placements": {"pet": {"face": "left"}}}. Returns the CaseReport: size_mm (e.g. 70.7 x 94.3 x 19.6), inner_mm, pocket (thickness first: "fits" = comfortable, ≤ 18 mm thick within 110 x 70 mm; "tight" ≤ 22 mm; "no" = bulky), volume_cm3, ok, checks (fits, screen-window, buttons-reachable, connector-access, min-wall, printable, watertight, no-intersection, size-match), files, costs (what each of your choices adds: pins, faces, dome, edges, a fixed size, wall, each with the update_case call that relaxes it, the costliest first, and relax_all), plus the front and exploded renders inline. save: false writes to case/variants/<shape>/ and leaves jumper.json alone (compare shapes). Takes 3 to 30 s (real CAD; a pebble with domed faces is the slowest). ${CANNOT}`,
      inputSchema: {
        type: "object",
        properties: {
          shape: { type: "string", enum: [...CASE_SHAPES] },
          outline: outlineArg,
          size_mm: sizeArg,
          params,
          front: { type: "string", description: "Part id whose screen faces out of the front (default: the first display)." },
          placements,
          exclude: { type: "array", items: { type: "string" }, description: "Part ids that are not inside the case." },
          layout: layoutArg,
          dry_run: { type: "boolean", description: "true: only test the fit (no CAD, nothing written, under a second): the same answer as check_fit." },
          save: { type: "boolean", description: "Default true: store the case in jumper.json (undoable) and write case/. false: write case/variants/<shape>/ only." },
          images: { type: "boolean", description: "Default true: return the front and exploded renders inline." },
          costs: { type: "boolean", description: "Default true: add costs (what each of your choices adds to the size), a few seconds after the CAD." },
          why,
        },
        required: ["shape"],
      },
      edits: true,
    },
    {
      name: "update_case",
      title: "Change the case",
      description: `Change the existing case: any of shape, outline, size_mm, params, front, placements, exclude. params, size_mm and placements are merged into what is there; a placement or a size value set to null is removed (back to auto). Example: {"params": {"wall_mm": 2, "closure": "screws"}} or {"placements": {"pet": {"face": "top"}}} or {"shape": "puck"} or {"size_mm": {"w": 64, "h": 84}} or {"outline": {"points": [[0, 40], [24, 16], [28, -4], [13, -32], [-13, -32], [-28, -4], [-24, 16]], "smooth": true}}. Regenerates every file in case/ and returns the CaseReport like design_case (with costs) (or fits: false with misses and suggestions when a fixed size cannot hold the parts; nothing changes then). Fails when there is no case yet (use design_case). ${CANNOT}`,
      inputSchema: {
        type: "object",
        properties: { shape: { type: "string", enum: [...CASE_SHAPES] }, outline: outlineArg, size_mm: { ...sizeArg, additionalProperties: true }, params, front: { type: "string" }, placements, exclude: { type: "array", items: { type: "string" } }, layout: layoutArg, images: { type: "boolean" }, costs: { type: "boolean", description: "Default true: add costs (what each of your choices adds to the size), a few seconds after the CAD." }, why },
      },
      edits: true,
    },
    {
      name: "check_fit",
      title: "Test a case fit",
      description:
        'Test whether the project\'s parts fit a case WITHOUT making it (no CAD, nothing written, answers in under a second): any preset or a custom outline, any size. Takes the same arguments as design_case (shape, outline, size_mm, params, placements, exclude, front); with none it tests the saved case. Returns {fits, size_mm (as laid out), needed_mm (what the parts need), asked_mm, misses: [{part, type, dimension: "outline" | "depth", short_mm, where, message}], suggestions: [{kind: "swap" | "smaller-cell" | "on-edge" | "bigger", part, from, to, message, change: [{tool, args}], fits, size_mm, tradeoff}], issues, costs: {base, costs: [{id, choice, with, without, adds_mm, adds_cm3, breaks_fit, message, change}], relax_all, sizes_that_work (a fixed size: the sizes this outline works at, flat and stacked; use one instead of guessing)}, ms}. Relax the costly choices unless the person asked for them. Each suggestion is tried with the same quick layout while about a second lasts (fits says whether it then fits the asked size; untried ones have no fits; try_suggestions: true tries them all, a few seconds). Use it to rethink the pieces before design_case: e.g. {"shape": "custom", "outline": "<egg path>", "size_mm": {"w": 58, "h": 75, "d": 20}}. preview: true adds the front-view geometry (outline, cavity, part footprints with collides) for drawing it.',
      inputSchema: {
        type: "object",
        properties: { shape: { type: "string", enum: [...CASE_SHAPES] }, outline: outlineArg, size_mm: sizeArg, params, front: { type: "string" }, placements, exclude: { type: "array", items: { type: "string" } }, layout: layoutArg, preview: { type: "boolean", description: "Add the front-view geometry (default false)." }, costs: { type: "boolean", description: "Default true: add costs, what each of your choices (pins, faces, dome, edges, a fixed size, wall) adds to the size, a few seconds." }, try_suggestions: { type: "boolean", description: "Try every suggestion (a few seconds) instead of the ones that fit in about a second (default false)." } },
      },
      readOnly: true,
    },
    {
      name: "propose_layout",
      title: "Propose how the parts are distributed",
      description:
        'Work out, automatically, the best ways to distribute the project\'s parts inside a case of ANY outline and size (no CAD, nothing written, about 1 to 2 s): Jumper lays the parts out flat first (every part side by side in one layer inside the real outline, rotated 0 / 90, a board on its edge where it helps), then in two or three layers (e.g. the cell behind the screen), keeping the screen behind its window, the speaker grille on its face, each USB port / button / switch reaching its wall, the cell flat, wiring room between parts and the rim round-over at each part\'s depth (heavy parts low in an upright outline). Returns {proposals: [{id: "thinnest" | "smallest" | "balanced", label, size_mm, volume_cm3, pocket, fill_ratio, layers: [{index, z_mm, parts}], placements: {part: {x_mm, y_mm, z_mm, rot, on_edge, layer, face}}, why: [reasons in plain words], misses, warnings, source}], best, chosen, parts_volume_cm3, ms}. Same arguments as check_fit (with none it uses the saved case). Also costs: what each of your choices (a pinned part, a face, the dome, edges, a fixed size, wall) adds in thickness / size / volume, measured by proposing again without it, each with the update_case call that relaxes it, and relax_all. Call it before design_case; relax the costly choices unless the person asked for them; a pocket or hand-held device should be 20 mm thick or less. Then make the one you want with design_case / update_case {layout: "<id>"}; pin a part only where the person asked for it (the rest is arranged around it). views: true adds front and side views (outline + part rectangles per layer) for drawing them. Deterministic: the same project gives the same proposals.',
      inputSchema: {
        type: "object",
        properties: { shape: { type: "string", enum: [...CASE_SHAPES] }, outline: outlineArg, size_mm: sizeArg, params, front: { type: "string" }, placements, exclude: { type: "array", items: { type: "string" } }, layout: layoutArg, views: { type: "boolean", description: "Add the front and side views per proposal (default false)." }, costs: { type: "boolean", description: "Default true: add costs, what each of your choices (pins, faces, dome, edges, a fixed size, wall) adds to the size, a few seconds." } },
      },
      readOnly: true,
    },
    {
      name: "get_case",
      title: "Case report",
      description: "The current case's CaseReport (sizes, pocket verdict, checks, files). If a part, the wiring of the case config or an undo changed things since the files were written, it regenerates them first (stale: true in the answer). Does not change jumper.json. Fails when there is no case yet.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    },
    {
      name: "get_assembly_plan",
      title: "How to build it",
      description:
        'How to build the real device, worked out by Jumper at design time for this case (any shape): everything to BUY (parts with MPNs, wire by gauge and length, screws, inserts, Kapton, foam), everything to PRINT (each STL with the face that goes on the bed), the consumables and tools, and the ASSEMBLY STEPS in an order that is physically possible: which shell each part goes into and in what order (a part another covers goes in first; a switch whose lever pokes through its hole slides in before what would block it; plungers before the parts behind them), when each wire is soldered (as soon as both of its parts are in; pads a later part covers get their lead on the bench first; wires between the two shells with the case open like a book, cut long enough for it), the battery last and insulated, a power-on test before closing, the closure, a closed test. Each step: {n, title, say (plain words for the person), shell, parts, action (place | press-fit | screw | glue | solder | tape | route-wire | close | flash | test), fasteners, wires [{id, from, to, length_mm, gauge, color}], tools, cautions, view {explode, highlight, camera}, image (a picture of that step)}. Also how each part is held (mounts: the case adds seat posts, hold-downs, backstops, guides, cell corners and strap slots where they fit) and the design-for-assembly checks (assembly-close, assembly-insert, assembly-solder, assembly-wires, assembly-access, assembly-battery, assembly-screws, assembly-held), each with what failed, why, the fix and the sizes. Regenerates the case first when it is stale. Example: {} or {"images": true} (attach the step pictures). Use it when the person asks what to buy, what to print or how to put it together; show them the steps and pictures in plain words. Fails when there is no case yet (design_case first).',
      inputSchema: { type: "object", properties: { images: { type: "boolean", description: "Attach the step pictures inline (the first four; every step has its path in image). Default false." } } },
      readOnly: true,
    },
    {
      name: "export_manufacturing",
      title: "Factory pack",
      description: 'Write the factory pack to <project>/manufacturing/<name>-v<version>/ and zip it: README.md for the supplier (what it is, how to build, flash and test), README.zh-CN.md (short summary), NOTES.md (honest limits: no PCB layout yet, hand-wired / perfboard; what was only simulated; what to verify on a real unit), BOM.csv (line, refs, qty, name, mpn, manufacturer, lcsc, jlc, package, generic, unit_usd, ext_usd, buy_url, source, notes) + BOM.md, electronics/ (WIRING.md, netlist.csv, jumper.net KiCad netlist, WIRE-CUTS.csv), firmware/ (firmware.hex, firmware.uf2 for RP2040, firmware.bin for ESP32 boards built for the real board, FLASHING.md, source/), enclosure/ (the case files), assembly/ASSEMBLY.md (numbered steps with the renders), test/ (TEST-PLAN.md from the scenarios, TEST-ON-HARDWARE.md), build-kit/ (the person-facing build kit, as get_build_kit: kit.html, KIT.md, SHOPPING.csv / .md, PRINT-LIST.md), manifest.json (sha256 per file). Example: {} or {"zh_cn": false}. Returns {dir, zip, files, missing: [{item, why, fix}], notes, next}. Build the firmware and design_case first for a complete pack (missing[] says what is absent).',
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: 'Folder inside the project (default "manufacturing").' },
          zip: { type: "boolean", description: "Default true: also write <name>-v<version>.zip next to the folder." },
          zh_cn: { type: "boolean", description: "Default true: add README.zh-CN.md." },
          why,
        },
      },
    },
  ],
  ops: {
    async design_case(args, x) {
      const s = x.session;
      const enc = validateEnclosure(s, encFromArgs(args));
      if (args.dry_run === true) {
        const r = await fitReport(s, enc, { preview: false });
        x.summary(`fit ${enc.shape}: ${r.fits ? "fits" : `${r.misses.length} miss(es)`} (${r.ms} ms)`);
        return r;
      }
      const save = args.save !== false;
      // a fixed size that cannot hold the parts: say what misses and what would fit, change nothing
      const miss = await fixedSizeMiss(s, enc);
      if (miss) {
        x.summary(`case ${enc.shape}: does not fit the asked size (${miss.misses.length} miss(es)), nothing saved`);
        return miss;
      }
      if (!save) {
        const out = await generateInto(s, { ...s.project, enclosure: enc }, join(s.dir, "case", "variants", enc.shape));
        x.summary(`case variant ${enc.shape}: ${fmtSize(out.report)} (${out.report.pocket})`);
        return answer(s, out, args.images !== false, `case/variants/${enc.shape}`, "Compare with get_case; make it the case with design_case {\"shape\": \"" + enc.shape + "\"} (save defaults to true).");
      }
      const step = x.commit(`design_case ${enc.shape}`, { ...s.project, enclosure: enc });
      const out = await generateInto(s, s.project, join(s.dir, "case"));
      const costs = args.costs === false ? undefined : await caseCosts(s, enc, 10000);
      x.summary(`case: ${enc.shape} ${fmtSize(out.report)}, ${out.report.ok ? "all checks ok" : `${out.report.checks.filter((c) => !c.ok && c.severity === "error").length} problem(s)`}`);
      return { step: step.id, ...answer(s, out, args.images !== false, "case", nextAfter(out.report) + costsNext(costs)), ...(costs ? { costs } : {}) };
    },
    async update_case(args, x) {
      const s = x.session;
      const cur = s.project.enclosure;
      if (!cur) fail("no-case", "No case yet", "update_case changes an existing case and this project has none (jumper.json has no enclosure)", 'design_case {"shape": "pebble"}');
      const merged: Record<string, unknown> = { ...cur };
      if (args.shape) merged.shape = args.shape;
      if (args.outline !== undefined) merged.outline = args.outline;
      if (args.shape && args.shape !== "custom" && args.outline === undefined) delete merged.outline;
      if (args.size_mm !== undefined) {
        const sz = args.size_mm === null ? {} : { ...(cur.size_mm ?? {}), ...(args.size_mm as object) };
        for (const [k, v] of Object.entries(sz)) if (v === null) delete (sz as Record<string, unknown>)[k];
        if (Object.keys(sz).length) merged.size_mm = sz;
        else delete merged.size_mm;
      }
      if (args.params) merged.params = { ...(cur.params ?? {}), ...(args.params as object) };
      if (args.front !== undefined) merged.front = args.front;
      if (args.exclude !== undefined) merged.exclude = args.exclude;
      if (args.layout !== undefined) {
        if (args.layout === null || args.layout === "auto") delete merged.layout;
        else merged.layout = args.layout;
      }
      if (args.placements) {
        const pl: Record<string, unknown> = { ...(cur.placements ?? {}) };
        for (const [k, v] of Object.entries(args.placements as Record<string, unknown>)) {
          if (v === null) delete pl[k];
          else {
            // a field set to null inside a part's placement is removed (unpin x_mm / y_mm, back to auto)
            const one: Record<string, unknown> = { ...((pl[k] as object) ?? {}), ...(v as object) };
            for (const [f, fv] of Object.entries(one)) if (fv === null) delete one[f];
            if (Object.keys(one).length) pl[k] = one;
            else delete pl[k];
          }
        }
        merged.placements = pl;
      }
      const enc = validateEnclosure(s, merged);
      const miss = await fixedSizeMiss(s, enc);
      if (miss) {
        x.summary(`case ${enc.shape}: does not fit the asked size (${miss.misses.length} miss(es)), nothing changed`);
        return miss;
      }
      const step = x.commit(`update_case`, { ...s.project, enclosure: enc });
      const out = await generateInto(s, s.project, join(s.dir, "case"));
      const costs = args.costs === false ? undefined : await caseCosts(s, enc, 10000);
      x.summary(`case: ${enc.shape} ${fmtSize(out.report)}, ${out.report.ok ? "all checks ok" : "has problems"}`);
      return { step: step.id, ...answer(s, out, args.images !== false, "case", nextAfter(out.report) + costsNext(costs)), ...(costs ? { costs } : {}) };
    },
    async check_fit(args, x) {
      const s = x.session;
      const has = args.shape !== undefined || args.outline !== undefined || args.size_mm !== undefined;
      if (!has && !s.project.enclosure) fail("no-case", "Nothing to test", "check_fit with no shape tests the saved case, and this project has none", 'pass a shape, e.g. {"shape": "custom", "outline": "M 0 -40 C ... Z", "size_mm": {"w": 58, "h": 75}}');
      const enc = has ? validateEnclosure(s, { ...(s.project.enclosure && !args.shape ? s.project.enclosure : {}), ...encFromArgs(args, s.project.enclosure?.shape) }) : s.project.enclosure!;
      const r0 = await fitReport(s, enc, { preview: args.preview === true, ...(args.try_suggestions === true ? { budgetMs: 10_000 } : {}) });
      const costs = args.costs === false ? undefined : await caseCosts(s, enc, 5000);
      const r = { ...r0, ...(costs ? { costs, next: r0.next + costsNext(costs) } : {}) };
      x.summary(`fit ${enc.shape}: ${r.fits ? `fits, ${r.size_mm.w} x ${r.size_mm.h} x ${r.size_mm.d} mm` : `${r.misses.length} miss(es), ${r.suggestions.length} suggestion(s)`} (${r.ms} ms)`);
      return r;
    },
    async propose_layout(args, x) {
      const s = x.session;
      const r = await layoutProposals(s, args, { views: args.views === true, costs: args.costs !== false });
      x.summary(`layouts: ${r.proposals.map((p) => `${p.id} ${p.size_mm.w} x ${p.size_mm.h} x ${p.size_mm.d}`).join(", ")} (${r.ms} ms)`);
      return r;
    },
    async get_case(_args, x) {
      const s = x.session;
      if (!s.project.enclosure) fail("no-case", "No case yet", "this project has no enclosure in jumper.json", 'design_case {"shape": "pebble"}');
      const st = await caseState(s);
      x.summary(`case: ${st.report.shape} ${fmtSize(st.report)}${st.regenerated ? " (regenerated)" : ""}`);
      return { ...compact(st.report), dir: join(s.dir, "case"), stale: st.regenerated, files: st.report.files.map((f) => f.path) };
    },
    async get_assembly_plan(args, x) {
      const r = await assemblyPlanFor(x.session);
      x.summary(`assembly plan: ${r.steps.length} steps, ${r.print.length} pieces to print, ${r.buy.length} lines to buy${r.problems.length ? `, ${r.problems.length} problem(s)` : ""}`);
      const imgs = r.steps.flatMap((st) => (st.image_file ? [st.image_file] : []));
      // (the most telling pictures first: a part going in, the case open like a book, closing)
      const pick = [r.steps.find((st) => st.view.camera.endsWith("-shell") && st.action !== "solder"), r.steps.find((st) => st.view.camera === "open-book"), r.steps.find((st) => st.action === "close" || st.action === "screw")].flatMap((st) => (st?.image_file ? [st.image_file] : []));
      return { ...r, ...(args.images === true ? { image_files: [...new Set([...pick, ...imgs])] } : {}) };
    },
    async export_manufacturing(args, x) {
      const res = await exportManufacturing(x.session, { ...(typeof args.dir === "string" ? { dir: args.dir } : {}), zip: args.zip !== false, zh_cn: args.zh_cn !== false });
      x.summary(`factory pack: ${relative(x.session.dir, res.dir)} (${res.files.length} files${res.missing.length ? `, ${res.missing.length} missing` : ""})`);
      return res;
    },
  },
};

/** The enclosure fields of a design_case / check_fit call. */
function encFromArgs(args: Record<string, unknown>, fallbackShape?: string): Record<string, unknown> {
  return {
    shape: args.shape ?? (args.outline !== undefined ? "custom" : fallbackShape),
    ...(args.outline !== undefined ? { outline: args.outline } : {}),
    ...(args.size_mm ? { size_mm: stripNulls(args.size_mm as Record<string, unknown>) } : {}),
    ...(args.params ? { params: args.params } : {}),
    ...(args.front ? { front: args.front } : {}),
    ...(args.placements ? { placements: stripNulls(args.placements as Record<string, unknown>) } : {}),
    ...(args.exclude ? { exclude: args.exclude } : {}),
    ...(args.layout ? { layout: args.layout } : {}),
  };
}

/**
 * Round 8: the layouts Jumper proposes for an enclosure (propose_layout, POST /api/case/layouts):
 * thinnest, smallest and balanced, each a finished layout, and which one the case uses.
 */
export async function layoutProposals(s: ProjectSession, args: Record<string, unknown>, opts: { views?: boolean; costs?: boolean; costsBudgetMs?: number } = {}) {
  const has = args.shape !== undefined || args.outline !== undefined || args.size_mm !== undefined;
  if (!has && !s.project.enclosure) fail("no-case", "Nothing to lay out", "propose_layout with no shape uses the saved case, and this project has none", 'pass a shape, e.g. {"shape": "pebble"} or {"shape": "custom", "outline": "M 0 -40 C ... Z"}');
  const base = s.project.enclosure && !args.shape ? s.project.enclosure : undefined;
  const enc = has || args.placements || args.params || args.layout || args.exclude || args.front ? validateEnclosure(s, { ...(base ?? {}), ...encFromArgs(args, s.project.enclosure?.shape) }) : s.project.enclosure!;
  const { layoutInput, proposalsFor, layoutCase } = await import("@jumper/enclosure");
  const input = layoutInput({ ...s.project, enclosure: enc }, (t) => s.registry.get(t)?.spec);
  if (!input.parts.length) fail("no-parts", "No parts to lay out", "the project has no parts with a case footprint", "place parts first (place_part)");
  let L;
  let P;
  try {
    L = layoutCase(input);
    P = proposalsFor(input);
  } catch (e) {
    rethrowOutline(e);
  }
  const chosen = L.proposal?.id ?? P.best;
  const costs = opts.costs === false ? undefined : await caseCosts(s, enc, opts.costsBudgetMs ?? 10000);
  return {
    ...P,
    chosen,
    proposals: P.proposals.map(({ views, ...rest }) => (opts.views ? { ...rest, views } : rest)),
    ...(costs ? { costs } : {}),
    next: `The case uses "${chosen}"${enc.layout && enc.layout !== "auto" ? "" : " (layout auto)"}. Make another one with design_case / update_case {"layout": "<id>"}; pin a part only where the person asked for it.${costsNext(costs)}`,
  };
}

/**
 * Round 8b: what each choice in the case costs (pins, faces, dome, edges, a fixed size, wall,
 * closure): the quick search again with that one choice relaxed, and with all of them relaxed.
 * Time-boxed; undefined when there is nothing to relax.
 */
export async function caseCosts(s: ProjectSession, enc: Enclosure, budgetMs = 10000) {
  const { choiceCostsAsync, choicesOf, layoutInput } = await import("@jumper/enclosure");
  const input = layoutInput({ ...s.project, enclosure: enc }, (t) => s.registry.get(t)?.spec);
  if (!input.parts.length || !choicesOf(input).length) return undefined;
  // (JUMPER_COSTS_BUDGET_MS: a fixed budget, e.g. for tests on a loaded machine)
  const env = Number(process.env.JUMPER_COSTS_BUDGET_MS);
  try {
    // (giving way between the searches: a server keeps answering while it weighs them)
    return await choiceCostsAsync(input, { budgetMs: Number.isFinite(env) && env > 0 ? env : budgetMs });
  } catch (e) {
    rethrowOutline(e);
  }
}

/** One line for an answer's next: the costliest choice and its fix, when one costs something. */
function costsNext(c: Awaited<ReturnType<typeof caseCosts>>): string {
  if (!c) return "";
  const top = c.costs[0];
  if (!top && !c.relax_all) return "";
  return ` What makes it bigger (costs): ${top ? top.message : c.relax_all!.message}${c.costs.length > 1 ? ` (${c.costs.length - 1} more in costs)` : ""} Relax the costly choices unless the person asked for them.`;
}

/** The quick fit report (check_fit, dry_run, the Case view's preview) for an enclosure. */
export async function fitReport(s: ProjectSession, enc: Enclosure, opts: { preview?: boolean; layout?: import("@jumper/enclosure").Layout; budgetMs?: number } = {}) {
  const { checkFit, layoutInput } = await import("@jumper/enclosure");
  const input = layoutInput({ ...s.project, enclosure: enc }, (t) => s.registry.get(t)?.spec);
  let r;
  try {
    r = checkFit({ ...input, catalog: s.registry.list().map((d) => d.spec) }, { ...(opts.layout ? { layout: opts.layout } : {}), ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}), ...(opts.preview ? { views: true } : {}) });
  } catch (e) {
    rethrowOutline(e);
  }
  const { preview, ...rest } = r;
  const next = r.fits
    ? `It fits (${r.size_mm.w} x ${r.size_mm.h} x ${r.size_mm.d} mm). Make it with design_case and the same arguments.`
    : `It does not fit. Pick a suggestion (each change is listed as tool calls; fits says whether it then fits), or change size_mm / the outline, then check_fit again.`;
  return { ...rest, ...(opts.preview ? { preview } : {}), next };
}

/** The Case view's live preview (POST /api/case/fit): validate the draft enclosure and test it, nothing logged or written. */
export async function previewFit(s: ProjectSession, body: Record<string, unknown>) {
  const enc = validateEnclosure(s, encFromArgs(body, s.project.enclosure?.shape));
  return fitReport(s, enc, { preview: true });
}

/** The Case view's "What's making it bigger" (POST /api/case/costs): the costs of a draft enclosure, or of the saved case. */
export async function draftCosts(s: ProjectSession, body: Record<string, unknown>) {
  const has = body.shape !== undefined || body.outline !== undefined || body.size_mm !== undefined;
  if (!has && !s.project.enclosure) fail("no-case", "Nothing to weigh", "there is no case yet and the request names no shape", 'send {} once the case exists, or {"shape": "pebble"}');
  const base = s.project.enclosure && !body.shape ? s.project.enclosure : undefined;
  const enc = has || body.placements || body.params || body.layout || body.exclude || body.front ? validateEnclosure(s, { ...(base ?? {}), ...encFromArgs(body, s.project.enclosure?.shape) }) : s.project.enclosure!;
  const c = await caseCosts(s, enc, typeof body.budget_ms === "number" ? Math.min(15000, Math.max(1000, body.budget_ms)) : 8000);
  return c ?? { base: undefined, costs: [], free: [], skipped: [], ms: 0 };
}

/** A fixed size (size_mm / depth_mm) that the parts do not fit: the fit report, nothing saved. Undefined when it fits or the size is auto. */
async function fixedSizeMiss(s: ProjectSession, enc: Enclosure) {
  const fixed = enc.size_mm && Object.keys(enc.size_mm).length ? true : typeof enc.params?.depth_mm === "number";
  if (!fixed) return undefined;
  const { layoutCase, layoutInput } = await import("@jumper/enclosure");
  let L;
  try {
    L = layoutCase(layoutInput({ ...s.project, enclosure: enc }, (t) => s.registry.get(t)?.spec));
  } catch (e) {
    rethrowOutline(e);
  }
  if (!L.fit || L.fit.fits) return undefined;
  // design_case waits for CAD anyway: every suggestion is tried here
  const r = await fitReport(s, enc, { layout: L, budgetMs: 6000 });
  // round 8b: the sizes this outline works at (flat and stacked) and the choices that make it miss
  const costs = await caseCosts(s, enc, 6000);
  const sizes = costs?.sizes_that_work ?? [];
  const sizesText = sizes.length ? ` Sizes this outline works at: ${sizes.map((z) => `${z.label} ${z.size_mm.w} x ${z.size_mm.h} x ${z.size_mm.d} mm (size_mm {"w": ${z.size_mm.w}, "h": ${z.size_mm.h}})`).join("; ")}.` : "";
  const breaker = costs?.costs.find((c) => c.breaks_fit);
  return { saved: false, ...r, ...(costs ? { costs } : {}), ...(sizes.length ? { sizes_that_work: sizes } : {}), next: `Nothing was saved: the parts do not fit ${fmtAsked(r.asked_mm)}.${breaker ? ` ${breaker.message}` : ""}${sizesText} ${r.suggestions.length ? `Or: ${r.suggestions.slice(0, 3).map((x) => x.message).join(" ")}` : "Or leave a part outside (exclude)."} Then design_case again (check_fit tests each idea in under a second; do not guess sizes).` };
}

function fmtAsked(a?: { w?: number; h?: number; d?: number }): string {
  if (!a) return "the asked size";
  return `${a.w ?? "auto"} x ${a.h ?? "auto"} x ${a.d ?? "auto"} mm`;
}

function rethrowOutline(e: unknown): never {
  const o = e as { name?: string; what?: string; why?: string; fix?: string };
  if (o?.name === "OutlineError") fail("bad-outline", o.what!, o.why!, o.fix!);
  throw e;
}

function stripNulls(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
}

function validateEnclosure(s: ProjectSession, raw: Record<string, unknown>): Enclosure {
  if (!raw.shape || !CASE_SHAPES.includes(raw.shape as never)) fail("bad-arg", `Unknown case shape ${JSON.stringify(raw.shape)}`, `shapes are ${CASE_SHAPES.join(", ")} ("custom" = any outline you draw: there is no preset per object, so an egg or a heart is a custom outline)`, `pass one of them, e.g. {"shape": "pebble"} or {"shape": "custom", "outline": "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z"}`);
  if (raw.shape === "custom" && raw.outline === undefined) fail("bad-outline", 'Shape "custom" needs an outline', "a custom case is the front outline you draw, and none was given", 'pass outline: an SVG path in mm ("M 0 -40 C ... Z", y down) or {"points": [[x, y], ...], "smooth": true} (y up)');
  if (raw.shape !== "custom" && raw.outline !== undefined) fail("bad-outline", `An outline was given with shape "${String(raw.shape)}"`, "only shape \"custom\" uses an outline (the presets have their own)", 'pass shape "custom" with the outline, or leave the outline out');
  const r = EnclosureSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    const path = i.path.join(".");
    fail("bad-arg", `The case setting ${path || "(root)"} is not valid`, i.message, path.endsWith("wall_mm") ? "wall_mm must be at least 1.2 (FDM) and at most 5" : path.startsWith("size_mm") ? "size_mm.w and .h are 15 to 250 mm and .d is 6 to 120 mm (leave one out for auto)" : path.startsWith("outline") ? "outline is an SVG path string or {\"points\": [[x, y], ...], \"smooth\": true} with 3 to 400 points" : `check ${path} against design_case's input schema (get it with jumper tools --json)`);
  }
  const enc = r.data;
  if (enc.shape === "custom") {
    // the outline's own checks (closed, one shape, not crossing itself), with what / why / fix
    try {
      parseOutlineSync(enc.outline);
    } catch (e) {
      rethrowOutline(e);
    }
  }
  const ids = new Set(s.project.parts.map((p) => p.id));
  const bad = [...(enc.front ? [enc.front] : []), ...Object.keys(enc.placements ?? {}), ...(enc.exclude ?? [])].filter((id) => !ids.has(id));
  if (bad.length) fail("unknown-part", `The case names ${bad.map((b) => `"${b}"`).join(", ")}, which ${bad.length > 1 ? "are" : "is"} not in the project`, `the parts are ${[...ids].join(", ")}`, "use those ids (get_project lists them)");
  return enc;
}

interface Out {
  report: CaseReport;
  dir: string;
  missing: { item: string; why: string; fix: string; say?: string }[];
}

let pdfOk: boolean | undefined;
async function pdfFromSvg(svg: string): Promise<{ pdf?: Uint8Array; why?: string }> {
  if (process.env.JUMPER_CASE_PDF === "0" || pdfOk === false) return { why: pdfOk === false ? "Playwright's Chromium did not start earlier in this session" : "PDF output is turned off (JUMPER_CASE_PDF=0)" };
  const pw = loadPlaywright();
  if (!pw) return { why: "Playwright is not installed" };
  try {
    const browser = await pw.chromium.launch();
    try {
      const page = (await browser.newPage()) as unknown as { setContent(h: string): Promise<void>; pdf(o: object): Promise<Buffer> };
      await page.setContent(`<!doctype html><html><head><style>@page{size:420mm 297mm;margin:0}html,body{margin:0}</style></head><body>${svg}</body></html>`);
      const pdf = await page.pdf({ width: "420mm", height: "297mm", printBackground: true, pageRanges: "1" });
      pdfOk = true;
      return { pdf: new Uint8Array(pdf) };
    } finally {
      await browser.close();
    }
  } catch (e) {
    pdfOk = false;
    return { why: `Playwright's Chromium could not print (${(e as Error).message.split("\n")[0]})` };
  }
}

/** Round 12: the cut list (power track's wireCuts) on a layout, as the assembly plan takes it. */
export function planWires(project: Project, reg: ProjectSession["registry"]) {
  return (L: import("@jumper/enclosure").Layout) =>
    wireCuts(project, reg, pinPositions(L.placed, (t) => reg.get(t)?.spec)).map((c) => ({ id: c.wire, from: c.from, to: c.to, length_mm: c.length_mm, gauge: c.gauge_awg, color: c.color }));
}

async function generateInto(s: ProjectSession, project: Project, caseDir: string): Promise<Out> {
  const { generateCase, writeCaseFiles, writeMeshCache } = await import("@jumper/enclosure");
  const g = await generateCase(project, (t) => s.registry.get(t)?.spec, { title: project.name, pdf: pdfFromSvg, wires: planWires(project, s.registry) });
  writeCaseFiles(caseDir, g.files);
  if (caseDir === join(s.dir, "case")) writeMeshCache(join(s.dir, ".jumper", "case-mesh.json"), g.mesh);
  return { report: g.report, dir: caseDir, missing: g.missing };
}

/** The saved case, regenerated first when its files are stale (hash of config + parts' mechanical data). */
export async function caseState(s: ProjectSession): Promise<{ report: CaseReport; regenerated: boolean; missing: Out["missing"] }> {
  const { caseHash, readManifest, readReport } = await import("@jumper/enclosure");
  const caseDir = join(s.dir, "case");
  const hash = caseHash(s.project, (t) => s.registry.get(t)?.spec);
  const m = readManifest(caseDir);
  const report = readReport(caseDir);
  if (m && report && m.hash === hash) return { report, regenerated: false, missing: [] };
  const out = await generateInto(s, s.project, caseDir);
  return { report: out.report, regenerated: true, missing: out.missing };
}

export async function caseIsStale(s: ProjectSession): Promise<boolean> {
  if (!s.project.enclosure) return false;
  const { caseHash, readManifest } = await import("@jumper/enclosure");
  return readManifest(join(s.dir, "case"))?.hash !== caseHash(s.project, (t) => s.registry.get(t)?.spec);
}

/**
 * Round 12: the assembly plan of the saved case (get_assembly_plan, POST /api/case/assembly):
 * what to buy, what to print, the consumables and tools, the steps with their pictures, how each
 * part is held and the design-for-assembly checks. The case is regenerated first when stale; a plan
 * made before the wires changed is made again (no CAD) and says its pictures are from the last build.
 */
export async function assemblyPlanFor(s: ProjectSession) {
  if (!s.project.enclosure) fail("no-case", "No case yet", "the assembly plan is how the parts go into the case, and this project has no case (jumper.json has no enclosure)", 'design_case {"shape": "pebble"} (or any shape; check_fit first), then get_assembly_plan');
  const st = await caseState(s);
  const E = await import("@jumper/enclosure");
  const caseDir = join(s.dir, "case");
  const specOf = (t: string) => s.registry.get(t)?.spec;
  let plan: import("@jumper/enclosure").AssemblyPlan | undefined;
  try {
    plan = JSON.parse(readFileSync(join(caseDir, "assembly", "plan.json"), "utf8"));
  } catch {
    plan = undefined;
  }
  const current = !!plan && plan.wires_key === E.wiresKey(s.project);
  if (!plan || !current) {
    const L = E.layoutCase(E.layoutInput(s.project, specOf));
    plan = E.assemblyPlan({ project: s.project, layout: L, specOf, title: s.project.name, wires: planWires(s.project, s.registry)(L) });
  }
  const report = st.report;
  const print = report.files.filter((f) => f.kind === "stl").map((f) => ({ file: `case/${f.path}`, body: f.body, face_down: f.print?.face_down ?? "flat", supports: f.print?.supports ?? false, note: f.print?.note ?? "" }));
  const cuts = plan.wires.map((w) => ({ wire: w.id, from: w.from, to: w.to, color: w.color, length_mm: w.length_mm, gauge_awg: w.gauge }));
  const screws = report.assembly && plan.consumables.find((c) => /M2 screws/.test(c.item)) ? { count: Number(plan.consumables.find((c) => /M2 screws/.test(c.item))!.qty), size: "M2 pan head (length in case/PRINT.md)", inserts: "M2 x 3 mm brass heat-set inserts" } : undefined;
  const buy = bomLines(s.project, s.registry, { soldered: true, cuts, ...(screws ? { screws } : {}), consumables: plan.consumables }).map((l) => ({ qty: l.qty, name: l.name, ...(l.value ? { value: l.value } : {}), ...(l.mpn ? { mpn: l.mpn } : {}), ...(l.generic ? { generic: l.generic } : {}), ...(l.notes ? { notes: l.notes } : {}), ...(l.refs ? { refs: l.refs } : {}) }));
  const problems = plan.checks.filter((c) => !c.ok || c.severity === "warning").map((c) => c.message);
  const steps = plan.steps.map((step) => ({ ...step, ...(current && step.image ? { image_file: join(caseDir, step.image) } : {}), ...(!current ? { image: undefined } : {}) }));
  return {
    title: plan.title,
    stale_case_regenerated: st.regenerated,
    pictures: current ? "one per step (image_file)" : "the wires changed since the case was built: these steps are new and have no pictures yet (design_case or update_case renders them)",
    buy,
    print,
    consumables: plan.consumables,
    tools: plan.tools,
    steps,
    mounts: plan.mounts,
    order: plan.order,
    opens_on: plan.hinge,
    wires: plan.wires,
    checks: plan.checks,
    problems,
    dir: join(caseDir, "assembly"),
    next: problems.length && plan.checks.some((c) => !c.ok && c.severity === "error") ? `Fix first: ${plan.checks.find((c) => !c.ok && c.severity === "error")!.message.split("Fix: ")[1] ?? "see checks"}` : "Tell the person what to buy and print, then walk them through the steps with the pictures (plain words; each step's say). export_manufacturing puts it all in the factory pack (assembly/ASSEMBLY.md).",
  };
}

function fmtSize(r: CaseReport): string {
  return `${r.size_mm.w} x ${r.size_mm.h} x ${r.size_mm.d} mm`;
}

function compact(r: CaseReport) {
  return { ...(r.fit ? { fits: r.fit.fits, fit: r.fit } : {}), ...(r.assembly ? { assembly: assemblySummary(r) } : {}), shape: r.shape, size_mm: r.size_mm, inner_mm: r.inner_mm, wall_mm: r.wall_mm, mass_g: r.mass_g, ...(r.volume_cm3 !== undefined ? { volume_cm3: r.volume_cm3 } : {}), pocket: r.pocket, ok: r.ok, checks: r.checks, placed: r.placed, enclosure: r.enclosure, hash: r.hash, notes: r.notes };
}

function answer(s: ProjectSession, out: Out, images: boolean, rel: string, next: string) {
  const imgs = ["renders/front.png", "renders/exploded.png"].map((p) => join(out.dir, p)).filter((p) => existsSync(p));
  return { ...compact(out.report), dir: out.dir, files: out.report.files.map((f) => `${rel}/${f.path}`), ...(out.missing.length ? { missing: out.missing } : {}), ...(images ? { image_files: imgs } : {}), next };
}

/** Round 12: the assembly plan in one line for design_case / update_case / get_case answers (the whole plan: get_assembly_plan). */
function assemblySummary(r: CaseReport) {
  const a = r.assembly!;
  const bad = r.checks.filter((c) => c.id.startsWith("assembly-") && (!c.ok || c.severity === "warning"));
  return { steps: a.steps, order: a.order, opens_on: a.hinge, errors: a.errors, warnings: a.warnings, problems: bad.map((c) => c.message), plan: `case/${a.plan}`, images: a.images.length, how: "get_assembly_plan has every step (plain words, parts, wires, tools, cautions, a picture each), the pieces to print and the consumables" };
}

function nextAfter(r: CaseReport): string {
  const bad = r.checks.filter((c) => !c.ok && c.severity === "error");
  if (bad.length) return `Fix: ${bad[0]!.message.split("Fix: ")[1] ?? "see checks"}`;
  return "Show the person the renders (case/renders/), then get_assembly_plan (what to buy and print, and how it goes together, step by step with pictures), then export_manufacturing for the factory pack. Try other shapes with design_case {save: false}.";
}

// ===================================================================== factory pack

export async function exportManufacturing(s: ProjectSession, args: { dir?: string; zip: boolean; zh_cn: boolean }) {
  const project = s.project;
  const reg = s.registry;
  const outRoot = resolve(s.dir, args.dir ?? "manufacturing");
  if (relative(s.dir, outRoot).startsWith("..")) fail("bad-arg", "The pack folder must be inside the project", `${outRoot} is outside ${s.dir}`, 'pass a folder name like "manufacturing"');
  const version = listVersions(s.dir).length || 1;
  const slug = projectSlug(project.name);
  const name = `${slug}-v${version}`;
  const root = join(outRoot, name);
  clearDir(root);
  const missing: { item: string; why: string; fix: string; say?: string }[] = [];
  const notes: string[] = [];
  const board = project.parts.find((p) => p.id === project.firmware?.board) ?? project.parts.find((p) => reg.get(p.type)?.spec.mcu);
  const boardSpec = board ? reg.get(board.type)?.spec : undefined;
  const rp2040 = boardSpec?.mcu?.backend === "rp2040js";
  const pocketBoard = !!board && /xiao|zero/.test(board.type);
  const soldered = (project.assembly ?? (project.enclosure || pocketBoard ? "soldered" : "breadboard")) === "soldered";

  // ---- case
  let report: CaseReport | undefined;
  let screws: { count: number; size: string; inserts: string } | undefined;
  let positions: Record<string, [number, number, number]> | undefined;
  if (project.enclosure) {
    const st = await caseState(s);
    report = st.report;
    for (const m of st.missing) missing.push({ ...m, item: `enclosure/${m.item}` });
    copyTree(join(s.dir, "case"), join(root, "enclosure"), (rel) => rel.startsWith("variants") || rel.startsWith("."));
    if (existsSync(join(root, "enclosure", "drawing")) && !existsSync(join(root, "enclosure", "drawing", "drawing.pdf")) && !st.missing.length) missing.push({ item: "enclosure/drawing/drawing.pdf", why: "no PDF was printed when the case was generated (Playwright's Chromium was not available, or JUMPER_CASE_PDF=0)", fix: "pnpm --filter @jumper/web exec playwright install chromium, then design_case again (drawing.svg has the same drawing)" });
    const { layoutCase } = await import("@jumper/enclosure");
    const L = layoutCase({ parts: project.parts.flatMap((p) => (reg.get(p.type) ? [{ id: p.id, type: p.type, spec: reg.get(p.type)!.spec }] : [])), enclosure: project.enclosure });
    positions = pinPositions(L.placed, (t) => reg.get(t)?.spec);
    if (project.enclosure.params?.closure === "screws" && L.bosses.length) screws = { count: L.bosses.length, size: "M2 pan head (length in enclosure/PRINT.md)", inserts: "M2 x 3 mm brass heat-set inserts" };
  } else missing.push({ item: "enclosure/", why: "the project has no case yet", fix: 'design_case {"shape": "pebble"} (or puck, rounded-box, pill, keychain), then export_manufacturing again', say: "pick a shape and press Design case, then Factory pack again" });

  // ---- round 12: the assembly plan (order, how each part is held, what to buy beyond the parts)
  const ap = project.enclosure ? await assemblyPlanFor(s) : undefined;
  // ---- electronics
  // (the wires between the shells are cut long enough to open the case like a book: the plan's lengths)
  const cuts = wireCuts(project, reg, positions).map((c) => {
    const w = ap?.wires.find((x) => x.id === c.wire);
    return w && w.length_mm > c.length_mm ? { ...c, length_mm: w.length_mm } : c;
  });
  const lines = bomLines(project, reg, { soldered, cuts, ...(screws ? { screws } : {}), ...(ap ? { consumables: ap.consumables } : {}) });
  writeText(root, "BOM.csv", bomCsv(lines));
  writeText(root, "BOM.md", bomMd(lines, project.name));
  writeText(root, "electronics/WIRING.md", wiringMarkdown(project, reg));
  writeText(root, "electronics/netlist.csv", netlistCsv(project));
  writeText(root, "electronics/jumper.net", kicadNetlist(project, reg));
  writeText(root, "electronics/WIRE-CUTS.csv", wireCutsCsv(cuts, !positions));
  // round 7 voice: the DFPlayer's microSD card (clip texts, a list, and a script that makes the MP3s)
  const sd = sdCardFiles(project, reg);
  for (const [p, text] of Object.entries(sd)) writeText(root, `sd-card/${p}`, text);
  if (Object.keys(sd).length) notes.push("sd-card/ holds the clip texts, not audio: run sd-card/make-clips.sh (needs espeak-ng or piper plus ffmpeg, installed by you) or record the clips, then copy them to a FAT32 microSD card (sd-card/CLIPS.md).");
  // round 10 network: what the real device needs on the network (hosts, ports, secret NAMES, how keys reach it)
  if (project.network) {
    const net = factoryNetworkNotes(networkConfigOf(project)).replace(/^## Network/, `# Network: ${project.name}`);
    writeText(root, "firmware/NETWORK.md", `${net}\n\nBuild: the simulation build adds Jumper's Wi-Fi and TLS shims; the device build must not. With Jumper's ESP32 image: JUMPER_SIM=0 (plain arduino-cli builds never contain them). No secret value is in this pack.\n`);
    notes.push("firmware/NETWORK.md lists the hosts, ports and secret names the real device needs, and the options for getting a key onto it (no secret values are in the pack).");
    // round 13: the API relay the real device calls (Node server + Cloudflare Worker), generated from the same config
    const cfg = networkConfigOf(project);
    if (relayUseful(cfg)) {
      for (const [rel, text] of Object.entries(relayPack(cfg, project.name))) writeText(root, `relay/${rel}`, text);
      notes.push("relay/ is the API relay for the real device (run it with Node or deploy it to Cloudflare Workers; relay/README.md): the device holds a revocable token for it, never an API key. The firmware in this pack has no token or Wi-Fi password.");
    }
  }
  if (!positions) notes.push("Wire lengths are estimates from the part sizes (no case layout yet); design_case gives lengths from the real positions.");

  // ---- firmware
  const fw = project.firmware;
  let fwHash = "";
  if (fw) {
    const fwDir = join(s.dir, fw.dir ?? "firmware");
    copyTree(fwDir, join(root, "firmware", "source"), (rel) => /\.(hex|elf|bin|uf2|map)$/.test(rel) || rel.startsWith("build") || rel.startsWith("."));
    // Round 10: the firmware for the real board (ESP32 boards get their own build: Serial on USB, QIO flash).
    const dev = await s.deviceFirmware();
    if ("data" in dev) {
      const crypto = await import("node:crypto");
      if (dev.format === "bin") {
        writeFileSync(join(root, "firmware", "firmware.bin"), dev.data as Uint8Array);
      } else {
        writeText(root, "firmware/firmware.hex", dev.data as string);
        if (rp2040) writeText(root, "firmware/firmware.uf2", hexToUf2(dev.data as string));
      }
      fwHash = crypto.createHash("sha256").update(dev.data).digest("hex").slice(0, 16);
      if (dev.differs) notes.push(`Firmware: ${dev.differs}.`);
    } else missing.push({ item: "firmware/firmware.hex", why: dev.error, fix: dev.fix, say: "press Run (or Build) first, then Factory pack again" });
    const esp = "data" in dev && dev.format === "bin" ? { flash: dev.flash, fqbn: dev.fqbn } : boardSpec?.mcu?.backend === "qemu-esp" ? { flash: boardSpec.mcu.toolchain?.flash, fqbn: boardSpec.mcu.fqbn ?? "" } : undefined;
    writeText(root, "firmware/FLASHING.md", flashingMd(project.name, boardSpec?.name ?? board?.type ?? "the board", rp2040, fw.libraries ?? [], esp));
  } else missing.push({ item: "firmware/", why: "the project has no firmware", fix: "write_file the sketch and build", say: "write the sketch in the code panel and press Build, then Factory pack again" });

  // ---- assembly, tests, readme, notes
  writeText(root, "assembly/ASSEMBLY.md", ap && soldered ? planMd(project, ap) : assemblyMd(project, reg, report, soldered, !!screws));
  writeText(root, "test/TEST-PLAN.md", testPlanMd(project));
  const fid = fidelityReport(project, reg);
  writeText(root, "test/TEST-ON-HARDWARE.md", `# Test these on the real device: ${project.name}\n\n${fid.summary}\n\n${fid.testOnRealDevice.map((t) => `- [ ] ${t}`).join("\n")}\n\n## Simulator limits\n\n${fid.global.map((g) => `- ${g}`).join("\n")}\n`);
  writeText(root, "README.md", readmeMd(project, boardSpec?.name ?? "", report, soldered, lines, missing));
  if (args.zh_cn) writeText(root, "README.zh-CN.md", readmeZh(project, boardSpec?.name ?? "", report));
  writeText(root, "NOTES.md", notesMd(project, reg, report, soldered, fid.summary));
  // round 12 kit: the person-facing build kit (what to buy, print, how to put it inside, flash, fix)
  try {
    const { buildKit } = await import("../kit/index.ts");
    const { writeKitFiles } = await import("../kit/files.ts");
    const kit = await buildKit(s, { slicer: "cached" });
    await writeKitFiles(s, kit, { into: join(root, "build-kit"), pdf: false, firmware: false, caseFiles: false });
    writeText(root, "build-kit/WHERE-ARE-THE-FILES.md", "# Where the kit's files are\n\nThe kit names the case files as `case/...` and the firmware as `firmware/...`. In this pack they are in `../enclosure/` (same paths) and `../firmware/`.\n");
  } catch (e) {
    notes.push(`The build kit (build-kit/) could not be written: ${(e as Error).message.split("\n")[0]}. get_build_kit makes it on its own.`);
  }
  const files = listFiles(root);
  writeText(root, "manifest.json", JSON.stringify({ project: project.name, version, firmware_hash: fwHash, case_hash: report?.hash ?? "", files }, null, 2) + "\n");
  let zipPath: string | undefined;
  if (args.zip) {
    zipPath = join(outRoot, `${name}.zip`);
    writeFileSync(zipPath, zipFolder(root, name));
  }
  const all = [...files.map((f) => f.path), "manifest.json"];
  return {
    dir: root,
    ...(zipPath ? { zip: zipPath, zip_bytes: statSync(zipPath).size } : {}),
    files: all,
    missing,
    notes: [...notes, "No PCB layout yet: the pack describes a hand-wired (perfboard / point-to-point) build; jumper.net is a netlist a PCB designer can start from.", "LCSC / JLC numbers are only filled where checked; the supplier quotes the rest from the MPN or the description."],
    next: missing.length ? `Complete it: ${missing.map((m) => m.fix).join("; ")}` : `Send ${zipPath ?? root} to the supplier, or open README.md to build it yourself.`,
  };
}

function flashingMd(name: string, board: string, rp2040: boolean, libs: string[], esp?: { flash?: string | undefined; fqbn: string }): string {
  const lines = [`# Flashing ${name}`, "", `Board: **${board}**.`, ""];
  if (esp)
    lines.push(
      "## Command line (esptool)",
      "",
      "`firmware.bin` is the merged flash image (bootloader, partition table and app) built for this board. Install esptool (`pip install esptool`; GPL-2.0, a separate program) and plug the board in:",
      "",
      "```sh\n" + (esp.flash ?? "esptool --port <port> write_flash 0x0 {bin}").replace("{bin}", "firmware.bin").replace("{port}", "<port>") + "\n```",
      "",
      "`<port>` is the board's serial port (macOS `/dev/cu.usbmodem…` or `/dev/cu.usbserial…`, Linux `/dev/ttyACM0` / `/dev/ttyUSB0`, Windows `COM3`). If it does not connect, hold **BOOT** while pressing **RESET** (or while plugging USB in), then try again.",
      "",
      `Or from source: \`arduino-cli compile --fqbn ${esp.fqbn} source && arduino-cli upload --fqbn ${esp.fqbn} -p <port> source\` (board package esp32:esp32 3.3.12).`,
      "",
    );
  else if (rp2040)
    lines.push("## Easiest: drag and drop (no software)", "", "1. Hold the **BOOT** (BOOTSEL) button on the board.", "2. Plug the USB-C cable into a computer while holding it; release. A drive called **RPI-RP2** appears.", "3. Copy `firmware.uf2` onto that drive. It disconnects and the device starts.", "", "## Command line", "", "```sh\npicotool load -x firmware.uf2\n```", "");
  else lines.push("## Command line (avrdude)", "", "```sh\navrdude -p m328p -c arduino -P <port> -b 115200 -U flash:w:firmware.hex:i\n```", "", "Or open `source/` in the Arduino IDE and press Upload.", "");
  lines.push("## Build from source", "", "The sketch is in `source/`. Arduino IDE or arduino-cli with the board package for this board" + (libs.length ? ` and these libraries: ${libs.join(", ")}` : "") + ".", "", "Some libraries are LGPL (for example Adafruit NeoPixel): a firmware binary you distribute that links one carries LGPL obligations (offer the object files or the source).", "");
  return lines.join("\n");
}

function assemblyMd(project: Project, reg: ProjectSession["registry"], report: CaseReport | undefined, soldered: boolean, screws: boolean): string {
  const steps: string[] = [];
  const img = (n: string) => (report ? `\n\n   ![${n}](../enclosure/renders/${n}.png)` : "");
  if (report) steps.push(`Print the case: \`enclosure/PRINT.md\` (front and back shells${report.files.some((f) => f.path.includes("cap-")) ? ", button plungers" : ""}${report.files.some((f) => f.path.includes("light-pipe")) ? ", light pipes" : ""}). Test-fit the two shells before anything else.`);
  if (screws) steps.push("Press the M2 heat-set inserts into the front shell's bosses with a soldering iron at about 220 °C; let them cool.");
  steps.push("Flash the firmware on the bare board first (`firmware/FLASHING.md`) and check it boots (serial output or the screen).");
  if (soldered) steps.push("Cut and strip the wires listed in `electronics/WIRE-CUTS.csv` (lengths include 10 mm to strip and some slack). Tin every end.");
  steps.push(`${soldered ? "Solder" : "Wire"} every connection in \`electronics/WIRING.md\` (the same nets are in \`netlist.csv\`). Power wires (24 AWG) first, then signals; heat-shrink every splice.`);
  steps.push("Bench test before closing: power it from USB and run through `test/TEST-PLAN.md`.");
  if (report) {
    const placed = [...report.placed].sort((a, b) => a.layer - b.layer);
    const named = (id: string) => {
      const p = project.parts.find((x) => x.id === id);
      return `${id} (${reg.get(p?.type ?? "")?.spec.name ?? p?.type})`;
    };
    steps.push(`Fit the parts, front to back, into the front shell (looking at its inside):${placed.map((p) => `\n   - ${named(p.id)}: layer ${p.layer}, its top faces the ${p.facing}${p.facing !== "front" && p.facing !== "back" ? " wall (its opening is there)" : ""}.`).join("")}${img("inside")}`);
    steps.push("Put the button plungers / light pipes into their holes from the inside before the parts behind them. Hold modules with no standoff with 1 mm foam tape; keep wires away from the seam so the lip closes.");
    if (report.placed.some((p) => project.parts.find((x) => x.id === p.id)?.type === "lipo-battery")) steps.push("Place the LiPo cell in its cradle on the back shell last. Never press, bend or pierce it; plug its connector in only after all soldering is done.");
    steps.push(`Close the case: ${screws ? "M2 screws from the back into the inserts, finger tight" : "press the front onto the back all round until the lip clicks"}.${img("exploded")}`);
  }
  steps.push("Final test: `test/TEST-PLAN.md` again, then the checks in `test/TEST-ON-HARDWARE.md`.");
  return `# Assembly: ${project.name}\n\n${soldered ? "Hand-wired build (point-to-point or perfboard): no breadboard, no dupont wires." : "Breadboard build."}\n\n${steps.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n`;
}

/** Round 12: ASSEMBLY.md from the assembly plan: what to buy and print, then every step with its picture. */
function planMd(project: Project, ap: Awaited<ReturnType<typeof assemblyPlanFor>>): string {
  const out: string[] = [`# Assembly: ${project.name}`, "", "Hand-wired build (point to point) in a 3D-printed case. Jumper worked out this order at design time: parts another one covers go in first, every joint is soldered while it can be reached, the battery goes in last, and it is tested before it is closed.", ""];
  out.push("## Print", "", "| File | Face on the bed | Supports |", "| --- | --- | --- |", ...ap.print.map((p) => `| enclosure/${p.file.replace(/^case\//, "")} | ${p.face_down} | ${p.supports ? "yes" : "no"} |`), "", "Settings and material: `enclosure/PRINT.md`.", "");
  out.push("## Consumables", "", ...ap.consumables.map((c) => `- ${c.item}: ${c.qty} (${c.why})`), "", "## Tools", "", ...ap.tools.map((t) => `- ${t}`), "");
  out.push("## How each part is held", "", "| Part | Shell | How it goes in | Held by |", "| --- | --- | --- | --- |", ...ap.mounts.map((m) => `| ${m.part} | ${m.shell} | ${m.insert} | ${m.how.join(", ")}${m.missing ? ` (${m.missing})` : ""} |`), "");
  out.push("## Steps", "");
  for (const st of ap.steps) {
    out.push(`### ${st.n}. ${st.title}`, "", st.say, "");
    if (st.image) out.push(`![Step ${st.n}](../enclosure/${st.image})`, "");
    if (st.wires.length) out.push(...st.wires.map((w) => `- ${w.id}: ${w.from} to ${w.to}, ${w.color}, ${w.gauge} AWG, ${w.length_mm} mm`), "");
    if (st.fasteners.length) out.push(...st.fasteners.map((f) => `- ${f.qty} x ${f.kind} ${f.size}`), "");
    if (st.cautions.length) out.push(...st.cautions.map((c) => `> ${c}`), "");
  }
  const flagged = ap.checks.filter((c) => !c.ok || c.severity !== "info");
  out.push("## Checks", "", ...(flagged.length ? flagged.map((c) => `- **${c.id}** (${c.severity}): ${c.message}`) : ["- Every assembly check passed."]), "");
  return out.join("\n");
}

function stepText(st: Record<string, unknown>): string {
  const w = st.within_ms ? ` within ${(Number(st.within_ms) / 1000).toFixed(1)} s` : "";
  if (st.run_ms !== undefined) return `wait ${(Number(st.run_ms) / 1000).toFixed(1)} s`;
  if (st.press) return `press ${st.press}${st.hold_ms ? ` for ${st.hold_ms} ms` : ""}`;
  if (st.set) return `make ${st.set} = ${st.value} (${String(st.set).split(".")[1]}: tilt / shake / set the sensor like that)`;
  if (st.expect_serial) return `${st.absent ? "check the serial monitor does NOT show" : "the serial monitor shows"} "${st.expect_serial}"${w}`;
  if (st.expect_serial_value) return `the serial value ${st.expect_serial_value} is ${st.op} ${st.value}${w}`;
  if (st.expect_display) return `the screen ${st.expect_display} lights up${st.region ? " in the area under test" : ""}${w}`;
  if (st.expect_part) return `${st.expect_part} ${st.op} ${st.value}${w} (watch / listen for it)`;
  if (st.expect_pin) return `pin ${st.expect_pin} reads ${st.value ?? st.state}${w}`;
  return JSON.stringify(st);
}

function testPlanMd(project: Project): string {
  const out = [`# Test plan: ${project.name}`, "", "Each test passed in Jumper's simulator. Repeat it on the real unit; tick when it behaves the same.", ""];
  if (!project.scenarios.length) out.push("No scenarios were written. Power it up and check every function by hand.");
  for (const sc of project.scenarios) {
    out.push(`## ${sc.name ?? sc.id}`, "");
    (sc.steps as Record<string, unknown>[]).forEach((st, i) => out.push(`${i + 1}. [ ] ${stepText(st)}`));
    out.push("");
  }
  return out.join("\n") + "\n";
}

function readmeMd(project: Project, board: string, report: CaseReport | undefined, soldered: boolean, lines: { qty: number; name: string }[], missing: { item: string }[]): string {
  return `# ${project.name}: build pack

${project.description ?? `A small ${soldered ? "hand-wired" : "breadboard"} electronic device${board ? ` built on a ${board}` : ""}.`}

## What is inside

${lines.filter((l) => l.name).map((l) => `- ${l.qty} x ${l.name}`).join("\n")}
${report ? `\nCase: **${report.shape}**, ${report.size_mm.w} x ${report.size_mm.h} x ${report.size_mm.d} mm, ${report.wall_mm} mm wall, 3D printed (${report.enclosure.params?.process ?? "fdm"}).\n` : ""}
## How to make one

1. Buy the parts in \`BOM.csv\` (MPN where known, otherwise the description in "generic").
2. Print the case: \`enclosure/PRINT.md\` (STL / 3MF for printers, STEP for factories, drawing with all sizes).
3. Flash the firmware: \`firmware/FLASHING.md\`.
4. Build it: \`assembly/ASSEMBLY.md\`: what to print and the consumables, then every step in order with a picture (wiring in \`electronics/\`).
5. Test it: \`test/TEST-PLAN.md\`.

## Files

| Folder | What |
| --- | --- |
| BOM.csv, BOM.md | parts, quantities, MPNs, prices |
| electronics/ | WIRING.md, netlist.csv, jumper.net (KiCad netlist), WIRE-CUTS.csv |
| firmware/ | firmware.hex${board.includes("RP2040") || board.includes("Pico") ? ", firmware.uf2" : ""}, FLASHING.md, source/ |
| enclosure/ | stl/, case.3mf, step/, drawing/, renders/, PRINT.md |
| assembly/ | ASSEMBLY.md |
| test/ | TEST-PLAN.md, TEST-ON-HARDWARE.md |
| build-kit/ | for a person building one: kit.html (open it in a browser: what to buy and where, what to print, the tools, step-by-step with pictures, flashing, troubleshooting), KIT.md, SHOPPING.csv |

Building just one yourself? Open \`build-kit/kit.html\`.

Read \`NOTES.md\` before quoting: it lists what was only simulated and what to verify on the first unit.${missing.length ? `\n\n**Not in this pack yet:** ${missing.map((m) => m.item).join(", ")}.` : ""}
`;
}

function readmeZh(project: Project, board: string, report: CaseReport | undefined): string {
  return `# ${project.name}：生产资料包（摘要）

这是一个小型电子设备${board ? `（主控板：${board}）` : ""}，手工焊接（无 PCB），外壳为 3D 打印${report ? `（${report.shape}，${report.size_mm.w} x ${report.size_mm.h} x ${report.size_mm.d} mm，壁厚 ${report.wall_mm} mm）` : ""}。

## 内容

- BOM.csv：物料清单（数量、型号 MPN、通用描述、参考单价）
- electronics/：接线表 WIRING.md、网表 netlist.csv 与 jumper.net（KiCad）、导线下料表 WIRE-CUTS.csv
- firmware/：固件（.hex / .uf2）、源代码、烧录步骤 FLASHING.md
- enclosure/：外壳 STL 与 3MF（3D 打印）、STEP（报价与开模）、尺寸图（SVG / PDF）、打印说明 PRINT.md
- assembly/ASSEMBLY.md：装配步骤（每一步一张图：零件放入顺序、焊接、电池最后安装、合壳前通电测试）
- test/：测试计划

## 注意

- 目前没有 PCB 设计：按接线表手工接线（洞洞板 / 飞线）。jumper.net 可作为 PCB 设计的起点。
- 功能只在仿真中验证过：请先做一台样机，按 test/TEST-PLAN.md 逐项检查。
- 外壳尺寸基于模块的典型尺寸，不同厂家的模块可能相差约 1 mm，请用实物核对屏幕窗口和 USB 开孔。
- LCSC 编号只填写已核实的；其余请按型号或描述报价。

完整说明见英文 README.md。
`;
}

function notesMd(project: Project, reg: ProjectSession["registry"], report: CaseReport | undefined, soldered: boolean, fidSummary: string): string {
  const flagged = project.parts.filter((p) => p.standIn || reg.get(p.type)?.fidelity.origin === "agent-made");
  return `# Honest notes: ${project.name}

## Not designed yet

- **No PCB layout.** This is a ${soldered ? "hand-wired build (point-to-point or perfboard)" : "breadboard build"}. \`electronics/jumper.net\` is a netlist a PCB designer can import into KiCad to start one; no footprints or placement were chosen.
- No certification work (CE / FCC / UKCA), no ESD or EMC design.

## Only simulated

- ${fidSummary}
- The tests in \`test/TEST-PLAN.md\` passed in Jumper's simulator, which runs the real compiled firmware against models of the parts; real parts can differ (timing, noise, clone chips).
${flagged.map((p) => `- **${p.id}**: ${p.standIn ? `simulated with a stand-in for the real ${p.standIn}` : "agent-made part (behavioral, unverified)"}: check its wiring against the real datasheet.`).join("\n")}

## Case

${report ? report.notes.map((n) => `- ${n}`).join("\n") : "- No case was designed."}
${report ? `- Checks at design time: ${report.checks.map((c) => `${c.id} ${c.ok ? "ok" : c.severity}`).join(", ")}.` : ""}

## Verify on the first real unit

- [ ] The screen window lines up with the real display and the bezel is hidden.
- [ ] USB plugs reach their sockets fully through the case openings.
- [ ] Buttons click through their plungers with the case closed.
- [ ] The case closes without pinching wires; nothing presses on the battery.
- [ ] Battery life and charging match the plan (charge current set for the cell).
- [ ] Every line of \`test/TEST-PLAN.md\` and \`test/TEST-ON-HARDWARE.md\`.
`;
}

/** Meshes for the web Case view (R6 GET /api/case/mesh): from the cache, rebuilt when it is missing or stale. */
export async function caseMesh(s: ProjectSession): Promise<{ mesh: import("@jumper/enclosure").CaseMesh; regenerated: boolean; report: CaseReport }> {
  const st = await caseState(s);
  const { readMeshCache, generateCase, writeMeshCache } = await import("@jumper/enclosure");
  const file = join(s.dir, ".jumper", "case-mesh.json");
  const cached = readMeshCache(file, st.report.hash);
  if (cached) return { mesh: cached, regenerated: st.regenerated, report: st.report };
  const g = await generateCase(s.project, (t) => s.registry.get(t)?.spec, { renders: false });
  writeMeshCache(file, g.mesh);
  return { mesh: g.mesh, regenerated: st.regenerated, report: st.report };
}

/** One opening of the built case, as the Device view places its live parts (case frame, mm). */
export interface DeviceCaseOpening {
  part: string;
  feature: string;
  kind: string;
  face: string;
  /** Outward normal. */
  n: [number, number, number];
  /** Centre on the cavity's inner surface (outer surface = at + n * depth). */
  at: [number, number, number];
  shape: "rect" | "round";
  u: number;
  v: number;
  uAxis: [number, number, number];
  vAxis: [number, number, number];
  depth: number;
  standoff: number;
  /** window: the display's active area behind it (u along uAxis). */
  screen?: { u: number; v: number; shape: string };
  /** button cap / light pipe printed as its own body (mesh body `cap-<part>` / `light-pipe-<part>`). */
  insert?: { kind: string; d: number; travel: number; protrude: number; length: number };
  holes?: number;
}

/** GET /api/device/case: the built case for the Device view, never rebuilt here (a stale case is shown as built, with stale: true). */
export interface DeviceCase {
  hash: string;
  engine: string;
  stale: boolean;
  /** Why it is out of date, in a person's words (when stale). */
  stale_reason?: string;
  shape: string;
  color?: string;
  size_mm: { w: number; h: number; d: number };
  mesh: import("@jumper/enclosure").CaseMesh;
  openings: DeviceCaseOpening[];
  /** Built from this many ms of work on the server (0 = all from the cache). */
  ms: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const v3 = (v: readonly number[]) => [r3(v[0]!), r3(v[1]!), r3(v[2]!)] as [number, number, number];

/**
 * The case as built, for the Device view: its meshes (the web mesh cache, made once when missing)
 * and where its openings are (window, buttons, light pipes, grille, connectors), from the layout the
 * case was built with. Never writes case/ files: a stale case is returned as built with stale: true,
 * so the view can say "case out of date - Update case". null when the project has no case yet, or
 * a case was asked for but never built.
 */
export async function deviceCase(s: ProjectSession): Promise<DeviceCase | null> {
  if (!s.project.enclosure) return null;
  const t0 = Date.now();
  const E = await import("@jumper/enclosure");
  const specOf = (t: string) => s.registry.get(t)?.spec;
  const caseDir = join(s.dir, "case");
  const manifest = E.readManifest(caseDir);
  const report = E.readReport(caseDir);
  if (!manifest || !report) return null;
  const hash = E.caseHash(s.project, specOf);
  const stale = manifest.hash !== hash;
  // the project the case was built from: today's parts with the enclosure as it was saved then
  const built: Project = stale ? { ...s.project, enclosure: (manifest.enclosure ?? report.enclosure ?? s.project.enclosure) as Enclosure } : s.project;
  const cacheFile = join(s.dir, ".jumper", "case-mesh.json");
  let mesh = E.readMeshCache(cacheFile, report.hash);
  let L: import("@jumper/enclosure").Layout | undefined;
  if (!mesh) {
    // the meshes are not cached yet: tessellate the case as built (CAD, once; the Case view reads the same cache)
    const g = await E.generateCase(built, specOf, { renders: false });
    mesh = g.mesh;
    L = g.layout;
    if (!stale) E.writeMeshCache(cacheFile, mesh);
  }
  L ??= E.layoutCase(E.layoutInput(built, specOf));
  // A stale case: today's layout may have moved the parts. The meshes are the case as built, so each
  // opening is moved by how far its part moved from where the built report placed it (same facing),
  // and openings of parts the built case did not have (or that turned to another face) are dropped.
  const shift = new Map<string, [number, number, number]>();
  if (stale) {
    for (const p of L.placed) {
      const was = report.placed?.find((q) => q.id === p.mech.id);
      if (!was || was.facing !== p.facing) continue;
      shift.set(p.mech.id, [0, 1, 2].map((k) => (was.min[k]! + was.max[k]!) / 2 - (p.min[k]! + p.max[k]!) / 2) as [number, number, number]);
    }
  }
  const kept = stale ? L.openings.filter((o) => shift.has(o.part)) : L.openings;
  const openings: DeviceCaseOpening[] = kept.map((o) => {
    const d = shift.get(o.part) ?? [0, 0, 0];
    const scr = o.kind === "window" ? L!.placed.find((p) => p.mech.id === o.part)?.mech.features.find((f) => f.kind === "screen") : undefined;
    return {
      part: o.part,
      feature: o.feature,
      kind: o.kind,
      face: o.face,
      n: v3(o.n),
      at: v3([o.at[0] + d[0], o.at[1] + d[1], o.at[2] + d[2]]),
      shape: o.shape,
      u: r3(o.u),
      v: r3(o.v),
      uAxis: v3(o.uAxis),
      vAxis: v3(o.vAxis),
      depth: r3(o.depth),
      standoff: r3(o.standoff),
      ...(scr ? { screen: { u: r3(scr.u), v: r3(scr.v), shape: scr.shape } } : {}),
      ...(o.insert ? { insert: { kind: o.insert.kind, d: r3(o.insert.d), travel: r3(o.insert.travel), protrude: r3(o.insert.protrude), length: r3(o.insert.length) } } : {}),
      ...(o.holes ? { holes: o.holes.length } : {}),
    };
  });
  const engine = manifest.engine ?? "?";
  const staleReason = !stale ? undefined : engine !== E.ENGINE_VERSION ? `made with an older case engine (${engine}, now ${E.ENGINE_VERSION})` : "the parts or the case settings changed since it was built";
  const color = (report.enclosure?.params as { color?: string } | undefined)?.color ?? mesh.bodies.find((b) => b.kind === "shell")?.color;
  return { hash: report.hash, engine, stale, ...(staleReason ? { stale_reason: staleReason } : {}), shape: report.shape, ...(color ? { color } : {}), size_mm: report.size_mm, mesh, openings, ms: Date.now() - t0 };
}
