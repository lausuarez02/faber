// The painters live in @jumper/physics (pure functions of a WorldSnapshot), so the headless
// screenshot in @jumper/session draws the same picture as the web views.
export { drawWorld, drawArm, readPalette, fitArena } from "@jumper/physics";
export type { Palette, Ctx2D, View } from "@jumper/physics";
