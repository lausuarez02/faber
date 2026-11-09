import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToolDocs } from "../src/docs.ts";

describe("docs/mcp-tools.md", () => {
  it("matches the tool definitions (run `pnpm --filter @jumper/mcp gen:docs` after changing a tool)", () => {
    const onDisk = readFileSync(fileURLToPath(new URL("../../../docs/mcp-tools.md", import.meta.url)), "utf8");
    expect(onDisk).toBe(renderToolDocs());
  });
});
