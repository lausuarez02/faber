import { z } from "zod";
import { ProjectSchema } from "./schema.ts";

export const JSON_SCHEMA_ID = "urn:jumper:project-format:1";

/** JSON Schema (draft 2020-12) for jumper.json, describing what may be written (input side). */
export function projectJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ProjectSchema, { io: "input", target: "draft-2020-12" }) as Record<string, unknown>;
  return { $id: JSON_SCHEMA_ID, title: "Jumper project (jumper.json)", ...schema };
}
