/**
 * Lazy OpenCascade (replicad-opencascadejs, LGPL-2.1, unmodified wasm loaded at run time) and the
 * replicad wrapper (MIT). Only the case engine imports this, and only when it builds geometry, so
 * nothing else in Fabwright loads ~10 MB of wasm.
 */
import { createRequire } from "node:module";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Replicad = any;

let ready: Promise<Replicad> | undefined;

export function occt(): Promise<Replicad> {
  ready ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasm = require.resolve("replicad-opencascadejs/wasm");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("replicad-opencascadejs");
    const oc = await mod.default({ locateFile: () => wasm, print: () => {}, printErr: () => {} });
    const r = await import("replicad");
    r.setOC(oc);
    return r;
  })();
  return ready;
}
