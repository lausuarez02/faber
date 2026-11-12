import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MARKER, renderAgentsMd, renderSkillMd, SKILL_NAME, type RenderOptions } from "./render.ts";

export const SKILL_PATH = `.claude/skills/${SKILL_NAME}/SKILL.md`;
export const AGENTS_PATH = "AGENTS.md";

export interface AgentFile {
  /** Path relative to the project folder. */
  path: string;
  content: string;
}

export interface InstallResult {
  dir: string;
  files: { path: string; action: "written" | "updated" | "unchanged" | "kept"; why?: string }[];
}

/** The files a project gets so any agent opened in it knows Jumper's hardware loop. */
export function projectAgentFiles(o: RenderOptions & { projectName?: string }): AgentFile[] {
  return [
    { path: SKILL_PATH, content: renderSkillMd(o) },
    { path: AGENTS_PATH, content: renderAgentsMd(o, o.projectName) },
  ];
}

/**
 * Write the project-level agent files (never anything outside `dir`, never the person's global
 * config). A file Jumper wrote (it carries MARKER) is rewritten when the guide changed; a file
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
      if (!old.includes(MARKER) && !o.force) {
        files.push({ path: f.path, action: "kept", why: `${f.path} was not written by Jumper, so it was left as it is. Fix: add a line pointing to ${SKILL_PATH}, or run jumper skill install --project ${dir} --force to replace it.` });
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
  return { dir, files };
}
