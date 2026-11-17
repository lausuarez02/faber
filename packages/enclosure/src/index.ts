/**
 * @fabwright/enclosure: printable cases for Fabwright projects (round 6, decision 0004).
 * layout (auto-pack) → OpenCascade bodies (replicad, loaded lazily) → STL / 3MF / STEP / PNG /
 * SVG drawing / PRINT.md + a CaseReport with fit checks.
 */
export type { CaseFile, CaseMesh, CaseReport, FitCheck, FitCheckId, PlacedPart, Vec3 } from "./types.ts";
export { CASE_SHAPES } from "@fabwright/project-format";
export { generateCase, layoutInput, frontOutline, caseHash, pocketVerdict, pocketText, resolveEnclosure, readManifest, readReport, readMeshCache, writeMeshCache, writeCaseFiles, ENGINE_VERSION, type Generated, type GenerateOptions, type CaseManifest } from "./engine.ts";
export { stackLayout, autoLayouts, resolveParams, toCase, specWithProps, LIPO_CELLS, type Layout, type LayoutFit, type LayoutOptions, type Placed, type Opening } from "./layout.ts";
export { parseOutline, presetPoints, presetOutline, svgPathToPolylines, catmullRomClosed, OutlineError, type ParsedOutline, type Pt } from "./outline.ts";
export { layoutCase, proposeLayouts, proposeWithLayouts, proposalsFor, goalOf, goalCost, layersOf, volumeOf, LAYOUT_GOALS, type LayoutGoal, type LayoutProposal, type LayoutProposals, type ProposalLayer, type ProposalPlacement, type ProposalViews, type ProposeOptions } from "./proposals.ts";
export { choiceCosts, choiceCostsAsync, choicesOf, mergeChanges, type ChoiceCost, type CostsReport, type CostSize, type CostOptions } from "./costs.ts";
export { checkFit, roleOf, type FitReport, type FitMiss, type FitSuggestion, type FitPreviewPart, type FitInput } from "./fit.ts";
export { resolveMech, type PartMech } from "./mech.ts";
export { checkMesh, readStl, stlBinary, weld, type Mesh, type MeshCheck } from "./mesh.ts";
export { renderPng } from "./render.ts";
export { windowSight, type WindowSight } from "./sight.ts";
export { assemblyPlan, firmwareUsesCard, pinPositionsOf, wiresKey, type AssemblyAction, type AssemblyCamera, type AssemblyCheck, type AssemblyInput, type AssemblyPlan, type AssemblyStep, type AssemblyWire } from "./assembly.ts";
export { renderAssemblySteps, barMesh } from "./assembly-render.ts";
export type { Mount, MountHow } from "./mounts.ts";

/** Smallest wall the engine generates for FDM (mm). */
export const MIN_WALL_MM = 1.2;
/** Default clearance between mating parts for FDM (mm). */
export const DEFAULT_TOLERANCE_MM = 0.2;
/** plan_device's pocket limit, reused for the "fits in a pocket" verdict (mm). */
export const POCKET_MM = { w: 110, h: 70, d: 30 } as const;
export { heldSpec, heldSize, heldFrom, heldProblems, measureText, isHeldMech, isHeldType, HELD_PREFIX, type HeldReport, type HeldSize } from "./held.ts";
