/**
 * @jumper/enclosure: printable cases for Jumper projects (round 6, decision 0004).
 * This commit only fixes the shared types; the case track adds the engine (layout, shapes,
 * exporters, validation) behind them.
 */
export type { CaseFile, CaseMesh, CaseReport, FitCheck, FitCheckId, PlacedPart, Vec3 } from "./types.ts";
export { CASE_SHAPES } from "@jumper/project-format";

/** Smallest wall the engine generates for FDM (mm). */
export const MIN_WALL_MM = 1.2;
/** Default clearance between mating parts for FDM (mm). */
export const DEFAULT_TOLERANCE_MM = 0.2;
/** plan_device's pocket limit, reused for the "fits in a pocket" verdict (mm). */
export const POCKET_MM = { w: 110, h: 70, d: 30 } as const;
