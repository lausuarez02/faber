import type { Project } from "@jumper/project-format";

/**
 * Round 6, switch track (decision 0004): someone new opening `jumper serve` lands on the Projects
 * page (the pitch and the cards), not on a canvas full of an agent's pending steps they did not ask
 * for. That happens on the server's own landing (its root redirects to ?follow=ws://<same host>/live)
 * when the active project is a fresh playground, or when this browser never opened a project.
 */

const KEY = "jumper.opened";

/** The person opened or created a project (or chose to stay on the canvas): no more landing on Projects. */
export function markOpened(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // private window: the landing shows again next time, which is harmless
  }
}

export function hasOpened(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** True on the page `jumper serve` redirects its root to: only ?follow, pointing at this very server's /live. */
export function isServerLanding(loc: { search: string; host: string } = typeof location !== "undefined" ? location : { search: "", host: "" }): boolean {
  const q = new URLSearchParams(loc.search);
  const keys = [...q.keys()];
  if (keys.length !== 1 || keys[0] !== "follow") return false;
  try {
    const u = new URL(q.get("follow")!);
    return u.host === loc.host && u.pathname.replace(/\/+$/, "") === "/live";
  } catch {
    return false;
  }
}

/** A playground nobody built anything in yet (`jumper serve`'s default folder). */
export function isFreshPlayground(project: Project, dir: string): boolean {
  const name = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return name === "playground" && project.parts.length === 0 && project.wires.length === 0;
}

/** Whether the first screen is the Projects page. */
export function landOnProjects(project: Project, dir: string, opened = hasOpened(), landing = isServerLanding()): boolean {
  if (!landing) return false;
  return isFreshPlayground(project, dir) || !opened;
}
