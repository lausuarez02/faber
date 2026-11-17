// The painters live in @faber/physics (pure functions of a WorldSnapshot), so the headless
// screenshot in @faber/session draws the same picture as the web views.
export { drawWorld, drawArm, readPalette, fitArena } from "@faber/physics";
export type { Palette, Ctx2D, View } from "@faber/physics";
