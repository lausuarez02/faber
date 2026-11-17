import type { PartModelFactory } from "@faber/sim-core";
import { createBjtModel } from "../../lib/bjt.ts";

/** Typical hFE at a few tens of mA (datasheet: 2N2222A 100-300, BC547B 200-450) and ratings. */
export const NPN_MODELS = {
  "2N2222": { hfe: 150, maxmA: 600, maxV: 40 },
  BC547: { hfe: 290, maxmA: 100, maxV: 45 },
};

export const create: PartModelFactory = createBjtModel("npn", NPN_MODELS, "2N2222");
