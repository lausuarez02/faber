// The painters live in @fabwright/physics (pure functions of a WorldSnapshot), so the headless
// screenshot in @fabwright/session draws the same picture as the web views.
export { drawWorld, drawArm, readPalette, fitArena } from "@fabwright/physics";
export type { Palette, Ctx2D, View } from "@fabwright/physics";
