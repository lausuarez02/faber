import { Engine } from "./engine.ts";
import { loadExample, loadExampleFirmware } from "./examples.ts";
import { safeParseProject } from "@fabwright/project-format";
import { createFabwrightStore, readTheme } from "./store.ts";

/** App singletons: the project store and the simulation engine. */
const requested = typeof location !== "undefined" ? new URLSearchParams(location.search).get("example") : null;
const initial = loadExample(requested || "blink");

export const useFabwright = createFabwrightStore(initial.project);
export const engine = new Engine(useFabwright);
export const initialExample = initial;

useFabwright.setState({ theme: readTheme() });

/** Look for the example's built firmware (tolerant: the hex may not be built yet). */
export async function loadInitialFirmware(): Promise<void> {
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("local") && !requested) {
    if (await loadServedProject()) return;
  }
  const s = useFabwright.getState();
  if (!s.project.firmware) {
    s.setFirmware({ status: "none" });
    return;
  }
  const fw = await loadExampleFirmware(initial.example, s.project);
  if (fw) useFabwright.getState().setFirmware({ status: "ready", hex: fw.hex, name: fw.name, source: "example" });
  else
    useFabwright.getState().setFirmware({
      status: "missing",
      reason: `examples/${initial.example}/${s.project.firmware.artifact} not found`,
    });
}

/**
 * `/?local` on a `fabwright serve` server: open the server's project (the one an agent is building)
 * with its built firmware, so it runs here: screen pixels, buttons, Device view. False when the
 * page is not served by `fabwright serve` (the usual Blink stays open).
 */
export async function loadServedProject(fetchFn: typeof fetch = fetch): Promise<boolean> {
  let res: Response;
  try {
    res = await fetchFn("/api/project");
  } catch {
    return false;
  }
  const body = (await res.json().catch(() => undefined)) as { project?: unknown; hex?: string; dir?: string; warning?: string; error?: string } | undefined;
  const s = useFabwright.getState();
  if (!res.ok || !body?.project) {
    if (body?.error) s.toast({ kind: "error", title: "Could not open the server's project", detail: body.error });
    return false;
  }
  const parsed = safeParseProject(JSON.stringify(body.project));
  if (!parsed.ok) {
    s.toast({ kind: "error", title: "The server's project is invalid", detail: parsed.issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("\n") + `\nFix: run \`fabwright check -p ${body.dir ?? "<project>"}\`.` });
    return false;
  }
  s.loadProject(parsed.project);
  if (body.hex) s.setFirmware({ status: "ready", hex: body.hex, name: parsed.project.firmware?.sketch ?? "firmware", source: "upload" });
  else if (parsed.project.firmware) s.setFirmware({ status: "missing", reason: body.warning ?? "the firmware is not built yet" });
  else s.setFirmware({ status: "none" });
  return true;
}

if (initial.issues) {
  queueMicrotask(() =>
    useFabwright.getState().toast({
      kind: "error",
      title: `Could not open example "${requested ?? "blink"}"; showing Blink`,
      detail: initial.issues!.join("\n"),
    }),
  );
}

// Handy in devtools and Playwright: window.fabwright.engine.simulation.
if (typeof window !== "undefined") {
  (window as unknown as { fabwright: unknown }).fabwright = { store: useFabwright, engine };
}
