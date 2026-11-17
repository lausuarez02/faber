// Agent-made parts (decision 0003, C4). Browser-safe; the disk loader is "@faber/parts/node".
export { BEHAVIOR_KINDS, CUSTOM_PART_FORMAT, CustomPartSchema, DISPLAY_CONTROLLERS, customPartJsonSchema, type Behavior, type BehaviorKind, type CustomPart, type CustomPartInput, type DisplayController } from "./schema.ts";
export { AGENT_MADE_LABEL, compileCustomPart, customPartOf, customUsageOf, CustomPartError, fidelityFor, isAgentMade, type CompiledCustomPart, type CompileOptions } from "./compile.ts";
export { sanitizeSvg, SvgError, type SanitizeResult } from "./sanitize.ts";
export { withProjectParts, type ProjectPartRegistry } from "./overlay.ts";
export { encodeField, interpolate } from "./models.ts";
