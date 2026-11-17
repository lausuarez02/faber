import type { ComponentType } from "react";
import { useEffect } from "react";
import { engine, useFabwright } from "../lib/app.ts";
import { createProjectPartsSync, servedBase } from "../lib/projectParts.ts";

/**
 * Round 5, track "agentparts" (owner): keeps the open project's agent-made parts (parts/<id>/ on
 * the fabwright serve that the page follows) in the part registry, so they draw and simulate like
 * built-ins. Renders nothing.
 */
function ProjectPartsSync() {
  useEffect(() => {
    if (typeof location === "undefined") return;
    const base = servedBase(location.search, location.origin);
    if (!base) return;
    const sync = createProjectPartsSync(
      base,
      (types) => {
        const s = useFabwright.getState();
        // New part objects for the affected types so the canvas re-creates their nodes with the new definition.
        useFabwright.setState({ project: { ...s.project, parts: s.project.parts.map((p) => (types.has(p.type) ? { ...p } : p)) } });
        if (s.run !== "idle" && s.project.parts.some((p) => types.has(p.type))) engine.stop();
      },
      (message) => useFabwright.getState().toast({ kind: "error", title: "Agent-made part problem", detail: message }),
    );
    void sync.check(useFabwright.getState().project);
    return useFabwright.subscribe((s, prev) => {
      if (s.project !== prev.project) void sync.check(s.project);
    });
  }, []);
  return null;
}

export const agentpartsStage: ComponentType[] = [];
export const agentpartsChrome: ComponentType[] = [ProjectPartsSync];
