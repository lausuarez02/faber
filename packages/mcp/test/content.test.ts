import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toContent } from "../src/server.ts";

// Round 5 (decision 0003, C5): a screenshot comes back as an image the agent can show, plus its absolute path.
describe("screenshot content", () => {
  it("inlines the PNG and keeps the absolute path and viewer link in the text", () => {
    const dir = mkdtempSync(join(tmpdir(), "jumper-content-"));
    try {
      const path = join(dir, "shot.png");
      writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
      const c = toContent("screenshot", { path, format: "png", viewer_url: "http://localhost:7780/v/abc" }, true);
      expect(c[0]).toMatchObject({ type: "text" });
      expect(JSON.parse((c[0] as { text: string }).text)).toMatchObject({ path, viewer_url: "http://localhost:7780/v/abc" });
      expect(c[1]).toEqual({ type: "image", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64"), mimeType: "image/png" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
