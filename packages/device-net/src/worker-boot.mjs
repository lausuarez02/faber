// Starts the device network's worker thread (host-worker.ts) with the same TypeScript loader the
// CLI uses (tsx), so the worker runs the sources directly like the rest of Jumper.
import { register } from "tsx/esm/api";
register();
await import("./host-worker.ts");
