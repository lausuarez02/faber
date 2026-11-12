import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderAgentSkillFiles, renderToolDocs } from "../src/docs.ts";

describe("docs/mcp-tools.md", () => {
  it("matches the tool definitions (run `pnpm --filter @jumper/mcp gen:docs` after changing a tool)", () => {
    const onDisk = readFileSync(fileURLToPath(new URL("../../../docs/mcp-tools.md", import.meta.url)), "utf8");
    expect(onDisk).toBe(renderToolDocs());
  });

  it("the plugin's SKILL.md and docs/hardware-guide.md match packages/agent-skill (run `pnpm gen`)", () => {
    for (const [rel, text] of Object.entries(renderAgentSkillFiles())) {
      const onDisk = readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");
      expect(onDisk, rel).toBe(text);
    }
  });
});
