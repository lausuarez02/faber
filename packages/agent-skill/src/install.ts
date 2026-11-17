import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MARKER, renderAgentsMd, renderClaudeMd, renderSkillMd, SKILL_NAME, type RenderOptions } from "./render.ts";

export const SKILL_PATH = `.claude/skills/${SKILL_NAME}/SKILL.md`;
export const AGENTS_PATH = "AGENTS.md";
export const CLAUDE_PATH = "CLAUDE.md";
/** What these files said before the rename from Jumper: still ours to update. */
export const LEGACY_MARKER = "Written by Jumper (jumper skill install).";
/** The skill's path before the rename; removed when it is ours, so an agent does not load two guides. */
export const LEGACY_SKILL_PATH = ".claude/skills/jumper-hardware/SKILL.md";

export interface AgentFile {
  /** Path relative to the project folder. */
  path: string;
  content: string;
}

export interface InstallResult {
  dir: string;
  files: { path: string; action: "written" | "updated" | "unchanged" | "kept" | "removed"; why?: string }[];
}

/** The files a project gets so any agent opened in it knows Fabwright's hardware loop. */
export function projectAgentFiles(o: RenderOptions & { projectName?: string }): AgentFile[] {
  return [
    { path: SKILL_PATH, content: renderSkillMd(o) },
    { path: AGENTS_PATH, content: renderAgentsMd(o, o.projectName) },
    // Claude Code always loads a project's CLAUDE.md (a skill only when the model picks it): it imports AGENTS.md.
    { path: CLAUDE_PATH, content: renderClaudeMd() },
  ];
}

/**
 * Write the project-level agent files (never anything outside `dir`, never the person's global
 * config). A file Fabwright wrote (it carries MARKER) is rewritten when the guide changed; a file
 * someone else wrote is kept unless force (and the result says why and how to get ours).
 */
export function installProjectFiles(dir: string, o: RenderOptions & { projectName?: string; force?: boolean }): InstallResult {
  const files: InstallResult["files"] = [];
  for (const f of projectAgentFiles(o)) {
    const abs = join(dir, f.path);
    if (existsSync(abs)) {
      const old = readFileSync(abs, "utf8");
      if (old === f.content) {
        files.push({ path: f.path, action: "unchanged" });
        continue;
      }
      if (!old.includes(MARKER) && !old.includes(LEGACY_MARKER) && !o.force) {
        files.push({ path: f.path, action: "kept", why: `${f.path} was not written by Fabwright, so it was left as it is. Fix: add a line pointing to ${SKILL_PATH}, or run fabwright skill install --project ${dir} --force to replace it.` });
        continue;
      }
      writeFileSync(abs, f.content);
      files.push({ path: f.path, action: "updated" });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    files.push({ path: f.path, action: "written" });
  }
  const legacy = join(dir, LEGACY_SKILL_PATH);
  if (existsSync(legacy) && readFileSync(legacy, "utf8").includes(LEGACY_MARKER)) {
    rmSync(legacy);
    if (!readdirSync(dirname(legacy)).length) rmdirSync(dirname(legacy));
    files.push({ path: LEGACY_SKILL_PATH, action: "removed", why: `the same guide from before the rename to Fabwright; it is now ${SKILL_PATH}` });
  }
  return { dir, files };
}
