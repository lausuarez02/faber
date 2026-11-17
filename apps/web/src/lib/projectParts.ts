// Agent-made parts in the web app (decision 0003, C4): when the page shows a project served by
// `faber serve` (follow mode ?follow=ws://host/live, or ?local), fetch its parts/ folder from
// GET /api/project-parts, compile each part here (compileCustomPart sanitizes the SVG again; the
// browser never trusts the server's markup) and put them in the registry overlay (lib/parts.ts).
// Refetched when the project shows a type the registry does not know, or when an agent-made part
// is in the project and the project changed (update_part).
import { compileCustomPart, type CustomPart, type DisplayController } from "@faber/parts";
import type { PartDefinition } from "@faber/sim-core";
import type { Project } from "@faber/project-format";
import { registry, setProjectParts } from "./parts.ts";

export interface ProjectPartsPayload {
  /** `generated`: svg is the auto drawing (the browser makes its own); otherwise the agent's sanitized SVG. */
  parts: { id: string; part: CustomPart; svg: string; generated?: boolean }[];
}

const TFT_OF: Partial<Record<DisplayController, string>> = { st7735: "st7735-tft", ili9341: "ili9341-tft" };

/** Compile a GET /api/project-parts answer. Broken parts are skipped with a message. */
export function compilePayload(body: ProjectPartsPayload): { defs: PartDefinition[]; tftBase: Record<string, string>; errors: string[] } {
  const defs: PartDefinition[] = [];
  const tftBase: Record<string, string> = {};
  const errors: string[] = [];
  for (const p of body.parts ?? []) {
    try {
      const c = compileCustomPart(p.part, p.generated ? undefined : p.svg || undefined);
      defs.push(c.def);
      const b = c.part.behavior;
      if (b.kind === "display") {
        const tft = TFT_OF[b.controller] ?? (b.controller === "gc9a01" ? registry.base.list().find((d) => d.spec.id.startsWith("gc9a01"))?.spec.id : undefined);
        if (tft) tftBase[c.part.id] = tft;
      }
    } catch (e) {
      errors.push(`${p.id}: ${(e as Error).message}`);
    }
  }
  return { defs, tftBase, errors };
}

/** Base URL of the faber serve the page shows, or undefined when it shows a local example. */
export function servedBase(search: string, origin: string): string | undefined {
  const q = new URLSearchParams(search);
  const follow = q.get("follow");
  if (follow) {
    try {
      const u = new URL(follow);
      return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
    } catch {
      return undefined;
    }
  }
  if (q.has("local") && !q.get("example")) return origin;
  return undefined;
}

/** Types in the project the registry does not know. */
export function unknownTypes(project: Project): string[] {
  return [...new Set(project.parts.map((p) => p.type).filter((t) => !registry.get(t)))];
}

export interface ProjectPartsSync {
  /** Call when the project changed; fetches when needed. Resolves to true when the parts changed. */
  check(project: Project): Promise<boolean>;
}

/**
 * Keeps the overlay in step with the server. `onChange` runs after new definitions are in (re-render
 * the canvas); `onError` gets a readable message (what / why / fix).
 */
export function createProjectPartsSync(base: string, onChange: (types: Set<string>) => void, onError: (message: string) => void, fetchFn: typeof fetch = fetch): ProjectPartsSync {
  let lastBody = "";
  let inFlight: Promise<boolean> | undefined;
  let lastMissing = "";
  let again = false;
  const load = async (): Promise<boolean> => {
    let res: Response;
    try {
      res = await fetchFn(`${base}/api/project-parts`);
    } catch (e) {
      onError(`Could not load the project's agent-made parts. Why: ${(e as Error).message}. Fix: check that faber serve is still running, then reload the page.`);
      return false;
    }
    if (res.status === 404) return false; // an older faber serve without agent-made parts
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // keep the text
      }
      onError(msg);
      return false;
    }
    if (text === lastBody) return false;
    lastBody = text;
    const { defs, tftBase, errors } = compilePayload(JSON.parse(text) as ProjectPartsPayload);
    const before = new Set(registry.projectParts().map((d) => d.spec.id));
    setProjectParts(defs, tftBase);
    for (const e of errors) onError(`An agent-made part could not be drawn: ${e}`);
    onChange(new Set([...before, ...defs.map((d) => d.spec.id)]));
    return true;
  };
  return {
    check(project) {
      const missing = unknownTypes(project).join(",");
      const usesCustom = project.parts.some((p) => registry.projectParts().some((d) => d.spec.id === p.type));
      // Missing types: fetch once per distinct set (an unknown built-in type would loop otherwise).
      const want = (missing && missing !== lastMissing) || usesCustom || lastBody === "";
      lastMissing = missing;
      if (!want) return Promise.resolve(false);
      if (inFlight) {
        again = true; // the project changed while loading: load once more after this one
        return inFlight;
      }
      const run = (): Promise<boolean> =>
        load().then((changed) => {
          if (!again) return changed;
          again = false;
          return run().then((c2) => changed || c2);
        });
      inFlight = run().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
