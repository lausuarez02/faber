import type { PartModelFactory } from "@faber/sim-core";
import { createBjtModel } from "../../lib/bjt.ts";

/** Typical hFE (datasheet: 2N2907A 100-300, BC557B 200-450) and ratings. */
export const PNP_MODELS = {
  "2N2907": { hfe: 150, maxmA: 600, maxV: 60 },
  BC557: { hfe: 290, maxmA: 100, maxV: 45 },
};

export const create: PartModelFactory = createBjtModel("pnp", PNP_MODELS, "2N2907");
