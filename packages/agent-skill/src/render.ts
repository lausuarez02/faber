import { ASSEMBLY_CHECKLIST, BUILD_KIT_ANSWER, BUILD_KIT_PARTS, LOOP, PROMPTS, RULES, type LoopStep, type PromptName } from "./knowledge.ts";

export const SKILL_NAME = "jumper-hardware";
export const SKILL_DESCRIPTION =
  "Load this first, before any jumper tool call. Design and build a real hardware device with Jumper's tools (the jumper MCP server): plan it, pick the smallest parts that fit, think how every part goes inside (mounting, insertion order, wire room, USB and button access, battery safety), design the printable case, test the firmware, and answer what to buy, what to print and how to put it together. Use whenever the person wants a device, gadget, circuit, Arduino / ESP32 / Pico project, a case or 3D print, a parts list, or asks what they need to build something.";

/** The line that marks a file Jumper wrote (and may rewrite). Files without it are never overwritten. */
export const MARKER = "Written by Jumper (jumper skill install).";

export interface RenderOptions {
  /** Tool names the server really has (TOOLS.map(t => t.name)); steps that need a missing one use their fallback. */
  tools: readonly string[];
}

const pick = (s: LoopStep, tools: readonly string[]) => ((s.needs ?? []).every((n) => tools.includes(n)) || !s.fallback ? s.text() : s.fallback());

function loopMd(o: RenderOptions): string {
  return LOOP.map((s, i) => `${i + 1}. **${s.title}.** ${pick(s, o.tools)}`).join("\n");
}

function rulesMd(): string {
  return RULES.map((r) => `- ${r.text}`).join("\n");
}

function assemblyMd(): string {
  return ASSEMBLY_CHECKLIST.map((c) => `- **${c.title}.** ${c.text}`).join("\n");
}

function buildKitMd(o: RenderOptions): string {
  return [pick(BUILD_KIT_ANSWER, o.tools), "", ...BUILD_KIT_PARTS.map((p) => `- **${p.title}:** ${p.text}`), "", "Then one line on what was not tested (the print, the real fit, the hand feel, real battery life) and offer the pack for a supplier or a printer."].join("\n");
}

/** The guide body every long face shares (skill, AGENTS.md, the MCP resource). */
export function renderGuide(o: RenderOptions): string {
  return [
    "# Building a real device with Jumper",
    "",
    "Jumper is a hardware sandbox with a real simulator, reached through the `jumper` MCP tools (or the `jumper` CLI with the same operations). A person who wants a device wants to **hold it**: so from the first answer, think about what they will buy, what they will print and how they will put the stuff inside. Every error from Jumper says what failed, why and the fix: do what it says.",
    "",
    "## The loop",
    "",
    loopMd(o),
    "",
    "## Rules of thumb",
    "",
    rulesMd(),
    "",
    "## Always think how it goes inside",
    "",
    "Before the case exists, and again when the person asks how to build it:",
    "",
    assemblyMd(),
    "",
    "## What do I need to build it?",
    "",
    buildKitMd(o),
    "",
    "## Talking to the person",
    "",
    "- Many people are beginners: say \"the screen\", not \"SSD1306 over I2C\"; answer in their language.",
    "- Show pictures (renders, screenshots) and give links and file paths, not terminal commands, unless they asked for one.",
    "- Short answers: the plan, the trade-off to choose, then the result.",
    "",
  ].join("\n");
}

/** <project>/.claude/skills/jumper-hardware/SKILL.md (and the plugin's copy). */
export function renderSkillMd(o: RenderOptions): string {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    `description: ${JSON.stringify(SKILL_DESCRIPTION)}`,
    "---",
    "",
    `<!-- ${MARKER} Regenerate with: jumper skill install --project <dir>. A copy edited by hand is kept unless --force. -->`,
    "",
    renderGuide(o),
  ].join("\n");
}

