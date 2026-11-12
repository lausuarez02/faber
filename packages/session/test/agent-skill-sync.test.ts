// Round 12 skill: the hardware know-how in packages/agent-skill is rendered into the server
// instructions, MCP prompts, the project skill, AGENTS.md and the plugin. These tests fail when the
// skill names a tool Jumper does not have, or when a rule in it contradicts the server instructions
// or a tool description.
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOP, BUILD_KIT_ANSWER, MENTIONED_TOOLS, POCKET_MAX_MM, PROMPTS, RULES, renderAgentsMd, renderGuide, renderInstructionsBlock, renderPrompt, renderSkillMd, SKILL_PATH } from "@jumper/agent-skill";
import { AGENT_LOOP, ProjectSession, TOOLS } from "../src/index.ts";

const names = TOOLS.map((t) => t.name);
const OPTIONAL = new Set([...LOOP, BUILD_KIT_ANSWER].flatMap((s) => s.needs ?? []));
const REPO_AGENTS = readFileSync(new URL("../../../AGENTS.md", import.meta.url), "utf8");

/** Every word in a schema (property names, nested), so `dome_mm` or `size_mm` in the text is not mistaken for a tool. */
function schemaWords(): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    for (const [k, x] of Object.entries(v)) {
      if (k === "properties" && x && typeof x === "object") for (const p of Object.keys(x)) out.add(p);
      walk(x);
    }
  };
  for (const t of TOOLS) walk(t.inputSchema);
  return out;
}

const faces = (tools: readonly string[]) => ({
  instructions: renderInstructionsBlock({ tools }),
  skill: renderSkillMd({ tools }),
  agents: renderAgentsMd({ tools }),
  guide: renderGuide({ tools }),
  ...Object.fromEntries(PROMPTS.map((p) => [`prompt:${p.name}`, renderPrompt(p.name, { goal: "a keychain with a screen" }, { tools })])),
});

// snake_case words that read like an operation (verb_noun): each must be a real tool or a schema field
const OP_WORD = /\b(?:get|set|check|design|update|export|propose|plan|run|read|write|search|place|new|inject|add|try|mark|create|list|delete|restore|record|viewer|move|accept|reject|fidelity|interact)_[a-z0-9_]+\b/g;

describe("the hardware skill stays in sync with the tools", () => {
  it("every tool the knowledge names exists (optional ones only when they exist, with a fallback otherwise)", () => {
    faces([...names, ...OPLIST()]); // render every branch so every mention is collected
    faces(names);
    const unknown = [...MENTIONED_TOOLS].filter((n) => !names.includes(n) && !OPTIONAL.has(n));
    expect(unknown, `tools named in packages/agent-skill that Jumper does not have: ${unknown.join(", ")}`).toEqual([]);
    for (const s of [...LOOP, BUILD_KIT_ANSWER]) if (s.needs?.length) expect(s.fallback, `${s.title} needs ${s.needs.join(", ")} and must say what to do without it`).toBeDefined();
  });

  it("rendered for this Jumper, no face mentions an operation that is not a tool or a field", () => {
    const fields = schemaWords();
    for (const [face, text] of Object.entries(faces(names))) {
      const bad = [...new Set(text.match(OP_WORD) ?? [])].filter((w) => !names.includes(w) && !fields.has(w));
      expect(bad, `${face} names ${bad.join(", ")}`).toEqual([]);
    }
  });

  it("optional tools (get_build_kit, get_assembly_plan) are named exactly when Jumper has them", () => {
    const text = Object.values(faces(names)).join("\n");
    for (const n of OPTIONAL) expect(text.includes(n), n).toBe(names.includes(n));
  });

  it("no rule contradicts the server instructions, AGENTS.md or a tool description", () => {
    const everywhere = { AGENT_LOOP, repoAgents: REPO_AGENTS.replace(/\s+/g, " "), ...faces(names), ...Object.fromEntries(TOOLS.map((t) => [`tool:${t.name}`, `${t.description} ${JSON.stringify(t.inputSchema)}`])) };
    for (const r of RULES) {
      for (const [face, text] of Object.entries({ AGENT_LOOP, skill: renderSkillMd({ tools: names }), agents: renderAgentsMd({ tools: names }) })) {
        if (face === "AGENT_LOOP" && !r.short) continue;
        for (const re of r.mustSay) expect(text, `${face} must carry rule ${r.id} (${re})`).toMatch(re);
      }
      for (const [face, text] of Object.entries(everywhere)) for (const re of r.mustNotSay ?? []) expect(text, `${face} contradicts rule ${r.id} (${re})`).not.toMatch(re);
    }
  });

  it(`one pocket number everywhere: ${POCKET_MAX_MM} mm`, () => {
    const all = [AGENT_LOOP, REPO_AGENTS, renderSkillMd({ tools: names }), ...TOOLS.map((t) => t.description)].join("\n");
    const nums = [...all.matchAll(/(\d+) mm thick or less/g)].map((m) => Number(m[1]));
    expect(nums.length).toBeGreaterThan(2);
    expect(new Set(nums)).toEqual(new Set([POCKET_MAX_MM]));
  });

  it("the server instructions carry the design-for-assembly block, rendered from the same source", () => {
    expect(AGENT_LOOP).toContain(renderInstructionsBlock({ tools: names }));
    // the loop order the skill teaches: fit and layout before the case, the build kit last
    const g = renderGuide({ tools: names });
    expect(g.indexOf("`check_fit`")).toBeLessThan(g.indexOf("`design_case`"));
    expect(g.indexOf("`propose_layout`")).toBeLessThan(g.indexOf("**Design the case.**"));
    expect(g.indexOf("**Think assembly.**")).toBeLessThan(g.indexOf("**Design the case.**"));
  });
});

