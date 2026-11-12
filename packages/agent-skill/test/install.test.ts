import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { AGENTS_PATH, CLAUDE_PATH, installProjectFiles, MARKER, renderPrompt, renderSkillMd, SKILL_NAME, SKILL_PATH } from "../src/index.ts";

const tools = ["plan_device", "check_fit", "propose_layout", "design_case", "export_manufacturing", "read_file"];
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jumper-skill-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the project-level agent files", () => {
  it("SKILL.md has the frontmatter Claude Code reads (name, a description that says when to use it)", () => {
    const md = renderSkillMd({ tools });
    const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
    expect(m).not.toBeNull();
    const fm = parse(m![1]!) as { name: string; description: string };
    expect(fm.name).toBe(SKILL_NAME);
    expect(fm.description).toMatch(/what to buy, what to print and how to put it together/);
    expect(fm.description.length).toBeLessThan(1024);
    expect(md).toContain(MARKER);
  });

  it("writes the skill and AGENTS.md inside the project, then reports unchanged; a stale Jumper copy is updated", () => {
    const d = tmp();
    const a = installProjectFiles(d, { tools, projectName: "Smiley keychain" });
    expect(a.files.map((f) => [f.path, f.action])).toEqual([[SKILL_PATH, "written"], [AGENTS_PATH, "written"], [CLAUDE_PATH, "written"]]);
    expect(readFileSync(join(d, CLAUDE_PATH), "utf8")).toMatch(/^<!-- Written by Jumper[\s\S]*\n@AGENTS\.md\n$/);
    expect(readFileSync(join(d, AGENTS_PATH), "utf8")).toMatch(/^<!-- Written by Jumper[\s\S]*# AGENTS.md: Smiley keychain/);
    expect(installProjectFiles(d, { tools, projectName: "Smiley keychain" }).files.every((f) => f.action === "unchanged")).toBe(true);
    // a newer Jumper (here: one with get_build_kit) rewrites its own files
    const b = installProjectFiles(d, { tools: [...tools, "get_build_kit"], projectName: "Smiley keychain" });
    expect(b.files.map((f) => f.action)).toEqual(["updated", "updated", "unchanged"]);
    expect(readFileSync(join(d, SKILL_PATH), "utf8")).toMatch(/`get_build_kit`/);
  });

  it("never overwrites an AGENTS.md or skill someone else wrote, unless force; says why and the fix", () => {
    const d = tmp();
    writeFileSync(join(d, AGENTS_PATH), "# my own notes\n");
    mkdirSync(join(d, ".claude/skills/jumper-hardware"), { recursive: true });
    writeFileSync(join(d, SKILL_PATH), "---\nname: jumper-hardware\ndescription: mine\n---\n");
    const r = installProjectFiles(d, { tools });
    expect(r.files.map((f) => f.action)).toEqual(["kept", "kept", "written"]);
    expect(r.files[1]!.why).toMatch(/not written by Jumper.*Fix: .*--force/);
    expect(readFileSync(join(d, AGENTS_PATH), "utf8")).toBe("# my own notes\n");
    const f = installProjectFiles(d, { tools, force: true });
    expect(f.files.map((x) => x.action)).toEqual(["updated", "updated", "unchanged"]);
  });

  it("prompts: design-device needs a goal; an unknown prompt names the real ones", () => {
    expect(() => renderPrompt("design-device", {}, { tools })).toThrow(/needs a goal.*Fix:/);
    expect(() => renderPrompt("nope", {}, { tools })).toThrow(/No prompt 'nope'.*design-device, build-kit, design-for-assembly/);
    expect(renderPrompt("design-device", { goal: "a tiny lamp" }, { tools })).toMatch(/^I want to build: a tiny lamp/);
  });
});
