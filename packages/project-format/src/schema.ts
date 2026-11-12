import { z } from "zod";
import { ScenarioSchema } from "./scenario.ts";

/** The only format version this package reads and writes. */
export const FORMAT_VERSION = "jumper/1" as const;

/** Ids of parts and wires: start with a letter, then letters, digits, `_` or `-`. */
const Id = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "must start with a letter and contain only letters, digits, '_' or '-'");

export const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const RotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

export const PropValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const PartInstanceSchema = z.object({
  id: Id.describe("Unique id of this part in the project, e.g. 'led1'."),
  type: z.string().min(1).describe("Part type id from the parts registry, e.g. 'led' or 'arduino-uno'."),
  x: z.number().describe("Canvas x of the part's top-left corner, in canvas px."),
  y: z.number().describe("Canvas y of the part's top-left corner, in canvas px."),
  rotation: RotationSchema.default(0).describe("Clockwise rotation in degrees."),
  props: z.record(z.string(), PropValueSchema).optional().describe("Overrides for the part's props."),
  standIn: z
    .string()
    .min(1)
    .optional()
    .describe("Set when this part stands in for a real part Jumper does not have, e.g. 'potentiometer' standing in for 'capacitive soil moisture sensor'. Exports (BOM, WIRING) print the real part and a STAND-IN note."),
});

export const PinRefSchema = z.object({
  part: Id.describe("Part instance id."),
  pin: z.string().min(1).describe("Pin id from the part's part.json."),
});

export const WireSchema = z.object({
  id: Id,
  from: PinRefSchema,
  to: PinRefSchema,
  color: z.string().optional().describe("CSS color of the wire, e.g. '#FF4D2E'."),
  waypoints: z.array(PointSchema).optional().describe("Bend points between the two pins, in canvas px."),
});

/**
 * Round 10 (languages): the firmware language. Each language is one toolchain per chip family plus
 * a rule that turns its output into the image the board's emulator loads (docs/firmware-languages.md).
 * "arduino" is the default, so every project written before round 10 means what it meant.
 */
export const FIRMWARE_LANGUAGES = ["arduino", "micropython", "esp-idf", "platformio", "rust", "zephyr"] as const;
export const FirmwareLanguageSchema = z.enum(FIRMWARE_LANGUAGES);

/** The build driver for each language (`firmware.build.tool`). */
export const BUILD_TOOLS = ["arduino-cli", "micropython", "esp-idf", "platformio", "cargo", "west"] as const;

export const FirmwareBuildSchema = z
  .object({
    tool: z.enum(BUILD_TOOLS).describe("Build driver: arduino-cli (Arduino), micropython (no compile: firmware + filesystem image), esp-idf (idf.py), platformio (pio run), cargo (Rust), west (Zephyr)."),
    fqbn: z.string().min(1).optional().describe("arduino-cli: fully qualified board name, e.g. 'arduino:avr:uno'. Required for arduino-cli."),
    target: z.string().min(1).optional().describe("esp-idf: IDF target, e.g. 'esp32', 'esp32c3' (default: the board's chip)."),
    env: z.string().min(1).optional().describe("platformio: the [env:<name>] to build (default: the first env in platformio.ini)."),
    firmware: z.string().min(1).optional().describe("micropython: the MicroPython firmware build to flash, e.g. 'RPI_PICO@1.29.0' (default: the board's pinned build)."),
  })
  .superRefine((b, ctx) => {
    if (b.tool === "arduino-cli" && !b.fqbn) ctx.addIssue({ code: "custom", path: ["fqbn"], message: "arduino-cli builds need an fqbn, e.g. 'arduino:avr:uno'" });
  });

