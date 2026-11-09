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

export const FirmwareBuildSchema = z.object({
  tool: z.literal("arduino-cli"),
  fqbn: z.string().min(1).describe("Fully qualified board name, e.g. 'arduino:avr:uno'."),
});

export const FirmwareSchema = z.object({
  board: Id.describe("Part id of the MCU board that runs this firmware."),
  dir: z.literal("firmware").default("firmware").describe("Firmware folder, relative to jumper.json."),
  sketch: z.string().optional().describe("Main source file inside dir, e.g. 'blink.ino'."),
  artifact: z.string().min(1).describe("Built binary (.hex or .bin), relative to jumper.json."),
  build: FirmwareBuildSchema.optional(),
  libraries: z
    .array(z.string().min(1))
    .optional()
    .describe("Arduino libraries the sketch needs, 'Name' or 'Name@version', e.g. ['Adafruit SSD1306@2.5.15', 'Servo']. Unversioned names get Jumper's pinned version."),
});

export { ScenarioSchema };

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
