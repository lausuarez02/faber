import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_MADE_LABEL, compileCustomPart, registry as builtinRegistry, withProjectParts, customPartJsonSchema, CustomPartError, type CompiledCustomPart, type CustomPart, type ProjectPartRegistry } from "@fabwright/parts";
import { projectPartsStamp, readProjectParts } from "@fabwright/parts/node";
import type { PartDefinition, PartRegistry } from "@fabwright/sim-core";
import { didYouMean, fail } from "../errors.ts";
import type { ProjectSession } from "../session.ts";
import type { ExtOpContext, ToolModule } from "./types.ts";

/**
 * Track "agentparts" (owner): create_part, update_part, list_project_parts.
 * Contract: docs/decisions/0003-round5-see-it-work.md, C4 and C5.
 *
 * An agent-made part lives in the project as parts/<id>/part.json (+ visual.svg). It is written
 * only through these tools, so it is an undoable step in the history like any edit. The session's
 * registry is the built-ins plus these parts (refreshProjectParts, called from sync()).
 */

const why = { type: "string", description: 'Short reason shown to the human in the step list, e.g. "the catalog has no soil sensor". Consecutive edits with the same why form one undoable step.' };

export function isProjectPartRegistry(r: PartRegistry): r is ProjectPartRegistry {
  return typeof (r as Partial<ProjectPartRegistry>).setProjectParts === "function";
}

interface PartsState {
  stamp: string;
  errors: { id: string; message: string }[];
  warnings: string[];
  compiled: Map<string, CompiledCustomPart>;
}
const STATE = new WeakMap<PartRegistry, PartsState>();

/**
 * Reload <dir>/parts/ into the registry when it changed on disk (another process, undo, create_part).
 * Returns true when the project parts changed, so the caller rebuilds its simulation.
 */
export function refreshProjectParts(dir: string, registry: PartRegistry, force = false): boolean {
  if (!isProjectPartRegistry(registry)) return false;
  const stamp = projectPartsStamp(dir);
  const st = STATE.get(registry);
  if (!force && st && st.stamp === stamp) return false;
  if (!st && stamp === "") {
    STATE.set(registry, { stamp, errors: [], warnings: [], compiled: new Map() });
    return false;
  }
  const loaded = readProjectParts(dir, registry.base);
  const warnings = registry.setProjectParts(loaded.parts.map((p) => p.def));
  STATE.set(registry, { stamp, errors: loaded.errors, warnings, compiled: new Map(loaded.parts.map((p) => [p.id, p])) });
  return true;
}

/**
 * The registry a project folder that is not the active one draws with (gallery thumbnails, cards):
 * built-ins plus that folder's own agent-made parts. Broken part folders are left out.
 */
export function registryForProjectDir(dir: string, base: PartRegistry = builtinRegistry): PartRegistry {
  const reg = withProjectParts(base);
  refreshProjectParts(dir, reg, true);
  return reg;
}

/** Load problems of the project's parts/ folder (for list_project_parts). */
export function projectPartProblems(registry: PartRegistry): string[] {
  const st = STATE.get(registry);
  return st ? [...st.errors.map((e) => e.message), ...st.warnings] : [];
}

/** Agent-made parts with their sanitized / generated SVG (GET /api/project-parts). */
export function projectPartsWithSvg(session: ProjectSession): { id: string; part: CustomPart; svg: string; generated: boolean }[] {
  refreshProjectParts(session.dir, session.registry);
  const st = STATE.get(session.registry);
  return st ? [...st.compiled.values()].map((c) => ({ id: c.part.id, part: c.part, svg: c.svg, generated: c.generatedSvg })) : [];
}

function compileOrFail(part: unknown, svg: string | null | undefined, builtins: PartRegistry): CompiledCustomPart {
  try {
    return compileCustomPart(part, svg, { builtins });
  } catch (e) {
    if (e instanceof CustomPartError) fail("bad-part", e.what, e.why, e.fix, { problems: e.problems });
    throw e;
  }
}