export const FirmwareSchema = z.object({
  board: Id.describe("Part id of the MCU board that runs this firmware."),
  language: FirmwareLanguageSchema.optional().describe("Firmware language (default 'arduino'; a .py main file means 'micropython'). See docs/firmware-languages.md for what runs on which board."),
  dir: z.literal("firmware").default("firmware").describe("Firmware folder, relative to jumper.json."),
  sketch: z.string().optional().describe("Main source file inside dir: 'blink.ino' (Arduino), 'main.py' (MicroPython), 'main/main.c' (ESP-IDF), 'platformio.ini' (PlatformIO)."),
  artifact: z.string().min(1).describe("Built binary (.hex or .bin), relative to jumper.json."),
  build: FirmwareBuildSchema.optional(),
  libraries: z
    .array(z.string().min(1))
    .optional()
    .describe("Arduino libraries the sketch needs, 'Name' or 'Name@version', e.g. ['Adafruit SSD1306@2.5.15', 'Servo']. Unversioned names get Jumper's pinned version."),
});

/** The language a firmware block means: explicit, else from the build tool, else from the main file, else Arduino. */
export function firmwareLanguage(fw: { language?: FirmwareLanguage | undefined; sketch?: string | undefined; build?: { tool: (typeof BUILD_TOOLS)[number] } | undefined } | undefined): FirmwareLanguage {
  if (!fw) return "arduino";
  if (fw.language) return fw.language;
  const byTool: Partial<Record<(typeof BUILD_TOOLS)[number], FirmwareLanguage>> = { micropython: "micropython", "esp-idf": "esp-idf", platformio: "platformio", cargo: "rust", west: "zephyr" };
  if (fw.build && byTool[fw.build.tool]) return byTool[fw.build.tool]!;
  const s = fw.sketch ?? "";
  if (s.endsWith(".py")) return "micropython";
  if (/(^|\/)platformio\.ini$/.test(s)) return "platformio";
  if (/(^|\/)Cargo\.toml$/.test(s)) return "rust";
  return "arduino";
}

export type FirmwareLanguage = z.infer<typeof FirmwareLanguageSchema>;

export { ScenarioSchema };

// --- Round 6 (decision 0004): how the device is built and housed. All optional. -----------------

/** R2: how it is put together. "soldered" = hand-wired / perfboard in a case (wire lengths, no breadboard or dupont in the BOM). */
export const AssemblyStyleSchema = z.enum(["breadboard", "soldered"]);

/** R2: the project's power situation the simulation and check_design use. */
export const PowerOptionsSchema = z.object({
  usb: z
    .boolean()
    .optional()
    .describe("A USB cable is plugged into the board (default true: the board is powered from USB, as before round 6). false = it runs from its battery path only."),
});

/**
 * R3: case shapes. The five presets are starting points; "custom" takes any outline the agent or
 * the person draws (enclosure.outline) at any size (enclosure.size_mm). Round 7: there is no
 * preset per object (no "egg"): an egg, a heart or a bean is a custom outline.
 */
export const CASE_SHAPES = ["rounded-box", "pill", "pebble", "puck", "keychain", "custom"] as const;
export const CaseShapeSchema = z.enum(CASE_SHAPES);

/** R3: case faces, seen from the person holding it with the screen (front) towards them. */
export const CASE_FACES = ["front", "back", "left", "right", "top", "bottom"] as const;