describe("new_project gives the project the skill", () => {
  it("writes .claude/skills/jumper-hardware/SKILL.md and AGENTS.md, outside the undo history; JUMPER_AGENT_FILES=0 skips it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jumper-skill-proj-"));
    const s = new ProjectSession({ dir, actor: "test" });
    try {
      const r = (await s.call("new_project", { template: "blank", name: "Smiley keychain" })) as { agent_files?: string[] };
      expect(r.agent_files).toEqual([SKILL_PATH, "AGENTS.md", "CLAUDE.md"]);
      expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toMatch(/@AGENTS\.md/);
      expect(readFileSync(join(dir, SKILL_PATH), "utf8")).toMatch(/^---\nname: jumper-hardware\n/);
      expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toMatch(/AGENTS.md: Smiley keychain/);
      const steps = (await s.call("list_steps", {})) as { steps: { label?: string; changes?: unknown }[] };
      expect(JSON.stringify(steps)).not.toMatch(/SKILL\.md|AGENTS\.md/);
    } finally {
      s.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
    const dir2 = mkdtempSync(join(tmpdir(), "jumper-skill-proj-"));
    const prev = process.env.JUMPER_AGENT_FILES;
    process.env.JUMPER_AGENT_FILES = "0";
    const s2 = new ProjectSession({ dir: dir2, actor: "test" });
    try {
      const r = (await s2.call("new_project", { template: "blank" })) as { agent_files?: string[] };
      expect(r.agent_files).toBeUndefined();
      expect(existsSync(join(dir2, SKILL_PATH))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.JUMPER_AGENT_FILES;
      else process.env.JUMPER_AGENT_FILES = prev;
      s2.dispose();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("read_file reads the case and build pack's text files, not binaries, not outside the project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jumper-skill-read-"));
    const s = new ProjectSession({ dir, actor: "test" });
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(dir, "manufacturing/pack-v1"), { recursive: true });
      writeFileSync(join(dir, "manufacturing/pack-v1/BOM.md"), "| 1 | XIAO |\n");
      writeFileSync(join(dir, "manufacturing/pack-v1/case.stl"), "solid x");
      expect(await s.call("read_file", { path: "manufacturing/pack-v1/BOM.md" })).toEqual({ path: "manufacturing/pack-v1/BOM.md", content: "| 1 | XIAO |\n" });
      await expect(s.call("read_file", { path: "manufacturing/pack-v1/case.stl" })).rejects.toThrow(/only text files.*read the \.md/);
      await expect(s.call("read_file", { path: "case/../../etc/passwd.txt" })).rejects.toThrow();
      await expect(s.call("read_file", { path: "case/PRINT.md" })).rejects.toThrow(/No file case\/PRINT.md.*design_case/);
    } finally {
      s.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function OPLIST(): string[] {
  return [...OPTIONAL];
}
