import { BatteryMedium, Box, Cog, Cpu, Lightbulb, Monitor, Radio, ToggleLeft, Waves, Wifi, type LucideIcon } from "lucide-react";
import type { PartCategory } from "@fabwright/sim-core";

const BY_CATEGORY: Record<PartCategory, LucideIcon> = {
  board: Cpu,
  output: Lightbulb,
  input: ToggleLeft,
  passive: Waves,
  sensor: Radio,
  power: BatteryMedium,
  display: Monitor,
  motor: Cog,
  communication: Wifi,
  misc: Box,
};

/** The thin line icon shown next to a part's name (canvas labels, jump list). */
export function categoryIcon(c: PartCategory | undefined): LucideIcon {
  return (c && BY_CATEGORY[c]) || Box;
}