const partFile = (id: string) => `parts/${id}/part.json`;
const svgFile = (id: string) => `parts/${id}/visual.svg`;

function result(c: CompiledCustomPart, next: string) {
  const s = c.def.spec;
  return {
    type: s.id,
    name: s.name,
    behavior: c.part.behavior.kind,
    pins: s.pins.map((p) => `${p.id}${p.label !== p.id ? ` "${p.label}"` : ""}: ${p.type}${p.protocols?.length ? ` ${p.protocols.join(",")}` : ""}`),
    ...(s.props?.length ? { props: s.props.map((p) => `${p.id} (${p.type}${p.unit ? `, ${p.unit}` : ""}) default ${JSON.stringify(p.default)}`) } : {}),
    state: (s.bindings ?? []).map((b) => b.key).filter((k) => !/Opacity$/.test(k)),
    visual: c.generatedSvg ? "generated module drawing" : "your SVG (sanitized)",
    files: [partFile(s.id), ...(c.generatedSvg ? [] : [svgFile(s.id)])],
    fidelity: AGENT_MADE_LABEL,
    warnings: c.warnings,
    next,
  };
}

function needPartArg(args: Record<string, unknown>, tool: string): Record<string, unknown> {
  const part = args.part;
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    fail("missing-arg", `${tool} needs 'part'`, "no part definition was given", 'pass part: {"id": "soil-sensor", "name": …, "category": "sensor", "description": …, "pins": [...], "behavior": {"kind": "analog-sensor", …}} (see docs/custom-parts.md)');
  }
  return part as Record<string, unknown>;
}

function svgArg(v: unknown, tool: string): string | null | undefined {
  if (v === undefined || v === null) return v as null | undefined;
  if (typeof v !== "string") fail("bad-arg", `${tool}: svg must be a string`, `got ${typeof v}`, "pass the SVG markup as one string, or leave svg out for a generated drawing");
  return v.trim() ? v : null;
}

function baseOf(r: PartRegistry): PartRegistry {
  return isProjectPartRegistry(r) ? r.base : r;
}

async function createPart(args: Record<string, unknown>, x: ExtOpContext): Promise<unknown> {
  const s = x.session;
  const raw = needPartArg(args, "create_part");
  const svg = svgArg(args.svg, "create_part");
  const id = typeof raw.id === "string" ? raw.id : "";
  const base = baseOf(s.registry);
  const builtin = base.get(id);
  if (builtin) {
    fail(
      "part-exists",
      `'${id}' is already a built-in part (${builtin.spec.name})`,
      "agent-made parts cannot replace built-in ones, whose behaviour is tested against real libraries",
      `place it with place_part {"type": "${id}"}; if you need a different part, give it its own id, e.g. "${id}-module"`,
    );
  }
  if (id && existsSync(join(s.dir, partFile(id)))) {
    fail("part-exists", `This project already has a part '${id}'`, `parts/${id}/part.json exists`, `change it with update_part {"id": "${id}", "part": …}, or pick another id`);
  }
  const c = compileOrFail(raw, svg, base);
  const files: Record<string, string | null> = { [partFile(c.part.id)]: JSON.stringify(c.part, null, 2) + "\n" };
  if (!c.generatedSvg) files[svgFile(c.part.id)] = c.svg;
  x.commit(`create_part ${c.part.id}`, s.project, files);
  x.summary(`created part ${c.part.id} (${c.part.behavior.kind}, ${AGENT_MADE_LABEL})`);
  return result(c, `place it: place_part {"type": "${c.part.id}"}; then connect, run and test it like any part. Tell the person it is agent-made: it behaves as you described it, not as a verified model.`);
}

