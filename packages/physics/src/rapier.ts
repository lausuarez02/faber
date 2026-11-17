// Rapier 2D (Apache-2.0, dimforge) loads a WebAssembly module. init() is async and runs once per
// process/page; everything after it is synchronous and deterministic: fixed timestep, no wall
// clock, same inputs in the same order → bit-identical results on the same build of Rapier.
import RAPIER from "@dimforge/rapier2d-compat";

let ready: Promise<typeof RAPIER> | undefined;
let loaded: typeof RAPIER | undefined;

/** Load the physics engine (WebAssembly). Await it once before attachPhysics()/RoverWorld. */
export function initPhysics(): Promise<typeof RAPIER> {
  ready ??= RAPIER.init().then(() => {
    loaded = RAPIER;
    return RAPIER;
  });
  return ready;
}

/** The loaded engine, or a clear error telling the caller to await initPhysics() first. */
export function rapier(): typeof RAPIER {
  if (!loaded) {
    throw new Error("physics engine not loaded: call `await initPhysics()` (from @faber/physics) once before creating a world. It loads Rapier's WebAssembly.");
  }
  return loaded;
}

export type Rapier = typeof RAPIER;
