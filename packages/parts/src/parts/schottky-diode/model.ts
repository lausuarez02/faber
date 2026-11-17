import type { PartModelFactory } from "@faber/sim-core";
import { createDiodeModel } from "../../lib/diode.ts";

/**
 * 1N5817 Schottky diode, piecewise linear: 0.25 V knee + 0.2 Ω → about 0.27 V at 100 mA and 0.45 V
 * at 1 A (datasheet typical 0.32 / 0.45 V). In a battery power path it blocks USB from feeding the cell.
 */
export const SCHOTTKY = { vf: 0.25, rOn: 0.2, rOff: 1e8 } as const;

export const create: PartModelFactory = createDiodeModel({ ...SCHOTTKY, what: "Schottky diode" });