async function updatePart(args: Record<string, unknown>, x: ExtOpContext): Promise<unknown> {
  const s = x.session;
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) fail("missing-arg", "update_part needs 'id'", "no part id was given", 'pass the id of a part made with create_part, e.g. {"id": "soil-sensor", "part": {…}}');
  const pj = join(s.dir, partFile(id));
  if (!existsSync(pj)) {
    const ids = isProjectPartRegistry(s.registry) ? s.registry.projectParts().map((d) => d.spec.id) : [];
    const builtin = baseOf(s.registry).get(id);
    fail(
      "unknown-part-type",
      `This project has no agent-made part '${id}'`,
      builtin ? `'${id}' is a built-in part, and built-in parts cannot be changed` : ids.length ? `its agent-made parts are: ${ids.join(", ")}` : "it has no agent-made parts",
      builtin ? `make your own variant: create_part with another id, e.g. "${id}-custom"` : ids.length ? `use one of those.${didYouMean(id, ids)}` : "make one with create_part",
    );
  }
  let raw: Record<string, unknown>;
  if (args.part !== undefined) {
    raw = needPartArg(args, "update_part");
    if (raw.id !== undefined && raw.id !== id) fail("bad-arg", `update_part cannot rename '${id}' to '${String(raw.id)}'`, "placed parts and wires refer to the type id", `keep "id": "${id}", or create_part a new id and place that instead`);
    raw = { ...raw, id };
  } else {
    try {
      raw = JSON.parse(readFileSync(pj, "utf8")) as Record<string, unknown>;
    } catch (e) {
      fail("bad-part", `parts/${id}/part.json is not valid JSON`, (e as Error).message, `pass the whole definition: update_part {"id": "${id}", "part": {…}}`);
    }
  }
  const sv = join(s.dir, svgFile(id));
  // svg left out: keep the current drawing; null / "": back to the generated one.
  const svg = args.svg === undefined ? (existsSync(sv) ? readFileSync(sv, "utf8") : undefined) : svgArg(args.svg, "update_part");
  const c = compileOrFail(raw, svg, baseOf(s.registry));
  // Wires to pins that no longer exist would break the project.
  const pinIds = new Set(c.def.spec.pins.map((p) => p.id));
  const placed = new Set(s.project.parts.filter((p) => p.type === id).map((p) => p.id));
  const broken = s.project.wires.flatMap((w) => [w.from, w.to].filter((e) => placed.has(e.part) && !pinIds.has(e.pin)).map((e) => `${w.id} (${e.part}.${e.pin})`));
  if (broken.length) {
    fail("pins-in-use", `update_part would remove pins that wires use: ${broken.join(", ")}`, "a wire cannot end on a pin that no longer exists", "disconnect those wires first, or keep those pin ids in the new definition");
  }
  const files: Record<string, string | null> = { [partFile(id)]: JSON.stringify(c.part, null, 2) + "\n" };
  if (!c.generatedSvg) files[svgFile(id)] = c.svg;
  else if (existsSync(sv)) files[svgFile(id)] = null;
  x.commit(`update_part ${id}`, s.project, files);
  x.summary(`updated part ${id}`);
  return result(c, placed.size ? `placed copies (${[...placed].join(", ")}) use the new definition from the next run (the simulation restarts at 0 ms)` : `place it: place_part {"type": "${id}"}`);
}

async function listProjectParts(_args: Record<string, unknown>, x: ExtOpContext): Promise<unknown> {
  const r = x.session.registry;
  const parts: PartDefinition[] = isProjectPartRegistry(r) ? r.projectParts() : [];
  const st = STATE.get(r);
  const problems = projectPartProblems(r);
  return {
    parts: parts
      .map((d) => ({
        type: d.spec.id,
        name: d.spec.name,
        behavior: st?.compiled.get(d.spec.id)?.part.behavior.kind ?? "unknown",
        pins: d.spec.pins.map((p) => p.id).join(" "),
        placed: x.session.project.parts.filter((p) => p.type === d.spec.id).map((p) => p.id),
        fidelity: AGENT_MADE_LABEL,
      }))
      .sort((a, b) => (a.type < b.type ? -1 : 1)),
    ...(problems.length ? { problems } : {}),
    ...(parts.length === 0 ? { hint: "No agent-made parts yet. When search_parts finds nothing that fits, make one with create_part." } : {}),
  };
}