/** <project>/AGENTS.md for Codex and other agents that read it. */
export function renderAgentsMd(o: RenderOptions, projectName?: string): string {
  return [
    `<!-- ${MARKER} Regenerate with: jumper skill install --project <dir>. -->`,
    "",
    `# AGENTS.md${projectName ? `: ${projectName}` : ""}`,
    "",
    "This folder is a Jumper project (jumper.json, firmware/, case/). Change it through the `jumper` MCP server (`jumper mcp --project .`, or the running Jumper app's /mcp) or the `jumper` CLI, never by editing jumper.json by hand. The same guide is in `.claude/skills/jumper-hardware/SKILL.md`.",
    "",
    renderGuide(o).replace(/^# .*\n/, ""),
  ].join("\n");
}

/**
 * <project>/CLAUDE.md: Claude Code loads it into every session in the folder, so the guide is always
 * in context (the skill is only loaded when the model chooses to). It imports AGENTS.md.
 */
export function renderClaudeMd(): string {
  return [
    `<!-- ${MARKER} Regenerate with: jumper skill install --project <dir>. -->`,
    "",
    "# Jumper project",
    "",
    `This folder is a Jumper hardware project: build it with the \`jumper\` MCP tools. Jumper's hardware guide is imported below (the same guide is the \`${SKILL_NAME}\` skill): from the first answer, think how the person will put the parts inside, what they will buy and what they will print.`,
    "",
    "@AGENTS.md",
    "",
  ].join("\n");
}

/** A few lines appended to the MCP server instructions (AGENT_LOOP): the rules in short, and where the rest is. */
export function renderInstructionsBlock(o: RenderOptions): string {
  const kit = (BUILD_KIT_ANSWER.needs ?? []).every((n) => o.tools.includes(n)) ? "get_build_kit" : "export_manufacturing (then read_file its BOM.md, PRINT.md, ASSEMBLY.md)";
  return [
    `Design for assembly (any device a person will hold): always think how the stuff goes inside, what they buy and what they print. If your client lists the ${SKILL_NAME} skill (Claude Code in a Jumper project), load it first.`,
    ...RULES.filter((r) => r.short).map((r) => `- ${r.short}`),
    `- Before design_case think how it goes together: what mounts where, the insertion order, wire room, USB / button / switch access, battery safety${o.tools.includes("get_assembly_plan") ? " (get_assembly_plan)" : ""}.`,
    `- "What do I need to build it?": ${kit}, then answer Buy / Print / Assemble / Flash with totals.`,
    `Hardware guide: resource jumper://docs/hardware; prompts ${PROMPTS.map((p) => p.name).join(", ")}.`,
  ].join("\n");
}

/** The text of an MCP prompt (prompts/get). */
export function renderPrompt(name: PromptName | string, args: Record<string, string | undefined>, o: RenderOptions): string {
  switch (name) {
    case "design-device": {
      const goal = (args.goal ?? "").trim();
      if (!goal) throw new Error('The design-device prompt needs a goal. Why: it starts the design from the person\'s wish. Fix: pass {"goal": "a keychain with a little screen that shows a smiley"}.');
      return [`I want to build: ${goal}`, "", "Design it as a real device I can hold, buy the parts for and print. Follow this loop and these rules:", "", loopMd(o), "", rulesMd(), "", "Always think how it goes inside:", "", assemblyMd(), "", "At the end tell me what I need to build it:", "", buildKitMd(o)].join("\n");
    }
    case "build-kit":
      return ["Tell me everything I need to build this device: what to buy, what to print, how to put it together and how to get the firmware on it, with totals.", "", buildKitMd(o)].join("\n");
    case "design-for-assembly":
      return [
        "Before printing anything, walk through how every part of this device goes inside, and fix the layout or the parts where it does not work.",
        "",
        `Start from ${o.tools.includes("get_assembly_plan") ? "get_assembly_plan and " : ""}propose_layout (placements and layers) or the saved case (get_case), then check each point:`,
        "",
        assemblyMd(),
        "",
        "Tell me the insertion order in a few numbered steps and what you changed.",
      ].join("\n");
    default:
      throw new Error(`No prompt '${name}'. Why: Jumper's prompts are ${PROMPTS.map((p) => p.name).join(", ")}. Fix: call prompts/get with one of those names.`);
  }
}
