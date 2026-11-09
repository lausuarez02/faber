import { z } from "zod";
import { ProjectSchema } from "./schema.ts";
import { ScenarioStepSchema } from "./scenario.ts";

export const JSON_SCHEMA_ID = "urn:jumper:project-format:1";

/** JSON Schema (draft 2020-12) for jumper.json, describing what may be written (input side). */
export function projectJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ProjectSchema, { io: "input", target: "draft-2020-12" }) as Record<string, unknown>;
  // Scenario steps are validated one by one at runtime (precise errors); document their shape here.
  const step = z.toJSONSchema(ScenarioStepSchema, { io: "input", target: "draft-2020-12" }) as Record<string, unknown>;
  delete step.$schema;
  const props = schema.properties as Record<string, { items?: { properties?: Record<string, Record<string, unknown>> } }> | undefined;
  const steps = props?.scenarios?.items?.properties?.steps;
  if (steps) steps.items = step;
  return { $id: JSON_SCHEMA_ID, title: "Jumper project (jumper.json)", ...schema };
}