export const CaseParamsSchema = z.object({
  wall_mm: z.number().min(1.2).max(5).optional().describe("Wall thickness, mm (default 1.6, min 1.2)."),
  corner_radius_mm: z.number().min(0).max(30).optional().describe("Outer corner radius for rounded-box / keychain, mm (default 4)."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Shell colour for renders and 3MF, e.g. '#F2EDE4'."),
  lanyard_hole: z.boolean().optional().describe("Add a lanyard / keyring hole (default true for keychain)."),
  belt_clip: z.boolean().optional().describe("Add a belt clip on the back (default false)."),
  closure: z.enum(["snap", "screws"]).optional().describe("snap = snap-fit lip; screws = M2 screws into heat-set inserts (default snap)."),
  tolerance_mm: z.number().min(0).max(1).optional().describe("Clearance between mating parts, mm (default 0.2 for FDM)."),
  process: z.enum(["fdm", "resin", "injection"]).optional().describe("Target process for notes and tolerances (default fdm)."),
  gap_mm: z.number().min(0).max(10).optional().describe("Free room around parts for wires, mm (default 1.5)."),
  // Round 7: 3D finish, for every shape.
  edge_radius_front_mm: z.union([z.number().min(0).max(40), z.literal("auto")]).optional().describe("Round-over of the front rim, mm, or 'auto' (default: a share of the depth per shape; custom and pebble are round all over). Clamped where a side opening needs a straight wall."),
  edge_radius_back_mm: z.union([z.number().min(0).max(40), z.literal("auto")]).optional().describe("Round-over of the back rim, mm, or 'auto'."),
  dome_mm: z.union([z.number().min(0).max(15), z.literal("auto")]).optional().describe("How far the front and back faces bulge out (a sphere cap with a flat print pad), mm, or 'auto' (pebble and custom about 1 mm, the other shapes flat)."),
  dome_back_mm: z.union([z.number().min(0).max(15), z.literal("auto")]).optional().describe("The back face's bulge when it differs from dome_mm, mm."),
  depth_mm: z.union([z.number().min(6).max(120), z.literal("auto")]).optional().describe("Overall thickness front to back, mm, or 'auto' (the thinnest that holds the parts). Same as size_mm.d."),
});

export const CasePlacementSchema = z.object({
  face: z.enum([...CASE_FACES, "inside"]).optional().describe("Face the part's exposed feature goes on; 'inside' = no opening."),
  x_mm: z.number().optional().describe("Position on that face from its centre, mm (+x right / +y up as you look at that face)."),
  y_mm: z.number().optional(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional().describe("Turn on that face, degrees."),
  layer: z.number().int().min(0).max(9).optional().describe("Stack layer from the front (0 = right behind the front wall)."),
  on_edge: z.boolean().optional().describe("Stand the part on its edge (its board plane front to back) instead of lying flat: narrower, thicker."),
});

/**
 * Round 7: a custom case outline, the FRONT view of the case in mm. Either an SVG path (M / L / H /
 * V / C / S / Q / T / A / Z, absolute or relative; SVG's y points DOWN, as in any drawing program)
 * or a list of points in the case frame (y points UP) with optional smoothing (a closed centripetal
 * Catmull-Rom spline through the points). One closed shape, not crossing itself.
 */
export const CaseOutlineSchema = z.union([
  z.string().min(2).max(20000).describe("SVG path data of the front outline in mm, e.g. 'M 0 -40 C 24 -40 30 0 30 10 C 30 30 16 40 0 40 C -16 40 -30 30 -30 10 C -30 0 -24 -40 0 -40 Z' (y down, like SVG)."),
  z.object({
    points: z.array(z.tuple([z.number(), z.number()])).min(3).max(400).describe("Outline points [x, y] in mm, y UP (the top of the device is +y)."),
    smooth: z.boolean().optional().describe("true = a smooth closed curve through the points (default true); false = straight lines (corners are rounded to stay printable)."),
  }),
]);

export const CaseSizeSchema = z.object({
  w: z.number().min(15).max(250).optional().describe("Overall width (x), mm."),
  h: z.number().min(15).max(250).optional().describe("Overall height (y), mm."),
  d: z.number().min(6).max(120).optional().describe("Overall thickness (z, front to back), mm."),
});

export const EnclosureSchema = z.object({
  shape: CaseShapeSchema,
  params: CaseParamsSchema.optional(),
  front: z.string().optional().describe("Part id whose screen faces out of the front (default: the first display)."),
  placements: z.record(z.string(), CasePlacementSchema).optional().describe("Per part id: where it goes. Parts left out are auto-packed."),
  exclude: z.array(z.string()).optional().describe("Part ids that are not inside the case (e.g. a test resistor, an external sensor on a cable)."),
  outline: CaseOutlineSchema.optional().describe("Round 7, shape 'custom' only: the front outline (SVG path in mm, or {points, smooth}). Any shape; Jumper fits the parts inside it."),
  size_mm: CaseSizeSchema.optional().describe("Fixed overall size (w x h x d, mm); the outline is scaled to it and the case is exactly that size. Leave a value out for 'auto' (the smallest that holds the parts). Parts that do not fit are reported with smaller swaps (check_fit)."),
  layout: z.enum(["auto", "thinnest", "smallest", "balanced"]).optional().describe("Round 8: how the parts are distributed inside. Jumper proposes three layouts automatically (propose_layout / check_fit): 'thinnest' (fewest layers, flat first), 'smallest' (least volume), 'balanced' (pocket-friendly: thickness over 18 mm and a footprint over 110 x 70 mm weigh up). 'auto' (default) = balanced. Pin a part with placements (x_mm / y_mm, layer) and the rest is arranged around it."),
});

export type AssemblyStyle = z.infer<typeof AssemblyStyleSchema>;
export type PowerOptions = z.infer<typeof PowerOptionsSchema>;
export type CaseShape = z.infer<typeof CaseShapeSchema>;
export type CaseParams = z.infer<typeof CaseParamsSchema>;
export type CasePlacement = z.infer<typeof CasePlacementSchema>;
export type Enclosure = z.infer<typeof EnclosureSchema>;
export type CaseOutline = z.infer<typeof CaseOutlineSchema>;
export type CaseSize = z.infer<typeof CaseSizeSchema>;

/**
 * Round 10 (network): how the simulated device reaches the network (packages/device-net). Plain,
 * committed data: secrets by NAME only (values come from the environment or the git-ignored .env).
 * Deep checks (with why / fix) are in @jumper/device-net parseNetworkConfig.
 */
export const NetworkAllowSchema = z
  .object({
    host: z.string().min(1).describe('Host the device may reach in internet mode: "api.example.com" or "*.example.com" (no scheme, no path).'),
    ports: z.array(z.number().int().min(1).max(65535)).optional().describe("Ports (default [443, 80])."),
    tls: z.enum(["inspect", "passthrough"]).optional().describe("inspect (default): Jumper terminates TLS with its sandbox CA, so it can log paths, add secrets and record cassettes. passthrough: bytes go end to end with the real certificate."),
    secrets: z.array(z.string()).optional().describe("Secret names this host may receive."),
    headers: z.record(z.string(), z.string()).optional().describe('Headers added to every request to this host, e.g. {"Authorization": "Bearer {{secret:OPENAI_API_KEY}}"}. Never a literal key.'),
  })
  .strict();

export const NetworkSchema = z
  .object({
    mode: z.enum(["offline", "mock", "internet"]).optional().describe("offline: Wi-Fi up, nothing answers. mock (default; run_tests always uses it): only mocks and cassettes answer. internet: hosts in allow also reach the real internet."),
    allow: z.array(NetworkAllowSchema).optional(),
    secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "secret names are UPPER_SNAKE_CASE, e.g. OPENAI_API_KEY")).optional().describe("Secret NAMES the project needs; values come from the environment or the project's .env (git-ignored), never from jumper.json."),
    mocks: z.string().optional().describe("Mock APIs file, relative to jumper.json (default network/mocks.json)."),
    cassette: z.string().optional().describe("Cassette name (network/cassettes/<name>.json) replayed in mock mode, recorded in internet mode with record: true."),
    record: z.boolean().optional(),
    wifi: z
      .object({
        ssid: z.string().min(1).max(32).describe("The network the sandbox plays; a sketch asking for another SSID finds no access point."),
        password: z.string().max(64).optional().describe("Only to rehearse a wrong password: the sandbox refuses a different one. Leave out to accept any."),
        rssi: z.number().int().min(-100).max(0).optional().describe("Signal strength the firmware reads (default -55 dBm)."),
      })
      .strict()
      .optional()
      .describe("The sandbox Wi-Fi. Leave out: any SSID joins."),
    relay: z
      .object({
        requests_per_minute: z.number().int().min(1).max(6000).optional().describe("Requests one device may send per minute (default 60)."),
        max_request_kb: z.number().int().min(1).max(102400).optional().describe("Largest request body in KiB (default 1024)."),
        max_response_kb: z.number().int().min(1).max(1048576).optional().describe("Largest answer or WebSocket stream in KiB (default 32768)."),
        max_stream_seconds: z.number().int().min(1).max(3600).optional().describe("How long one answer or WebSocket may stream (default 300 s)."),
      })
      .strict()
      .optional()
      .describe("Round 13: limits of the API relay (jumper relay): the real device's relay and the simulator's sandbox relay use the same ones. See docs/api-relay.md."),
  })
  .strict();
