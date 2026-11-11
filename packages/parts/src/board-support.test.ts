import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listParts } from "./index.ts";
import { BOARD_SUPPORT, SUPPORT_AREAS, boardSupportMarkdown } from "./board-support.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("board support matrix (docs/boards.md)", () => {
  it("has exactly one row per board part, with the part's backend", () => {
    const boards = listParts("board").filter((d) => d.spec.mcu);
    expect(BOARD_SUPPORT.map((b) => b.board).sort()).toEqual(boards.map((d) => d.spec.id).sort());
    for (const b of BOARD_SUPPORT) expect(b.backend, b.board).toBe(boards.find((d) => d.spec.id === b.board)!.spec.mcu!.backend);
  });

  it("every verified or partial cell names a test file that exists; every other cell says why", () => {
    for (const b of BOARD_SUPPORT) {
      for (const a of SUPPORT_AREAS) {
        const c = b.areas[a];
        if (c.status === "verified" || c.status === "partial") {
          expect(c.test, `${b.board}.${a}`).toBeTruthy();
          expect(existsSync(root + c.test), `${b.board}.${a}: ${c.test}`).toBe(true);
        }
        if (c.status !== "verified") expect(c.note, `${b.board}.${a} needs a note`).toBeTruthy();
      }
    }
  });

  it("a board that does not boot verified is not available, and planned boards show as planned", () => {
    for (const b of BOARD_SUPPORT) {
      const spec = listParts("board").find((d) => d.spec.id === b.board)!.spec;
      if (b.areas.boots.status !== "verified") expect(spec.availability?.status, b.board).toBe("planned");
    }
  });

  it("docs/boards.md is the generated table (run pnpm gen)", () => {
    const names = Object.fromEntries(listParts("board").map((d) => [d.spec.id, { name: d.spec.name, ...(d.spec.availability ? { availability: d.spec.availability } : {}) }]));
    expect(readFileSync(root + "docs/boards.md", "utf8")).toBe(boardSupportMarkdown(names));
  });
});
