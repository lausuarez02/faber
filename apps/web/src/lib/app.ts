import { Engine } from "./engine.ts";
import { loadBlinkExample, loadExampleFirmware } from "./examples.ts";
import { createJumperStore, readTheme } from "./store.ts";

/** App singletons: the project store and the simulation engine. */
const initial = loadBlinkExample();

export const useJumper = createJumperStore(initial.project);
export const engine = new Engine(useJumper);
export const initialExample = initial;

useJumper.setState({ theme: readTheme() });

/** Look for the example's built firmware (tolerant: the hex may not be built yet). */
export async function loadInitialFirmware(): Promise<void> {
  const s = useJumper.getState();
  if (!s.project.firmware) {
    s.setFirmware({ status: "none" });
    return;
  }
  const fw = await loadExampleFirmware(initial.example, s.project);
  if (fw) useJumper.getState().setFirmware({ status: "ready", hex: fw.hex, name: fw.name, source: "example" });
  else
    useJumper.getState().setFirmware({
      status: "missing",
      reason: `examples/${initial.example}/${s.project.firmware.artifact} not found`,
    });
}

if (initial.issues) {
  queueMicrotask(() =>
    useJumper.getState().toast({
      kind: "error",
      title: "examples/blink/jumper.json is invalid; using the built-in Blink",
      detail: initial.issues!.join("\n"),
    }),
  );
}

// Handy in devtools and Playwright: window.jumper.engine.simulation.
if (typeof window !== "undefined") {
  (window as unknown as { jumper: unknown }).jumper = { store: useJumper, engine };
}