export type NetworkSettings = z.infer<typeof NetworkSchema>;

export const ProjectSchema = z
  .object({
    format: z.literal(FORMAT_VERSION),
    name: z.string().min(1),
    description: z.string().optional(),
    parts: z.array(PartInstanceSchema).default([]),
    wires: z.array(WireSchema).default([]),
    firmware: FirmwareSchema.optional(),
    scenarios: z.array(ScenarioSchema).default([]),
    world: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Physical world for robots (arena, obstacles, robot / arm binding). Validated by @jumper/physics parseWorld; kept as-is here."),
    assembly: AssemblyStyleSchema.optional().describe("How it is built: 'breadboard' (default for Uno / Nano projects) or 'soldered' (hand-wired in a case; default when there is an enclosure or a pocket board)."),
    power: PowerOptionsSchema.optional().describe("Power situation for the simulation and check_design (USB plugged in or not)."),
    enclosure: EnclosureSchema.optional().describe("The case: shape, parameters and where parts go. Written by design_case / update_case; files are generated into case/."),
    network: NetworkSchema.optional().describe("Round 10: the device network (Wi-Fi, DNS, mocks, internet allow list, secrets by name). See docs/network.md."),
  })
  .superRefine((project, ctx) => {
    const partIds = new Set<string>();
    project.parts.forEach((part, i) => {
      if (partIds.has(part.id)) {
        ctx.addIssue({ code: "custom", path: ["parts", i, "id"], message: `duplicate part id '${part.id}'` });
      }
      partIds.add(part.id);
    });
    const wireIds = new Set<string>();
    project.wires.forEach((wire, i) => {
      if (wireIds.has(wire.id)) {
        ctx.addIssue({ code: "custom", path: ["wires", i, "id"], message: `duplicate wire id '${wire.id}'` });
      }
      wireIds.add(wire.id);
      for (const end of ["from", "to"] as const) {
        if (!partIds.has(wire[end].part)) {
          ctx.addIssue({
            code: "custom",
            path: ["wires", i, end, "part"],
            message: `wire '${wire.id}' points at part '${wire[end].part}', which is not in parts`,
          });
        }
      }
    });
    if (project.firmware && !partIds.has(project.firmware.board)) {
      ctx.addIssue({
        code: "custom",
        path: ["firmware", "board"],
        message: `firmware board '${project.firmware.board}' is not in parts`,
      });
    }
  });

export type Point = z.infer<typeof PointSchema>;
export type Rotation = z.infer<typeof RotationSchema>;
export type PropValue = z.infer<typeof PropValueSchema>;
export type PartInstance = z.infer<typeof PartInstanceSchema>;
export type PinRef = z.infer<typeof PinRefSchema>;
export type Wire = z.infer<typeof WireSchema>;
export type FirmwareBuild = z.infer<typeof FirmwareBuildSchema>;
export type Firmware = z.infer<typeof FirmwareSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
/** A parsed, validated project (defaults filled in). */
export type Project = z.infer<typeof ProjectSchema>;
/** What you may write before defaults are applied (e.g. rotation omitted). */
export type ProjectInput = z.input<typeof ProjectSchema>;