const partSchema = (() => {
  const s = customPartJsonSchema();
  delete s.$schema;
  delete s.$id;
  delete s.title;
  return { ...s, description: "The part, format fabwright-part/1: pins, physical data and one behavior template. docs/custom-parts.md has an example per behavior kind." };
})();

export const agentPartsTools: ToolModule = {
  name: "agentparts",
  tools: [
    {
      name: "create_part",
      title: "Make a missing part",
      description:
        'Make a part the catalog does not have (search_parts found nothing that fits), as data: pins, physical facts and one behaviour template. No code runs; the simulator builds the model from the template. behavior.kind: "digital-input" (PIR, IR obstacle, tilt, hall switch: an output pin HIGH/LOW from a boolean field), "analog-sensor" (soil moisture, gas, flex, force: quantity → voltage curve, optional comparator DO pin), "actuator" (drive "load": pump / motor / solenoid between plus and minus with rated_v and rated_ma; drive "logic": relay or MOSFET module with VCC/GND/IN and optional relay contacts), "i2c-device" (address, registers with raw values or physical fields, WHO_AM_I; read with Wire), "uart-device" (SoftwareSerial line protocol: scripted replies, greeting, periodic stream such as NMEA), "display" (reuse the ssd1306 / st7735 / ili9341 controller with your own resolution or round glass). Visual: pass svg (sanitized: no scripts, no external links; then give size and pin x/y) or leave it out for a generated labelled drawing. Example: {"part": {"id": "soil-moisture-sensor", "name": "Capacitive soil moisture sensor v1.2", "category": "sensor", "description": "Analog soil moisture probe; AOUT falls as the soil gets wetter.", "pins": [{"id": "GND", "type": "ground"}, {"id": "VCC", "type": "power", "voltage": {"min": 3.3, "max": 5.5}}, {"id": "AOUT", "type": "analog"}], "behavior": {"kind": "analog-sensor", "output": "AOUT", "quantity": {"id": "moisture", "unit": "%", "min": 0, "max": 100, "default": 40}, "curve": [{"value": 0, "volts": 3.0}, {"value": 100, "volts": 1.2}]}, "current_ma": {"typ": 5, "max": 8}, "price_usd": 2.5, "dimensions_mm": {"w": 98, "h": 23, "d": 4}}}. The id must not be a built-in type. Returns {type, pins, state, fidelity: "agent-made: behavioral, unverified", warnings, next}; then place_part / connect / run / run_tests it like any part. Always tell the person the part is agent-made and unverified.',
      inputSchema: {
        type: "object",
        properties: {
          part: partSchema,
          svg: { type: "string", description: 'Optional SVG drawing (viewBox = part.size, a <circle data-pin="ID"> per pin is recommended). Scripts, event handlers, <foreignObject> and external links are removed.' },
          why,
        },
        required: ["part"],
      },
      edits: true,
    },
    {
      name: "update_part",
      title: "Change a made part",
      description:
        "Change an agent-made part of this project: pass the whole new definition as part (same id), and/or svg (a new drawing, or null for the generated one). Leave part out to change only the drawing. Refuses to drop pins that wires use (disconnect them first). Placed copies use the new definition from the next run. Undo with undo like any edit.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The part type id given to create_part." },
          part: { type: "object", description: "The whole new definition (fabwright-part/1, same schema as create_part), same id.", additionalProperties: true },
          svg: { type: ["string", "null"], description: "New SVG, or null to use the generated drawing." },
          why,
        },
        required: ["id"],
      },
      edits: true,
    },
    {
      name: "list_project_parts",
      title: "Made parts",
      description: "The agent-made parts of this project (parts/<id>/part.json): {type, name, behavior, pins, placed}, plus problems when a part file cannot be loaded. Built-in parts are listed by search_parts.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    },
  ],
  ops: { create_part: createPart, update_part: updatePart, list_project_parts: listProjectParts },
};
